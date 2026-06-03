import { describe, it, expect, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { scopedDb, checkMigrationPrefix } from "./scoped-db.js";
import { DbScopeViolationError } from "@vonzio/plugin-api";

// In-scope ("hello_") and out-of-scope tables. Query construction is lazy in
// drizzle — building `.from(t)` does NOT connect, so no real DB is needed to
// exercise the scope checks (they fire synchronously at build time).
const helloItems = pgTable("hello_items", { id: text("id").primaryKey(), v: text("v") });
const usersTable = pgTable("users", { id: text("id").primaryKey() });

const pool = new pg.Pool({ connectionString: "postgres://unused:unused@127.0.0.1:1/none" });
const raw = drizzle(pool);
const db = scopedDb(raw, "hello", "hello");

afterAll(async () => {
  await pool.end().catch(() => {});
});

describe("scopedDb table scoping", () => {
  it("allows queries against in-scope tables", () => {
    expect(() => db.select().from(helloItems)).not.toThrow();
    expect(() => db.insert(helloItems).values({ id: "1", v: "x" })).not.toThrow();
    expect(() => db.update(helloItems).set({ v: "y" })).not.toThrow();
    expect(() => db.delete(helloItems)).not.toThrow();
  });

  it("refuses .from on an out-of-scope table", () => {
    expect(() => db.select().from(usersTable)).toThrow(DbScopeViolationError);
  });

  it("refuses cross-schema joins", () => {
    expect(() => db.select().from(helloItems).leftJoin(usersTable, eq(helloItems.id, usersTable.id))).toThrow(
      DbScopeViolationError,
    );
  });

  it("refuses insert/update/delete on out-of-scope tables", () => {
    expect(() => db.insert(usersTable).values({ id: "1" })).toThrow(DbScopeViolationError);
    expect(() => db.delete(usersTable)).toThrow(DbScopeViolationError);
  });

  it("refuses raw SQL surfaces (execute / transaction)", () => {
    expect(() => (db as unknown as { execute: () => void }).execute()).toThrow(DbScopeViolationError);
    expect(() => (db as unknown as { transaction: () => void }).transaction()).toThrow(DbScopeViolationError);
  });
});

describe("checkMigrationPrefix", () => {
  it("passes when all DDL objects are prefixed", () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS hello_items (id text primary key);
      CREATE INDEX hello_items_v_idx ON hello_items (v);
      ALTER TABLE hello_items ADD COLUMN created_at text;
    `;
    expect(checkMigrationPrefix(sql, "hello")).toBeNull();
  });

  it("flags an unprefixed CREATE TABLE", () => {
    expect(checkMigrationPrefix("CREATE TABLE users (id text);", "hello")).toBe("users");
  });

  it("flags an unprefixed ALTER TABLE", () => {
    expect(checkMigrationPrefix("ALTER TABLE accounts ADD COLUMN x text;", "hello")).toBe("accounts");
  });

  it("does not search inside comments or string literals", () => {
    const sql = `
      -- CREATE TABLE users (id text);
      /* ALTER TABLE accounts ... */
      INSERT INTO hello_seed (k) VALUES ('CREATE TABLE evil (x)');
      CREATE TABLE hello_items (id text);
    `;
    expect(checkMigrationPrefix(sql, "hello")).toBeNull();
  });

  it("accepts schema-qualified objects in the plugin's own schema", () => {
    expect(checkMigrationPrefix("CREATE TABLE hello.items (id text);", "hello")).toBeNull();
    expect(checkMigrationPrefix("CREATE TABLE public.users (id text);", "hello")).toBe("users");
  });
});
