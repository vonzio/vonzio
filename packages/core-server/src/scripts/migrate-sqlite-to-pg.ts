/**
 * One-time data migration: SQLite → PostgreSQL
 *
 * Usage:
 *   npx tsx packages/core-server/src/scripts/migrate-sqlite-to-pg.ts <sqlite-path> <postgres-url>
 *
 * Example:
 *   npx tsx packages/core-server/src/scripts/migrate-sqlite-to-pg.ts /app/data/vonzio.db postgres://vonzio:pass@localhost:5432/vonzio
 *
 * This script:
 *   1. Reads all data from the SQLite database (app tables + Better Auth tables)
 *   2. Runs Postgres migrations (creates tables if they don't exist)
 *   3. Inserts all data into PostgreSQL, converting types as needed
 *   4. Converts `allowed_user_ids` JSON column → `api_key_users` junction table
 *   5. Resets serial sequences
 */

import Database from "better-sqlite3";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { runMigrations } from "../db/migrations.js";

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("Usage: npx tsx migrate-sqlite-to-pg.ts <sqlite-path> <postgres-url>");
  console.error("Example: npx tsx migrate-sqlite-to-pg.ts ./vonzio.db postgres://vonzio:pass@localhost:5432/vonzio");
  process.exit(1);
}

const [sqlitePath, pgUrl] = args;

// ─── Helpers ──────────────────────────────────────────────────────

function parseBool(val: unknown): boolean {
  if (val === 1 || val === true || val === "1") return true;
  return false;
}

