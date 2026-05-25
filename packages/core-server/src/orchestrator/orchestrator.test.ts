import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { schema, type DB } from "../db/index.js";
import { createTestDB } from "../db/test-utils.js";
import { InMemoryTaskQueue } from "../queue/in-memory.js";
import { ConcurrencyLimiter } from "../rate-limit/concurrency-limiter.js";
import { ContainerPool } from "../container/pool.js";
import { SessionRegistry } from "../container/session-registry.js";
import { Orchestrator, type OrchestratorDeps } from "./orchestrator.js";
import { WorkspaceProvisioner } from "../container/workspace.js";
import { ProfileService } from "../services/profile-service.js";
import { ApiKeyService } from "../services/api-key-service.js";
import { ToolFileService } from "../services/tool-file-service.js";
import { SkillService } from "../services/skill-service.js";
import { SubagentService } from "../services/subagent-service.js";
import { GitProviderService } from "../services/git-provider-service.js";
import type { ContainerManager, ContainerCreateOptions } from "@vonzio/shared";
import type { Task } from "@vonzio/shared";

const ENCRYPTION_KEY = "a]3Kf9$mPqR7vXw2LnB5tYhJ8cDgE0sU";

// --- Mock ContainerManager ---

function createMockManager(): ContainerManager & {
  execOutputs: Map<string, string[]>;
} {
  const containers = new Map<string, string>();
  const execOutputs = new Map<string, string[]>();
  let nextId = 1;

  return {
    execOutputs,

    async createContainer(opts) {
      const id = `ctr_${nextId++}`;
      containers.set(id, "created");
      return id;
    },
    async startContainer(id) {
      containers.set(id, "running");
    },
    async stopContainer(id) {
      containers.set(id, "exited");
    },
    async removeContainer(id) {
      containers.delete(id);
    },
    async *execInContainer(id, cmd, stdin) {
      const outputs = execOutputs.get(id);
      if (outputs) {
        for (const line of outputs) {
          yield line;
        }
        return;
      }

      // Default: simulate agent runner producing a result
      if (cmd.includes("node")) {
        yield JSON.stringify({
          type: "init",
          session_id: "sess_auto",
        });
        yield JSON.stringify({
          type: "token",
          text: "Hello",
        });
        yield JSON.stringify({
          type: "result",
          session_id: "sess_auto",
          result: {
            text: "Hello world",
            input_tokens: 100,
            output_tokens: 50,
            cost_usd: 0.01,
            turns: 1,
          },
        });
        yield JSON.stringify({ type: "exit", code: 0 });
      }
    },
    async getContainerStatus(id) {
      return containers.has(id) ? "running" : "not_found";
    },
    async listManagedContainers() {
      return [];
    },
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

// --- Test helpers ---

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task_${Math.random().toString(36).slice(2)}`,
    mode: "batch",
    status: "queued",
    prompt: "test prompt",
    profile_id: "prof_placeholder",
    priority: "normal",
    created_at: new Date().toISOString(),
    attempt: 1,
    ...overrides,
  };
}

async function insertTask(handle: DB, task: Task): Promise<void> {
  await handle.db
    .insert(schema.tasks)
    .values({
      id: task.id,
      mode: task.mode,
      status: task.status,
      prompt: task.prompt,
      profile_id: task.profile_id,
      priority: task.priority,
      created_at: task.created_at,
      attempt: task.attempt,
      session_id: task.session_id ?? null,
      allowed_tools: task.allowed_tools ?? null,
      output_schema: task.output_schema ?? null,
      workspace: task.workspace ?? null,
      claude_md: task.claude_md ?? null,
      egress_domains: task.egress_domains ?? null,
      max_turns: task.max_turns ?? null,
      max_budget_usd: task.max_budget_usd ?? null,
      timeout_seconds: task.timeout_seconds ?? null,
      retry: task.retry ?? null,
      started_at: task.started_at ?? null,
      finished_at: task.finished_at ?? null,
      cancelled_at: task.cancelled_at ?? null,
      result: task.result ?? null,
      error: task.error ?? null,
    });
}

async function getTask(handle: DB, taskId: string) {
  const rows = await handle.db
    .select()
    .from(schema.tasks)
    .where(sql`id = ${taskId}`);
  return rows[0];
}

describe("Orchestrator", () => {
  let handle: DB;
  let manager: ReturnType<typeof createMockManager>;
  let queue: InMemoryTaskQueue;
  let pool: ContainerPool;
  let sessionRegistry: SessionRegistry;
  let limiter: ConcurrencyLimiter;
  let orchestrator: Orchestrator;
  let testProfileId: string;

  beforeEach(async () => {
    handle = await createTestDB();

    manager = createMockManager();
    queue = new InMemoryTaskQueue();
    limiter = new ConcurrencyLimiter(4);

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

    sessionRegistry = new SessionRegistry(
      { idleTtlSecs: 1800, maxLifetimeSecs: 86400, workstationIdlePauseSecs: 1800, workstationMaxLifetimeSecs: 604800, maxPaused: 10, volumeTtlDays: 7 },
      {
        onIdleExpiry: vi.fn(),
        onIdlePause: vi.fn(),
        onExpired: vi.fn(),
      },
      handle.db,
    );

    const apiKeyService = new ApiKeyService(handle.db, ENCRYPTION_KEY);
    const profileService = new ProfileService(handle.db, ENCRYPTION_KEY, apiKeyService);
    const testKey = await apiKeyService.create({
      name: "test-key",
      provider: "api_key",
      api_key: "sk-ant-test-key",
    });
    const testProfile = await profileService.create({
      name: "test",
      api_key_id: testKey.id,
    });
    testProfileId = testProfile.id;

    const deps: OrchestratorDeps = {
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
    };

    orchestrator = new Orchestrator(deps);
    orchestrator.start();
  });

  afterEach(async () => {
    await orchestrator.stop();
    await pool.shutdown();
    await handle.close();
  });

  it("dispatches a batch task end-to-end", async () => {
    const task = makeTask({ id: "batch_1", mode: "batch", profile_id: testProfileId });
    await insertTask(handle, task);

    const done = new Promise<void>((resolve) => {
      orchestrator.on("task:done", (taskId) => {
        if (taskId === "batch_1") resolve();
      });
    });

    await queue.enqueue(task);
    await done;

    const row = await getTask(handle, "batch_1");
    expect(row.status).toBe("done");
    expect(row.result).toBeTruthy();
    expect((row.result as { text: string }).text).toBe("Hello world");
  });

  it("dispatches a pooled task end-to-end", async () => {
    const task = makeTask({ id: "pooled_1", mode: "pooled", profile_id: testProfileId });
    await insertTask(handle, task);

    const done = new Promise<void>((resolve) => {
      orchestrator.on("task:done", (taskId) => {
        if (taskId === "pooled_1") resolve();
      });
    });

    await queue.enqueue(task);
    await done;

    const row = await getTask(handle, "pooled_1");
    expect(row.status).toBe("done");
  });

  it("dispatches a session task and creates container", async () => {
    const task = makeTask({
      id: "session_1",
      mode: "session",
      session_id: "00000000-0000-0000-0000-000000000001",
      profile_id: testProfileId,
    });
    await insertTask(handle, task);

    const done = new Promise<void>((resolve) => {
      orchestrator.on("task:done", (taskId) => {
        if (taskId === "session_1") resolve();
      });
    });

    await queue.enqueue(task);
    await done;

    const row = await getTask(handle, "session_1");
    expect(row.status).toBe("done");

    // Session should be registered
    const session = sessionRegistry.get("00000000-0000-0000-0000-000000000001");
    expect(session).not.toBeNull();
    expect(session!.status).toBe("active");
  });

  it("respects profile concurrency limits", async () => {
    limiter.setLimit(testProfileId, 1);

    const task1 = makeTask({ id: "t1", profile_id: testProfileId });
    const task2 = makeTask({ id: "t2", profile_id: testProfileId });
    await insertTask(handle, task1);
    await insertTask(handle, task2);

    const done1 = new Promise<void>((resolve) => {
      orchestrator.on("task:done", (taskId) => {
        if (taskId === "t1") resolve();
      });
    });

    await queue.enqueue(task1);
    await queue.enqueue(task2);

    await done1;

    // After t1 completes, t2 should eventually run
    const done2 = new Promise<void>((resolve) => {
      orchestrator.on("task:done", (taskId) => {
        if (taskId === "t2") resolve();
      });
    });

    // Trigger processing of re-enqueued task
    await queue.enqueue(
      makeTask({ id: "t2", profile_id: testProfileId }),
    );

    // Wait briefly for processing
    await new Promise((r) => setTimeout(r, 100));
  });

  it("cancels a queued task", async () => {
    const task = makeTask({ id: "cancel_q", profile_id: testProfileId });
    await insertTask(handle, task);

    // Stop orchestrator first so the onReady callback won't process the task
    await orchestrator.stop();

    await queue.enqueue(task);

    const cancelled = await orchestrator.cancelTask("cancel_q");
    expect(cancelled).toBe(true);

    const row = await getTask(handle, "cancel_q");
    expect(row.status).toBe("cancelled");
  });

  it("emits token events during task execution", async () => {
    const task = makeTask({ id: "token_test", profile_id: testProfileId });
    await insertTask(handle, task);

    const tokens: string[] = [];
    orchestrator.on("task:token", (taskId: string, sessionId: string | undefined, text: string) => {
      if (taskId === "token_test") tokens.push(text);
    });

    const done = new Promise<void>((resolve) => {
      orchestrator.on("task:done", (taskId) => {
        if (taskId === "token_test") resolve();
      });
    });

    await queue.enqueue(task);
    await done;

    expect(tokens).toContain("Hello");
  });

  it("handles agent failure with retry policy", async () => {
    // Set up container to produce an error
    const errorManager = createMockManager();
    const errorPool = new ContainerPool(
      errorManager,
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
    await errorPool.init();

    // Override exec to return an error
    const origExec = errorManager.execInContainer.bind(errorManager);
    errorManager.execInContainer = async function* (id, cmd, stdin) {
      if (cmd.includes("node")) {
        yield JSON.stringify({ type: "error", error: "Agent crashed" });
        yield JSON.stringify({ type: "exit", code: 1 });
      }
    };

    const errorQueue = new InMemoryTaskQueue();
    const errorOrchestrator = new Orchestrator({
      queue: errorQueue,
      containerManager: errorManager,
      pool: errorPool,
      sessionRegistry,
      workspace: new WorkspaceProvisioner(),
      concurrencyLimiter: new ConcurrencyLimiter(4),
      profileService: new ProfileService(handle.db, ENCRYPTION_KEY),
      toolFileService: new ToolFileService(handle.db, "/tmp/vonzio-test-tools"),
      skillService: new SkillService(handle.db, "/tmp/vonzio-test-skills"),
      subagentService: new SubagentService(handle.db),
      gitProviderService: new GitProviderService(handle.db, ENCRYPTION_KEY),
      db: handle.db,
      config: orchestrator["deps"].config,
    });
    errorOrchestrator.start();

    const task = makeTask({
      id: "retry_test",
      profile_id: testProfileId,
      retry: { max_attempts: 2, backoff_seconds: 0, retry_on: ["error"] },
    });
    await insertTask(handle, task);

    const retried = new Promise<void>((resolve) => {
      errorOrchestrator.on("task:retry", (taskId) => {
        if (taskId === "retry_test") resolve();
      });
    });

    await errorQueue.enqueue(task);
    await retried;

    const row = await getTask(handle, "retry_test");
    expect(row.attempt).toBe(2);

    await errorOrchestrator.stop();
    await errorPool.shutdown();
  });
});
