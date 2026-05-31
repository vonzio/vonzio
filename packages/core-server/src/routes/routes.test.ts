import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import bcrypt from "bcrypt";
import { schema, type DB } from "../db/index.js";
import { createTestDB } from "../db/test-utils.js";
import { userAuthHook } from "../auth/user-auth.js";
import { DefaultTokenValidator } from "../lib/defaults/token-validator.js";
import { InMemoryTaskQueue } from "../queue/in-memory.js";
import { ConcurrencyLimiter } from "../rate-limit/concurrency-limiter.js";
import { ContainerPool } from "../container/pool.js";
import { SessionRegistry } from "../container/session-registry.js";
import { WorkspaceProvisioner } from "../container/workspace.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { SessionPresenceRegistry } from "../lib/session-presence.js";
import { TaskService } from "../services/task-service.js";
import { WorkspaceService } from "../services/workspace-service.js";
import { ProfileService } from "../services/profile-service.js";
import { ApiKeyService } from "../services/api-key-service.js";
import { ModelListService } from "../services/model-list-service.js";
import { ToolFileService } from "../services/tool-file-service.js";
import { SkillService } from "../services/skill-service.js";
import { SubagentService } from "../services/subagent-service.js";
import { GitProviderService } from "../services/git-provider-service.js";
import { MemoryService } from "../services/memory-service.js";
import { taskRoutes } from "./tasks.js";
import { workspaceRoutes } from "./workspaces.js";
import { profileRoutes } from "./profiles.js";
import { poolRoutes } from "./pool.js";
import { memoryRoutes } from "./memories.js";
import type { ContainerManager } from "@vonzio/shared";

const ENCRYPTION_KEY = "a]3Kf9$mPqR7vXw2LnB5tYhJ8cDgE0sU";
const TEST_TOKEN = "rc_test_key_12345";

// Minimal mock of Better Auth — always returns no session so API token path is used
const mockAuth = {
  api: {
    getSession: async () => null,
  },
} as any;

function createMockManager(): ContainerManager {
  let nextId = 1;
  const containers = new Map<string, string>();
  return {
    async createContainer() {
      const id = `ctr_${nextId++}`;
      containers.set(id, "created");
      return id;
    },
    async startContainer(id) { containers.set(id, "running"); },
    async stopContainer(id) { containers.set(id, "exited"); },
    async removeContainer(id) { containers.delete(id); },
    async *execInContainer(id, cmd, stdin) {
      if (cmd.includes("node")) {
        yield JSON.stringify({ type: "init", session_id: "sess_auto" });
        yield JSON.stringify({
          type: "result",
          session_id: "sess_auto",
          result: { text: "Done", input_tokens: 10, output_tokens: 5, cost_usd: 0.01, turns: 1 },
        });
        yield JSON.stringify({ type: "exit", code: 0 });
      }
    },
    async getContainerStatus(id) { return containers.has(id) ? "running" : "not_found"; },
    async listManagedContainers() { return []; },
    async getContainerIp() { return "172.17.0.2"; },
    async getContainerName() { return "testcontainer"; },
    async resolveContainerId() { return null; },
    async readFile() { return Buffer.from(""); },
    async pauseContainer() {},
    async unpauseContainer() {},
    async createNamedVolume() {},
    async removeNamedVolume() {},
    async listImages() { return []; },
  };
}

