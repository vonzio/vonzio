import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;

export interface DB {
  db: DrizzleDB;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export function createDB(url: string): DB {
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    close: async () => { await pool.end(); },
  };
}

export { schema };
// Re-export the migration runner so consumers (e.g. SaaS test harnesses that
// need the full core-server schema before layering their own migrations) can
// apply it without a deep import into ./db/migrations.
export { runMigrations } from "./migrations.js";
