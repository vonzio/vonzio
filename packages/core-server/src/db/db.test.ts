import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { schema, type DB } from "./index.js";
import { createTestDB } from "./test-utils.js";

describe("database", () => {
  let handle: DB;

  beforeEach(async () => {
    handle = await createTestDB();
  });

  afterEach(async () => {
    await handle.close();
  });

  it("inserts and retrieves a task", async () => {
    const now = new Date().toISOString();
    await handle.db
      .insert(schema.tasks)
      .values({
        id: "task_001",
        mode: "batch",
        status: "submitted",
        prompt: "Review this code",
        profile_id: "prof_abc",
        priority: "normal",
        created_at: now,
        attempt: 1,
      });

    const rows = await handle.db.select().from(schema.tasks);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("task_001");
    expect(rows[0].mode).toBe("batch");
    expect(rows[0].status).toBe("submitted");
    expect(rows[0].prompt).toBe("Review this code");
    expect(rows[0].priority).toBe("normal");
    expect(rows[0].attempt).toBe(1);
  });

  it("inserts and retrieves a workspace", async () => {
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 86400000).toISOString();
    await handle.db
      .insert(schema.workspaces)
      .values({
        session_id: "sess_001",
        container_id: "ctr_abc",
        user_id: "user_1",
        profile_id: "prof_abc",
        status: "active",
        last_active_at: now,
        created_at: now,
        expires_at: expires,
      });

    const rows = await handle.db.select().from(schema.workspaces);
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe("sess_001");
    expect(rows[0].status).toBe("active");
  });

  it("inserts and retrieves a profile", async () => {
    const now = new Date().toISOString();
    await handle.db
      .insert(schema.profiles)
      .values({
        id: "prof_001",
        name: "test-key",
        slug: "test-key",
        provider: "api_key",
        default_tools: ["Read", "Grep"],
        default_egress_domains: [],
        concurrency_limit: 5,
        created_at: now,
      });

    const rows = await handle.db.select().from(schema.profiles);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("test-key");
    expect(rows[0].provider).toBe("api_key");
    expect(rows[0].default_tools).toEqual(["Read", "Grep"]);
  });

  it("inserts and retrieves an api token", async () => {
    const now = new Date().toISOString();
    await handle.db
      .insert(schema.apiTokens)
      .values({
        id: "key_001",
        name: "ci-key",
        key_hash: "$2b$10$fakehash",
        allowed_profile_ids: ["prof_001", "prof_002"],
        rate_limit_rpm: 120,
        created_at: now,
      });

    const rows = await handle.db.select().from(schema.apiTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0].allowed_profile_ids).toEqual(["prof_001", "prof_002"]);
    expect(rows[0].rate_limit_rpm).toBe(120);
  });

  it("inserts task logs with foreign key reference", async () => {
    const now = new Date().toISOString();
    await handle.db
      .insert(schema.tasks)
      .values({
        id: "task_002",
        mode: "pooled",
        status: "running",
        prompt: "Do something",
        profile_id: "prof_abc",
        priority: "high",
        created_at: now,
        attempt: 1,
      });

    await handle.db
      .insert(schema.taskLogs)
      .values({
        task_id: "task_002",
        timestamp: now,
        level: "info",
        message: "Agent started",
      });

    const logs = await handle.db.select().from(schema.taskLogs);
    expect(logs).toHaveLength(1);
    expect(logs[0].task_id).toBe("task_002");
    expect(logs[0].level).toBe("info");
  });

  it("stores and retrieves task result as JSON", async () => {
    const now = new Date().toISOString();
    const result = {
      text: "Found 3 issues",
      tool_calls: [
        { tool: "Read", input: { path: "/foo" }, output: "bar", timestamp: now },
      ],
      session_id: "sess_abc",
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.05,
      turns: 3,
    };

    await handle.db
      .insert(schema.tasks)
      .values({
        id: "task_003",
        mode: "batch",
        status: "done",
        prompt: "Review code",
        profile_id: "prof_abc",
        priority: "normal",
        created_at: now,
        finished_at: now,
        attempt: 1,
        result,
      });

    const rows = await handle.db.select().from(schema.tasks);
    expect(rows[0].result).toEqual(result);
  });

  it("inserts and retrieves metrics", async () => {
    const now = new Date().toISOString();
    await handle.db
      .insert(schema.metrics)
      .values({
        name: "task.submitted",
        value: 42,
        labels: { mode: "batch", profile: "prof_001" },
        timestamp: now,
      });

    const rows = await handle.db.select().from(schema.metrics);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("task.submitted");
    expect(rows[0].value).toBe(42);
    expect(rows[0].labels).toEqual({ mode: "batch", profile: "prof_001" });
  });
});