describe("REST API Routes", () => {
  let handle: DB;
  let app: FastifyInstance;
  let pool: ContainerPool;
  let orchestrator: Orchestrator;
  let tokenHash: string;
  let seededProfileId: string;

  beforeAll(async () => {
    tokenHash = await bcrypt.hash(TEST_TOKEN, 10);
  });

  beforeEach(async () => {
    handle = await createTestDB();
    // Create an API key and profile for testing (using services to handle encryption)
    const apiKeyService = new ApiKeyService(handle.db, ENCRYPTION_KEY);
    const testKey = await apiKeyService.create({
      name: "test-key",
      provider: "api_key",
      api_key: "sk-ant-test-key",
    }, "user_test");

    const profileServiceForSeed = new ProfileService(handle.db, ENCRYPTION_KEY, apiKeyService);
    const seededProfile = await profileServiceForSeed.create({
      name: "test-prof",
      api_key_id: testKey.id,
    }, "user_test");
    seededProfileId = seededProfile.id;

    // Seed API token that grants access to the test profile
    await handle.db
      .insert(schema.apiTokens)
      .values({
        id: "key_001",
        name: "test-key",
        key_hash: tokenHash,
        user_id: "user_test",
        allowed_profile_ids: [seededProfileId],
        rate_limit_rpm: 60,
        created_at: new Date().toISOString(),
      });

    const manager = createMockManager();
    const queue = new InMemoryTaskQueue();
    const limiter = new ConcurrencyLimiter(4);

    pool = new ContainerPool(
      manager,
      {
        minSize: 1,
        maxSize: 5,
        idleDrainSecs: 60,
        maxRecycles: 50,
        healthCheckIntervalSecs: 9999,
        cleanupCmd: ["sh", "-c", "rm -rf /workspace/*"],
      },
      () => ({ env: { ANTHROPIC_API_KEY: "test" } }),
    );
    await pool.init();

    const sessionRegistry = new SessionRegistry(
      { idleTtlSecs: 1800, maxLifetimeSecs: 86400, workstationIdlePauseSecs: 1800, workstationMaxLifetimeSecs: 604800, maxPaused: 10, volumeTtlDays: 7 },
      { onIdleExpiry: vi.fn(), onIdlePause: vi.fn(), onExpired: vi.fn() },
      handle.db,
    );

    const profileService = new ProfileService(handle.db, ENCRYPTION_KEY, apiKeyService);

    const sessionPresence = new SessionPresenceRegistry();
    orchestrator = new Orchestrator({
      queue,
      containerManager: manager,
      pool,
      sessionRegistry,
      workspace: new WorkspaceProvisioner(),
      concurrencyLimiter: limiter,
      profileService,
      toolFileService: new ToolFileService(handle.db, "/tmp/vonzio-test-tools"),
      skillService: new SkillService(handle.db, "/tmp/vonzio-test-skills"),
      subagentService: new SubagentService(handle.db),
      gitProviderService: new GitProviderService(handle.db, ENCRYPTION_KEY),
      sessionPresence,
      db: handle.db,
      config: {
        taskTimeoutSeconds: 300,
        maxTurns: 30,
        agentImage: "vonzio-agent:latest",
        containerCpuBatch: 1,
        containerCpuSession: 0.5,
        containerMemoryBatch: "1g",
        containerMemorySession: "768m",
        previewUrlTemplate: "http://localhost:3000/preview/{container_id}/{port}/",
      },
    });
    orchestrator.start();

    const taskService = new TaskService(handle.db, queue, orchestrator);
    const workspaceService = new WorkspaceService(handle.db, sessionRegistry, manager, sessionPresence);

    const memoryService = new MemoryService(handle.db);
    const modelListService = new ModelListService(profileService, apiKeyService);

    app = Fastify({ logger: false });
    const hook = userAuthHook(mockAuth, new DefaultTokenValidator(handle.db));
    app.register(async (scoped) => {
      scoped.addHook("onRequest", hook);
      scoped.register(taskRoutes, { taskService, profileService });
      scoped.register(workspaceRoutes, { workspaceService });
      scoped.register(profileRoutes, { profileService, apiKeyService, modelListService });
      scoped.register(poolRoutes, { pool, sessionRegistry, containerManager: manager });
      scoped.register(memoryRoutes, { memoryService });
    });
    app.get("/health", async () => ({ status: "ok" }));
  });

  afterEach(async () => {
    await orchestrator.stop();
    await pool.shutdown();
    await app.close();
    await handle.close();
  });

  const auth = { authorization: `Bearer ${TEST_TOKEN}` };

  // --- Task Routes ---

  it("POST /v1/tasks returns 201 with valid key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: auth,
      payload: {
        prompt: "Review this code",
        profile_id: seededProfileId,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.task_id).toMatch(/^task_/);
    expect(body.status).toBe("queued");
    expect(body.created_at).toBeTruthy();
  });

  it("POST /v1/tasks returns 400 for invalid body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: auth,
      payload: { profile_id: seededProfileId }, // missing prompt
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Validation failed");
    expect(res.json().details).toBeTruthy();
  });

  it("POST /v1/tasks returns 400 for empty prompt", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: auth,
      payload: { prompt: "", profile_id: seededProfileId },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /v1/profiles returns 400 for invalid body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/profiles",
      headers: auth,
      payload: { default_tools: "not-an-array" }, // missing name, bad type
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /v1/tasks returns 401 without auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      payload: { prompt: "test", profile_id: seededProfileId },
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /v1/tasks/:id returns task", async () => {
    // Submit a task first
    const submitRes = await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: auth,
      payload: { prompt: "test", profile_id: seededProfileId },
    });
    const { task_id } = submitRes.json();

    const res = await app.inject({
      method: "GET",
      url: `/v1/tasks/${task_id}`,
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(task_id);
  });

  it("GET /v1/tasks/:id returns 404 for non-existent", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/tasks/task_nonexistent",
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /v1/tasks returns paginated list", async () => {
    // Submit two tasks
    await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: auth,
      payload: { prompt: "task1", profile_id: seededProfileId },
    });
    await app.inject({
      method: "POST",
      url: "/v1/tasks",
      headers: auth,
      payload: { prompt: "task2", profile_id: seededProfileId },
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/tasks?limit=10",
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tasks.length).toBeGreaterThanOrEqual(2);
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  // --- Profile Routes ---

  it("POST /v1/profiles creates and returns profile", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/profiles",
      headers: auth,
      payload: {
        name: "new-profile",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^prof_/);
    expect(body.name).toBe("new-profile");
  });

  it("GET /v1/profiles returns list", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/profiles",
      headers: auth,
      payload: { name: "list-test" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/profiles",
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    const profiles = res.json();
    expect(Array.isArray(profiles)).toBe(true);
    const created = profiles.find((c: { name: string }) => c.name === "list-test");
    expect(created).toBeTruthy();
  });

  it("DELETE /v1/profiles/:id deletes profile", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/profiles",
      headers: auth,
      payload: { name: "del-test" },
    });
    const { id } = createRes.json();

    const res = await app.inject({
      method: "DELETE",
      url: `/v1/profiles/${id}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("deleted");
  });

  // --- Pool Routes ---

  it("GET /v1/pool returns 403 for non-admin users", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/pool",
      headers: auth,
    });

    // Pool routes require admin — API token users are not admin
    expect(res.statusCode).toBe(403);
  });

  // --- Workspace Routes ---

  it("GET /v1/workspaces returns empty list initially", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().workspaces).toEqual([]);
  });

  it("GET /v1/workspaces/:id returns 404 for non-existent", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/workspaces/sess_nonexistent",
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  // --- Health (no auth) ---

  it("GET /health works without auth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  // --- Memory Routes ---

  describe("Memory Routes", () => {
    // POST /v1/memories — create
    it("creates a memory", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/memories",
        headers: auth,
        payload: { name: "test memory", type: "user", body: "User prefers dark mode" },
      });
      expect(res.statusCode).toBe(201);
      const mem = res.json();
      expect(mem.id).toMatch(/^mem_/);
      expect(mem.name).toBe("test memory");
      expect(mem.type).toBe("user");
    });

    // POST /v1/memories — validation error
    it("rejects invalid memory type", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/memories",
        headers: auth,
        payload: { name: "test", type: "invalid_type", body: "content" },
      });
      expect(res.statusCode).toBe(400);
    });

    // GET /v1/memories — list
    it("lists memories for the user", async () => {
      // Create 2 memories first
      await app.inject({ method: "POST", url: "/v1/memories", headers: auth, payload: { name: "m1", type: "user", body: "b1" } });
      await app.inject({ method: "POST", url: "/v1/memories", headers: auth, payload: { name: "m2", type: "feedback", body: "b2" } });

      const res = await app.inject({ method: "GET", url: "/v1/memories", headers: auth });
      expect(res.statusCode).toBe(200);
      const memories = res.json();
      expect(memories.length).toBeGreaterThanOrEqual(2);
    });

    // GET /v1/memories/:id
    it("gets a single memory", async () => {
      const createRes = await app.inject({ method: "POST", url: "/v1/memories", headers: auth, payload: { name: "single", type: "project", body: "details" } });
      const created = createRes.json();

      const res = await app.inject({ method: "GET", url: `/v1/memories/${created.id}`, headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe("single");
    });

    // GET /v1/memories/:id — 404
    it("returns 404 for non-existent memory", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/memories/mem_nonexistent", headers: auth });
      expect(res.statusCode).toBe(404);
    });

    // PATCH /v1/memories/:id
    it("updates a memory", async () => {
      const createRes = await app.inject({ method: "POST", url: "/v1/memories", headers: auth, payload: { name: "original", type: "user", body: "old body" } });
      const created = createRes.json();

      const res = await app.inject({ method: "PATCH", url: `/v1/memories/${created.id}`, headers: auth, payload: { body: "new body" } });
      expect(res.statusCode).toBe(200);
      expect(res.json().body).toBe("new body");
    });

    // DELETE /v1/memories/:id
    it("deletes a memory", async () => {
      const createRes = await app.inject({ method: "POST", url: "/v1/memories", headers: auth, payload: { name: "deleteme", type: "reference", body: "content" } });
      const created = createRes.json();

      const res = await app.inject({ method: "DELETE", url: `/v1/memories/${created.id}`, headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json().deleted).toBe(true);

      // Verify it's gone
      const getRes = await app.inject({ method: "GET", url: `/v1/memories/${created.id}`, headers: auth });
      expect(getRes.statusCode).toBe(404);
    });

    // DELETE /v1/memories — bulk
    it("bulk deletes memories by type", async () => {
      await app.inject({ method: "POST", url: "/v1/memories", headers: auth, payload: { name: "fb1", type: "feedback", body: "a" } });
      await app.inject({ method: "POST", url: "/v1/memories", headers: auth, payload: { name: "fb2", type: "feedback", body: "b" } });

      const res = await app.inject({ method: "DELETE", url: "/v1/memories?type=feedback", headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json().deleted).toBeGreaterThanOrEqual(2);
    });
  });
});
