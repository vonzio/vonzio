import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ContainerManager, ContainerCreateOptions } from "@vonzio/shared";
import { ContainerPool } from "./pool.js";
import { SessionRegistry } from "./session-registry.js";
import { WorkspaceProvisioner } from "./workspace.js";
import { schema, type DB } from "../db/index.js";
import { createTestDB } from "../db/test-utils.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// --- Mock ContainerManager ---

function createMockManager(): ContainerManager & {
  containers: Map<string, { status: "running" | "exited"; opts: ContainerCreateOptions }>;
  execOutputs: Map<string, string[]>;
} {
  const containers = new Map<string, { status: "running" | "exited"; opts: ContainerCreateOptions }>();
  const execOutputs = new Map<string, string[]>();
  let nextId = 1;

  return {
    containers,
    execOutputs,

    async createContainer(opts) {
      const id = `ctr_${nextId++}`;
      containers.set(id, { status: "created" as "running", opts });
      return id;
    },

    async startContainer(id) {
      const c = containers.get(id);
      if (c) c.status = "running";
    },

    async stopContainer(id) {
      const c = containers.get(id);
      if (c) c.status = "exited";
    },

    async removeContainer(id) {
      containers.delete(id);
    },

    async *execInContainer(id, cmd) {
      const outputs = execOutputs.get(id) ?? [];
      for (const line of outputs) {
        yield line;
      }
    },

    async getContainerStatus(id) {
      const c = containers.get(id);
      if (!c) return "not_found";
      return c.status;
    },

    async listManagedContainers() {
      return Array.from(containers.entries()).map(([id, c]) => ({
        id,
        status: c.status === "running" ? "running" as const : "exited" as const,
        labels: {},
        created_at: new Date().toISOString(),
      }));
    },
    async getContainerIp() { return "172.17.0.2"; },
    async getContainerName() { return "testcontainer"; },
    async resolveContainerId(shortId: string) {
      for (const id of containers.keys()) {
        if (id.startsWith(shortId)) return id;
      }
      return null;
    },
    async readFile() { return Buffer.from(""); },
    async pauseContainer() {},
    async unpauseContainer() {},
    async createNamedVolume() {},
    async removeNamedVolume() {},
    async listImages() { return []; },
  };
}

// --- ContainerPool Tests ---

describe("ContainerPool", () => {
  let manager: ReturnType<typeof createMockManager>;
  let pool: ContainerPool;

  function makePool(overrides: { minSize?: number; maxSize?: number } = {}) {
    return new ContainerPool(
      manager,
      {
        minSize: overrides.minSize ?? 2,
        maxSize: overrides.maxSize ?? 5,
        idleDrainSecs: 60,
        maxRecycles: 3,
        healthCheckIntervalSecs: 9999,
        cleanupCmd: ["sh", "-c", "rm -rf /workspace/*"],
      },
      () => ({
        env: { ANTHROPIC_API_KEY: "test" },
        labels: { "vonzio-mode": "pooled" },
      }),
    );
  }

  beforeEach(() => {
    manager = createMockManager();
  });

  it("init creates minSize containers", async () => {
    pool = makePool({ minSize: 3 });
    await pool.init();

    expect(pool.totalCount).toBe(3);
    expect(pool.idleCount).toBe(3);
    expect(pool.busyCount).toBe(0);
    await pool.shutdown();
  });

  it("claim returns an idle container and marks it busy", async () => {
    pool = makePool({ minSize: 2 });
    await pool.init();

    const id = await pool.claim();
    expect(id).toBeTruthy();
    expect(pool.idleCount).toBe(1);
    expect(pool.busyCount).toBe(1);
    await pool.shutdown();
  });

  it("claim creates new container if none idle and below max", async () => {
    pool = makePool({ minSize: 1, maxSize: 3 });
    await pool.init();

    const id1 = await pool.claim();
    const id2 = await pool.claim(); // Creates a new one

    expect(pool.totalCount).toBe(2);
    expect(pool.busyCount).toBe(2);
    await pool.shutdown();
  });

  it("claim throws when at max capacity", async () => {
    pool = makePool({ minSize: 1, maxSize: 1 });
    await pool.init();

    await pool.claim(); // Uses the one idle container
    await expect(pool.claim()).rejects.toThrow("Pool exhausted");
    await pool.shutdown();
  });

  it("release runs cleanup and returns container to idle", async () => {
    pool = makePool({ minSize: 1 });
    await pool.init();

    const id = await pool.claim();
    expect(pool.busyCount).toBe(1);

    await pool.release(id);
    expect(pool.idleCount).toBe(1);
    expect(pool.busyCount).toBe(0);
    await pool.shutdown();
  });

  it("release destroys and replaces container at max recycles", async () => {
    pool = makePool({ minSize: 1 }); // maxRecycles = 3
    await pool.init();

    const id = await pool.claim();

    // Recycle 3 times
    await pool.release(id);
    const id2 = await pool.claim();
    await pool.release(id2);
    const id3 = await pool.claim();
    await pool.release(id3); // 3rd recycle → destroy + replace

    // The original container should be gone, replaced with a new one
    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(1);
    await pool.shutdown();
  });

  it("shutdown destroys all containers", async () => {
    pool = makePool({ minSize: 3 });
    await pool.init();

    await pool.shutdown();
    expect(pool.totalCount).toBe(0);
    expect(manager.containers.size).toBe(0);
  });
});

