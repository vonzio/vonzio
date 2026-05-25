import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import bcrypt from "bcrypt";
import { schema, type DB } from "../db/index.js";
import { createTestDB } from "../db/test-utils.js";
import { userAuthHook } from "./user-auth.js";
import { DefaultTokenValidator } from "../lib/defaults/token-validator.js";

// Minimal mock of Better Auth — always returns no session so API token path is used
const mockAuth = {
  api: {
    getSession: async () => null,
  },
} as any;

describe("userAuthHook (API token path)", () => {
  let handle: DB;
  const TEST_TOKEN = "rc_test_token_12345";
  let tokenHash: string;

  beforeEach(async () => {
    handle = await createTestDB();
    tokenHash = await bcrypt.hash(TEST_TOKEN, 10);

    await handle.db
      .insert(schema.apiTokens)
      .values({
        id: "key_001",
        name: "test-key",
        key_hash: tokenHash,
        allowed_profile_ids: ["prof_001"],
        rate_limit_rpm: 60,
        created_at: new Date().toISOString(),
      });
  });

  afterEach(async () => {
    await handle.close();
  });

  function buildApp() {
    const app = Fastify({ logger: false });
    const hook = userAuthHook(mockAuth, new DefaultTokenValidator(handle.db));
    app.register(async (scoped) => {
      scoped.addHook("onRequest", hook);
      scoped.get("/v1/test", async (request) => {
        return { user_id: request.user?.id, name: request.user?.name };
      });
    });
    app.get("/health", async () => ({ status: "ok" }));
    return app;
  }

  it("passes with valid bearer token", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/test",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("test-key");
    await app.close();
  });

  it("returns 401 for missing authorization header", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/test" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 401 for invalid token", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/test",
      headers: { authorization: "Bearer wrong_token" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("skips auth for /health", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("updates last_used_at on successful auth", async () => {
    const app = buildApp();
    await app.inject({
      method: "GET",
      url: "/v1/test",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });

    const keys = await handle.db.select().from(schema.apiTokens);
    expect(keys[0].last_used_at).toBeTruthy();
    await app.close();
  });
});
