import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createDB, type DB } from "../db/index.js";
import { runMigrations } from "../db/migrations.js";
import { makePluginStorage } from "./storage.js";

// Real-DB integration test (no mocking). Requires Postgres at
// TEST_DATABASE_URL or postgres://vonzio:vonzio_dev@localhost:5432/vonzio_test.
//
// We run the REAL migration runner (so migration 22 actually creates
// plugin_storage) but pre-create a minimal `user` table stub: migration 17
// ALTERs the Better Auth `user` table, which the shared createTestDB() can't
// provide because it DROP SCHEMAs first (the known v0.1 auth-table/test-DB
// limitation — see .github/workflows/ci.yml). The stub is enough for the
// single ALTER ADD COLUMN; this test doesn't touch auth.
let handle: DB;

beforeAll(async () => {
  const url =
    process.env.TEST_DATABASE_URL ??
    "postgres://vonzio:vonzio_dev@localhost:5432/vonzio_test";
  handle = createDB(url);
  await handle.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await handle.db.execute(sql`CREATE SCHEMA public`);
  await handle.db.execute(sql`CREATE TABLE "user" (id TEXT PRIMARY KEY)`);
  await runMigrations(handle);
});
afterAll(async () => {
  await handle.close();
});

describe("makePluginStorage", () => {
  it("round-trips typed values and returns null for a missing key", async () => {
    const kv = makePluginStorage(handle, "hello");
    expect(await kv.get("nope")).toBeNull();
    await kv.set("greeting", { text: "hi", n: 3 });
    expect(await kv.get<{ text: string; n: number }>("greeting")).toEqual({ text: "hi", n: 3 });
  });

  it("upserts on repeated set", async () => {
    const kv = makePluginStorage(handle, "hello");
    await kv.set("k", "v1");
    await kv.set("k", "v2");
    expect(await kv.get("k")).toBe("v2");
  });

  it("delete removes a key", async () => {
    const kv = makePluginStorage(handle, "hello");
    await kv.set("d", 1);
    await kv.delete("d");
    expect(await kv.get("d")).toBeNull();
  });

  it("list returns keys, optionally filtered by literal prefix", async () => {
    const kv = makePluginStorage(handle, "lister");
    await kv.set("a:1", 1);
    await kv.set("a:2", 2);
    await kv.set("b:1", 3);
    const all = await kv.list();
    expect(all.map((r) => r.key).sort()).toEqual(["a:1", "a:2", "b:1"]);
    const aOnly = await kv.list("a:");
    expect(aOnly.map((r) => r.key).sort()).toEqual(["a:1", "a:2"]);
  });

  it("isolates keys by plugin_id", async () => {
    const alpha = makePluginStorage(handle, "alpha");
    const beta = makePluginStorage(handle, "beta");
    await alpha.set("shared", "from-alpha");
    await beta.set("shared", "from-beta");
    expect(await alpha.get("shared")).toBe("from-alpha");
    expect(await beta.get("shared")).toBe("from-beta");
    // alpha cannot see beta's keys via list
    const alphaKeys = (await alpha.list()).map((r) => r.key);
    expect(alphaKeys).toEqual(["shared"]);
  });

  it("treats LIKE metacharacters in the prefix literally", async () => {
    const kv = makePluginStorage(handle, "meta");
    await kv.set("50%off", 1);
    await kv.set("50abc", 2);
    const res = await kv.list("50%");
    expect(res.map((r) => r.key)).toEqual(["50%off"]);
  });
});
