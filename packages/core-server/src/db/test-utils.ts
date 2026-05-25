import { createDB, type DB } from "./index.js";
import { runMigrations } from "./migrations.js";
import { sql } from "drizzle-orm";

/**
 * Creates a clean Postgres test database.
 * Drops and recreates the public schema, then runs all migrations.
 */
export async function createTestDB(): Promise<DB> {
  const url =
    process.env.TEST_DATABASE_URL ??
    "postgres://vonzio:vonzio_dev@localhost:5432/vonzio_test";
  const handle = createDB(url);
  // Clean slate: drop all tables and recreate
  await handle.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await handle.db.execute(sql`CREATE SCHEMA public`);
  await runMigrations(handle);
  return handle;
}