function parseJson(val: unknown): string | null {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === "string") {
    // Validate it's parseable JSON then return as-is for pg to handle
    try { JSON.parse(val); return val; } catch { return null; }
  }
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log(`\nSQLite → PostgreSQL Migration`);
  console.log(`Source: ${sqlitePath}`);
  console.log(`Target: ${pgUrl}\n`);

  // Open SQLite (read-only)
  const sqlite = new Database(sqlitePath, { readonly: true });
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence'").all() as { name: string }[];
  console.log(`Found ${tables.length} tables in SQLite: ${tables.map(t => t.name).join(", ")}\n`);

  // Connect to Postgres
  const pool = new pg.Pool({ connectionString: pgUrl });
  const db = drizzle(pool) as any;

  // Run migrations (creates tables)
  console.log("Running Postgres migrations...");
  await runMigrations({ db, pool, close: async () => {} } as any);
  console.log("Migrations complete.\n");

  // ─── Migrate app tables ──────────────────────────────────────

  const appTables = [
    { name: "tasks", boolCols: [] as string[], jsonCols: ["allowed_tools", "output_schema", "workspace", "egress_domains", "retry", "result"] },
    { name: "workspaces", boolCols: ["pinned", "starred", "archived", "persistent", "public_preview"], jsonCols: ["workspace_config", "tags"] },
    { name: "api_keys", boolCols: [] as string[], jsonCols: [] as string[], skip: ["allowed_user_ids"] },
    { name: "profiles", boolCols: ["persistent_sessions"], jsonCols: ["default_tools", "default_egress_domains", "git_provider_ids", "mcp_servers", "agent_ids", "skill_ids", "container_registry", "setup_commands"] },
    { name: "api_tokens", boolCols: [] as string[], jsonCols: ["allowed_profile_ids"] },
    { name: "task_logs", boolCols: [] as string[], jsonCols: [] as string[] },
    { name: "tool_files", boolCols: [] as string[], jsonCols: [] as string[] },
    { name: "skills", boolCols: [] as string[], jsonCols: [] as string[] },
    { name: "git_providers", boolCols: [] as string[], jsonCols: [] as string[] },
    { name: "subagents", boolCols: [] as string[], jsonCols: ["tools"] },
    { name: "invites", boolCols: [] as string[], jsonCols: ["api_key_ids"] },
    { name: "user_integrations", boolCols: ["enabled"], jsonCols: [] as string[] },
    { name: "slack_thread_mappings", boolCols: [] as string[], jsonCols: [] as string[] },
    { name: "metrics", boolCols: [] as string[], jsonCols: ["labels"] },
  ];

  // Better Auth tables
  const authTables = [
    { name: "user", boolCols: ["emailVerified", "banned"], jsonCols: [] as string[] },
    { name: "account", boolCols: [] as string[], jsonCols: [] as string[] },
    { name: "session", boolCols: [] as string[], jsonCols: [] as string[] },
    { name: "verification", boolCols: [] as string[], jsonCols: [] as string[] },
  ];

  const allTables = [...appTables, ...authTables];

  // Track allowed_user_ids for junction table migration
  const junctionRows: { api_key_id: string; user_id: string }[] = [];

  for (const tableDef of allTables) {
    const { name, boolCols, jsonCols } = tableDef;
    const skip = (tableDef as { skip?: string[] }).skip ?? [];

    // Check if table exists in SQLite
    const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (!exists) {
      console.log(`  SKIP ${name} (not in SQLite)`);
      continue;
    }

    const rows = sqlite.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
    if (rows.length === 0) {
      console.log(`  ${name}: 0 rows (empty)`);
      continue;
    }

    // Get target table columns from Postgres
    const pgColsResult = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
      [name],
    );
    const pgColSet = new Set(pgColsResult.rows.map((r: { column_name: string }) => r.column_name));

    // Only insert columns that exist in both SQLite row and Postgres table
    const allCols = Object.keys(rows[0]);
    const cols = allCols.filter(c => !skip.includes(c) && pgColSet.has(c));

    // Collect junction table data from api_keys
    if (name === "api_keys") {
      for (const row of rows) {
        const keyId = row.id as string;
        const allowedStr = row.allowed_user_ids as string;
        if (allowedStr) {
          try {
            const userIds = JSON.parse(allowedStr) as string[];
            for (const uid of userIds) {
              junctionRows.push({ api_key_id: keyId, user_id: uid });
            }
          } catch {}
        }
      }
    }

    // Build batch insert
    const batchSize = 100;
    let inserted = 0;

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const values = batch.map(row => {
        return cols.map(col => {
          let val = row[col];
          if (boolCols.includes(col)) val = parseBool(val);
          if (jsonCols.includes(col)) val = parseJson(val);
          return val;
        });
      });

      const colList = cols.map(c => `"${c}"`).join(", ");
      const placeholders = values.map((_, rowIdx) => {
        const start = rowIdx * cols.length;
        return `(${cols.map((_, colIdx) => `$${start + colIdx + 1}`).join(", ")})`;
      }).join(", ");
      const flatValues = values.flat();

      // Quote table name for reserved words like "user", "session"
      const insertSql = `INSERT INTO "${name}" (${colList}) VALUES ${placeholders} ON CONFLICT DO NOTHING`;

      try {
        await pool.query(insertSql, flatValues);
        inserted += batch.length;
      } catch (err) {
        console.error(`  ERROR inserting into ${name}:`, (err as Error).message);
        // Try row-by-row for debugging
        for (const row of batch) {
          const singleValues = cols.map(col => {
            let val = row[col];
            if (boolCols.includes(col)) val = parseBool(val);
            if (jsonCols.includes(col)) val = parseJson(val);
            return val;
          });
          const singlePlaceholders = cols.map((_, idx) => `$${idx + 1}`).join(", ");
          try {
            await pool.query(`INSERT INTO "${name}" (${colList}) VALUES (${singlePlaceholders}) ON CONFLICT DO NOTHING`, singleValues);
            inserted++;
          } catch (rowErr) {
            console.error(`    Row error (${row.id ?? "?"}):`, (rowErr as Error).message);
          }
        }
      }
    }

    console.log(`  ${name}: ${inserted} rows migrated`);
  }

  // ─── Migrate junction table ─────────────────────────────────

  if (junctionRows.length > 0) {
    let junctionInserted = 0;
    for (const jr of junctionRows) {
      try {
        await pool.query(
          `INSERT INTO "api_key_users" ("api_key_id", "user_id") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [jr.api_key_id, jr.user_id],
        );
        junctionInserted++;
      } catch {}
    }
    console.log(`  api_key_users: ${junctionInserted} rows migrated (from allowed_user_ids)`);
  }

  // ─── Reset serial sequences ─────────────────────────────────

  const serialTables = [
    { table: "task_logs", col: "id" },
    { table: "slack_thread_mappings", col: "id" },
    { table: "metrics", col: "id" },
  ];

  for (const { table, col } of serialTables) {
    try {
      const seqName = `${table}_${col}_seq`;
      const result = await pool.query(`SELECT MAX("${col}") as max_val FROM "${table}"`);
      const maxVal = result.rows[0]?.max_val ?? 0;
      if (maxVal > 0) {
        await pool.query(`SELECT setval('${seqName}', $1)`, [maxVal]);
        console.log(`  Sequence ${seqName} reset to ${maxVal}`);
      }
    } catch (err) {
      console.error(`  Warning: could not reset sequence for ${table}:`, (err as Error).message);
    }
  }

  // ─── Summary ────────────────────────────────────────────────

  console.log("\nMigration complete!");
  console.log("\nVerification:");
  for (const tableDef of allTables) {
    try {
      const result = await pool.query(`SELECT COUNT(*) as cnt FROM "${tableDef.name}"`);
      console.log(`  ${tableDef.name}: ${result.rows[0].cnt} rows`);
    } catch {}
  }
  const junctionResult = await pool.query(`SELECT COUNT(*) as cnt FROM "api_key_users"`);
  console.log(`  api_key_users: ${junctionResult.rows[0].cnt} rows`);

  sqlite.close();
  await pool.end();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
