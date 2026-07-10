import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Docker from "dockerode";
import type { ContainerManager, ContainerCreateOptions } from "@vonzio/shared";
import { ContainerPool } from "./pool.js";
import { DockerManager } from "./docker-manager.js";
import { SessionRegistry } from "./session-registry.js";
import { WorkspaceProvisioner } from "./workspace.js";
import { schema, type DB } from "../db/index.js";
import { createTestDB } from "../db/test-utils.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// --- Mock ContainerManager ---

type MockEntry = {
  status: "running" | "exited";
  opts: ContainerCreateOptions;
  labels: Record<string, string>;
  createdAt: string;
};

function createMockManager(): ContainerManager & {
  containers: Map<string, MockEntry>;
  execOutputs: Map<string, string[]>;
  /** Inject a container straight into Docker (not via the pool) for sweep tests. */
  addExternal(id: string, opts?: { labels?: Record<string, string>; ageMs?: number; status?: "running" | "exited"; createdAt?: string }): void;
} {
  const containers = new Map<string, MockEntry>();
  const execOutputs = new Map<string, string[]>();
  let nextId = 1;

  return {
    containers,
    execOutputs,

    addExternal(id, opts = {}) {
      containers.set(id, {
        status: opts.status ?? "running",
        opts: { env: {} },
        labels: opts.labels ?? { "vonzio-mode": "session" },
        createdAt: opts.createdAt ?? new Date(Date.now() - (opts.ageMs ?? 0)).toISOString(),
      });
    },

    async createContainer(opts) {
      const id = `ctr_${nextId++}`;
      containers.set(id, { status: "created" as "running", opts, labels: opts.labels ?? {}, createdAt: new Date().toISOString() });
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

    async updateContainerMemory() {},
    async getContainerMemoryLimit() {
      return 0;
    },

    async *execInContainer(id, cmd) {
      const outputs = execOutputs.get(id) ?? [];
      for (const line of outputs) {
        yield line;
      }
    },

    async createTerminalSession() {
      return { write() {}, resize() {}, onData() {}, onExit() {}, close() {} };
    },

    async getContainerStatus(id) {
      const c = containers.get(id);
      if (!c) return "not_found";
      return c.status;
    },
    async getContainerExit() { return null; },

    async listManagedContainers() {
      return Array.from(containers.entries()).map(([id, c]) => ({
        id,
        status: c.status === "running" ? "running" as const : "exited" as const,
        labels: c.labels,
        created_at: c.createdAt,
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
    async copyToContainer() {},
    async listListeningPorts() { return []; },
    async pauseContainer() {},
    async unpauseContainer() {},
    async ensureNetwork() {},
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

// --- Orphan reaper / prune Tests ---

describe("ContainerPool orphan reaping", () => {
  const OLD = 20 * 60 * 1000; // older than ORPHAN_MIN_AGE_MS (15 min)
  const YOUNG = 60 * 1000;
  let manager: ReturnType<typeof createMockManager>;
  let pool: ContainerPool;

  // Lightweight stand-in for SessionRegistry — the pool only reads
  // containerSessionMap (in-memory map) and dbContainerIds() (DB-authoritative
  // keep-set). Stubbing keeps these tests DB-independent so they run in CI.
  function fakeRegistry(opts: { containerSessions?: Record<string, string>; dbIds?: string[]; dbThrows?: boolean } = {}) {
    return {
      get containerSessionMap() {
        return new Map(Object.entries(opts.containerSessions ?? {}));
      },
      async dbContainerIds() {
        if (opts.dbThrows) throw new Error("db down");
        return new Set(opts.dbIds ?? []);
      },
    } as unknown as SessionRegistry;
  }

  function makePool() {
    return new ContainerPool(
      manager,
      { minSize: 0, maxSize: 5, idleDrainSecs: 60, maxRecycles: 3, healthCheckIntervalSecs: 9999, cleanupCmd: ["true"] },
      () => ({ env: {}, labels: { "vonzio-mode": "pooled" } }),
    );
  }

  const sweep = (o: { reap: boolean }) =>
    (pool as unknown as { sweepOrphans(o: { reap: boolean }): Promise<void> }).sweepOrphans(o);

  beforeEach(() => {
    manager = createMockManager();
    pool = makePool();
  });

  it("pruneOrphans removes an old unowned session container", async () => {
    pool.setSessionRegistry(fakeRegistry());
    manager.addExternal("orphan_old", { labels: { "vonzio-mode": "session" }, ageMs: OLD });
    const removed = await pool.pruneOrphans();
    expect(removed).toEqual(["orphan_old"]);
    expect(manager.containers.has("orphan_old")).toBe(false);
  });

  it("pruneOrphans keeps young, DB-owned, and infra containers", async () => {
    pool.setSessionRegistry(fakeRegistry({ dbIds: ["owned_ctr"] }));
    manager.addExternal("owned_ctr", { ageMs: OLD });          // owned in DB
    manager.addExternal("young_orphan", { ageMs: YOUNG });     // too young
    manager.addExternal("sidecar", { labels: { "vonzio-mode": "vpn-sidecar" }, ageMs: OLD });
    manager.addExternal("egress", { labels: { "vonzio-mode": "egress-proxy" }, ageMs: OLD });

    const removed = await pool.pruneOrphans();
    expect(removed).toEqual([]);
    expect(manager.containers.size).toBe(4);
  });

  it("pruneOrphans treats an in-memory session container as owned", async () => {
    pool.setSessionRegistry(fakeRegistry({ containerSessions: { live_ctr: "sess_1" } }));
    manager.addExternal("live_ctr", { ageMs: OLD });
    const removed = await pool.pruneOrphans();
    expect(removed).toEqual([]);
  });

  it("pruneOrphans fails closed when the DB read errors", async () => {
    pool.setSessionRegistry(fakeRegistry({ dbThrows: true }));
    manager.addExternal("orphan_old", { ageMs: OLD });
    await expect(pool.pruneOrphans()).rejects.toThrow(/database unavailable/);
    expect(manager.containers.has("orphan_old")).toBe(true);
  });

  it("periodic sweep needs two strikes before reaping", async () => {
    pool.setSessionRegistry(fakeRegistry());
    manager.addExternal("orphan_old", { ageMs: OLD });
    // First sweep with reap:true but no prior candidate → not removed yet.
    await sweep({ reap: true });
    expect(manager.containers.has("orphan_old")).toBe(true);
    // Second sweep → confirmed, removed.
    await sweep({ reap: true });
    expect(manager.containers.has("orphan_old")).toBe(false);
  });

  it("seeding sweep (reap:false) never removes, even on a second pass", async () => {
    pool.setSessionRegistry(fakeRegistry());
    manager.addExternal("orphan_old", { ageMs: OLD });
    await sweep({ reap: false });
    await sweep({ reap: false });
    expect(manager.containers.has("orphan_old")).toBe(true);
  });

  it("periodic sweep never reaps a DB-owned container even across strikes", async () => {
    pool.setSessionRegistry(fakeRegistry({ dbIds: ["owned_ctr"] }));
    manager.addExternal("owned_ctr", { ageMs: OLD });
    await sweep({ reap: true });
    await sweep({ reap: true });
    expect(manager.containers.has("owned_ctr")).toBe(true);
  });

  it("never reaps when no session registry is wired (fail closed)", async () => {
    // pool has no setSessionRegistry call
    manager.addExternal("orphan_old", { ageMs: OLD });
    await sweep({ reap: true });
    await sweep({ reap: true });
    expect(manager.containers.has("orphan_old")).toBe(true);
    await expect(pool.pruneOrphans()).rejects.toThrow();
  });

  it("pruneOrphans reaps an orphan with an unparseable created_at (no permanent leak)", async () => {
    pool.setSessionRegistry(fakeRegistry());
    manager.addExternal("orphan_badts", { createdAt: "not-a-real-date" });
    const removed = await pool.pruneOrphans();
    expect(removed).toEqual(["orphan_badts"]);
  });

  it("periodic sweep never reaps a too-young orphan", async () => {
    pool.setSessionRegistry(fakeRegistry());
    manager.addExternal("young", { ageMs: YOUNG });
    await sweep({ reap: true });
    await sweep({ reap: true });
    expect(manager.containers.has("young")).toBe(true);
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

  it("SECURITY: refuses to write files outside the workspace (path traversal)", async () => {
    await expect(
      provisioner.provision({
        type: "files",
        files: [{ path: "../../../../tmp/vonzio-escape-test", content: "pwned" }],
      }),
    ).rejects.toThrow(/outside the workspace/);

    // Absolute paths are escapes too.
    await expect(
      provisioner.provision({
        type: "files",
        files: [{ path: "/tmp/vonzio-escape-abs", content: "pwned" }],
      }),
    ).rejects.toThrow(/outside the workspace/);
  });

  it("SECURITY: refuses non-http(s) git transports (ext::/file://)", async () => {
    await expect(
      provisioner.provision({ type: "git", git_url: "ext::sh -c 'touch /tmp/vonzio-rce'" }),
    ).rejects.toThrow(/http\(s\)/);

    await expect(
      provisioner.provision({ type: "git", git_url: "file:///etc/passwd" }),
    ).rejects.toThrow(/http\(s\)/);
  });

  it("SECURITY: refuses a git_ref that could be parsed as an option", async () => {
    await expect(
      provisioner.provision({
        type: "git",
        git_url: "https://example.com/repo.git",
        git_ref: "--upload-pack=touch /tmp/vonzio-rce",
      }),
    ).rejects.toThrow(/git_ref/);
  });
});

describe("DockerManager createContainer HostConfig (feature 0001)", () => {
  function mockDocker() {
    const created: Array<Record<string, any>> = [];
    const docker = {
      createContainer: vi.fn(async (cfg: Record<string, any>) => {
        created.push(cfg);
        return { id: "ctr_test" };
      }),
    } as unknown as Docker;
    return { docker, created };
  }

  it("hardens ordinary containers: no-new-privileges, no runtime/privileged", async () => {
    const { docker, created } = mockDocker();
    await new DockerManager(docker, "img", undefined, 512).createContainer({ env: {} });
    expect(created[0].HostConfig.SecurityOpt).toEqual(["no-new-privileges"]);
    expect(created[0].HostConfig.Runtime).toBeUndefined();
    expect(created[0].HostConfig.Privileged).toBeUndefined();
    expect(created[0].HostConfig.PidsLimit).toBe(512);
  });

  it("applies the sysbox runtime while keeping no-new-privileges (unset securityOpt)", async () => {
    const { docker, created } = mockDocker();
    await new DockerManager(docker, "img").createContainer({
      env: {},
      runtime: "sysbox-runc",
    });
    expect(created[0].HostConfig.Runtime).toBe("sysbox-runc");
    expect(created[0].HostConfig.SecurityOpt).toEqual(["no-new-privileges"]);
  });

  it("applies Privileged and drops no-new-privileges for the dind-privileged mode", async () => {
    const { docker, created } = mockDocker();
    await new DockerManager(docker, "img").createContainer({
      env: {},
      privileged: true,
      securityOpt: [],
    });
    expect(created[0].HostConfig.Privileged).toBe(true);
    expect(created[0].HostConfig.SecurityOpt).toEqual([]);
  });

  it("per-container pidsLimit overrides the manager default", async () => {
    const { docker, created } = mockDocker();
    await new DockerManager(docker, "img", undefined, 512).createContainer({
      env: {},
      pidsLimit: 4096,
    });
    expect(created[0].HostConfig.PidsLimit).toBe(4096);
  });
});