// --- SessionRegistry Tests ---

const defaultRegistryConfig = {
  idleTtlSecs: 1800,
  maxLifetimeSecs: 86400,
  workstationIdlePauseSecs: 1800,
  workstationMaxLifetimeSecs: 604800,
  maxPaused: 10,
  volumeTtlDays: 7,
};

const defaultCallbacks = () => ({
  onIdleExpiry: vi.fn(),
  onIdlePause: vi.fn(),
  onExpired: vi.fn(),
});

function makeRegistry(handle: DB) {
  return new SessionRegistry(
    defaultRegistryConfig,
    defaultCallbacks(),
    handle.db,
  );
}

describe("SessionRegistry", () => {
  let handle: DB;

  beforeEach(async () => {
    handle = await createTestDB();
  });

  afterEach(async () => {
    await handle.close();
  });

  it("registers and retrieves a session", async () => {
    const registry = makeRegistry(handle);

    const session = await registry.register("sess_1", "ctr_1", "user_1", "prof_1");
    expect(session.session_id).toBe("sess_1");
    expect(session.status).toBe("active");

    const fetched = registry.get("sess_1");
    expect(fetched).not.toBeNull();
    expect(fetched!.container_id).toBe("ctr_1");
  });

  it("returns null for non-existent session", () => {
    const registry = makeRegistry(handle);
    expect(registry.get("nonexistent")).toBeNull();
  });

  it("looks up session by container ID", async () => {
    const registry = makeRegistry(handle);

    await registry.register("sess_1", "ctr_abc", "user_1", "prof_1");
    const found = registry.getByContainer("ctr_abc");
    expect(found).not.toBeNull();
    expect(found!.session_id).toBe("sess_1");
  });

  it("updates activity and status", async () => {
    const registry = makeRegistry(handle);

    await registry.register("sess_1", "ctr_1", "user_1", "prof_1");
    await registry.setStatus("sess_1", "idle");
    expect(registry.get("sess_1")!.status).toBe("idle");

    await registry.updateActivity("sess_1");
    expect(registry.get("sess_1")!.status).toBe("active");
  });

  it("marks session as resumable (nulls container_id)", async () => {
    const registry = makeRegistry(handle);

    await registry.register("sess_1", "ctr_1", "user_1", "prof_1");
    await registry.setStatus("sess_1", "resumable");

    const session = registry.get("sess_1")!;
    expect(session.status).toBe("resumable");
    expect(session.container_id).toBeNull();
  });

  it("tracks active count", async () => {
    const registry = makeRegistry(handle);

    await registry.register("sess_1", "ctr_1", "user_1", "prof_1");
    await registry.register("sess_2", "ctr_2", "user_2", "prof_1");
    expect(registry.activeCount).toBe(2);

    await registry.setStatus("sess_1", "resumable");
    expect(registry.activeCount).toBe(1);
  });

  it("removes a session", async () => {
    const registry = makeRegistry(handle);

    await registry.register("sess_1", "ctr_1", "user_1", "prof_1");
    expect(await registry.remove("sess_1")).toBe(true);
    expect(registry.get("sess_1")).toBeNull();
    expect(await registry.remove("sess_1")).toBe(false);
  });

  it("writes session to DB on register", async () => {
    const registry = makeRegistry(handle);

    await registry.register("sess_db", "ctr_1", "user_1", "prof_1", true);

    const rows = await handle.db
      .select()
      .from(schema.workspaces);
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe("sess_db");
    expect(rows[0].persistent).toBe(true);
    expect(rows[0].status).toBe("active");
  });

  it("updates DB on setStatus", async () => {
    const registry = makeRegistry(handle);

    await registry.register("sess_1", "ctr_1", "user_1", "prof_1");
    await registry.setStatus("sess_1", "paused");

    const rows = await handle.db.select().from(schema.workspaces);
    expect(rows[0].status).toBe("paused");
  });

  it("updates DB on updateActivity", async () => {
    const registry = makeRegistry(handle);

    await registry.register("sess_1", "ctr_1", "user_1", "prof_1");
    const before = registry.get("sess_1")!.last_active_at;

    // Small delay to ensure timestamp differs
    await registry.updateActivity("sess_1");

    const rows = await handle.db.select().from(schema.workspaces);
    expect(rows[0].status).toBe("active");
  });

  it("registers persistent session", async () => {
    const registry = makeRegistry(handle);

    const session = await registry.register("sess_p", "ctr_1", "user_1", "prof_1", true);
    expect(session.persistent).toBe(true);
  });

  it("tracks paused count", async () => {
    const registry = makeRegistry(handle);

    await registry.register("sess_1", "ctr_1", "user_1", "prof_1", true);
    await registry.register("sess_2", "ctr_2", "user_2", "prof_1", true);
    expect(registry.pausedCount).toBe(0);

    await registry.setStatus("sess_1", "paused");
    expect(registry.pausedCount).toBe(1);

    await registry.setStatus("sess_2", "paused");
    expect(registry.pausedCount).toBe(2);
  });

  it("loads sessions from DB on startup", async () => {
    const registry = makeRegistry(handle);
    const mockManager = createMockManager();

    // Create a container first
    const cId = await mockManager.createContainer({ env: {} });
    await mockManager.startContainer(cId);

    await registry.register("sess_reload", cId, "user_1", "prof_1", true);
    await registry.setStatus("sess_reload", "paused");

    // New registry that loads from DB
    const registry2 = makeRegistry(handle);
    await registry2.loadFromDB(mockManager);

    const loaded = registry2.get("sess_reload");
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe("paused");
    expect(loaded!.persistent).toBe(true);
  });

  it("marks orphaned sessions as resumable on loadFromDB", async () => {
    const registry = makeRegistry(handle);
    const mockManager = createMockManager();

    await registry.register("sess_orphan", "nonexistent_ctr", "user_1", "prof_1");

    const registry2 = makeRegistry(handle);
    await registry2.loadFromDB(mockManager);

    const loaded = registry2.get("sess_orphan");
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe("resumable");
    expect(loaded!.container_id).toBeNull();
    const rows = await handle.db.select().from(schema.workspaces);
    expect(rows[0].status).toBe("resumable");
  });
});

// --- WorkspaceProvisioner Tests ---

describe("WorkspaceProvisioner", () => {
  const provisioner = new WorkspaceProvisioner();

  it("provisions files to a temp directory", async () => {
    const dir = await provisioner.provision({
      type: "files",
      files: [
        { path: "src/main.ts", content: "console.log('hello')" },
        { path: "README.md", content: "# Test" },
      ],
    });

    const mainContent = await readFile(join(dir, "src/main.ts"), "utf8");
    expect(mainContent).toBe("console.log('hello')");

    const readmeContent = await readFile(join(dir, "README.md"), "utf8");
    expect(readmeContent).toBe("# Test");

    await provisioner.cleanup(dir);
  });

  it("cleans up temp directory", async () => {
    const dir = await provisioner.provision({
      type: "files",
      files: [{ path: "test.txt", content: "data" }],
    });

    await provisioner.cleanup(dir);

    // Verify directory is gone
    const { access } = await import("node:fs/promises");
    await expect(access(dir)).rejects.toThrow();
  });
});
