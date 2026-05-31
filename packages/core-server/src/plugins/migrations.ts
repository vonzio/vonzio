import { sql } from "drizzle-orm";
import type { PluginMigration } from "@vonzio/plugin-api";
import type { DB } from "../db/index.js";

/**
 * Plugin migration runner. Lives in a SEPARATE table from core's
 * `_migrations` so the two systems don't have to agree on schema or
 * ordering -- core uses integer versions, plugins use string names,
 * and decoupling makes uninstall + re-install paths sane.
 *
 * The composite key (plugin, name) lets one plugin name its
 * migrations whatever it wants without colliding with other plugins
 * or core. Idempotent by design: we check before running.
 */
export async function ensurePluginMigrationsTable(handle: DB): Promise<void> {
  await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS _plugin_migrations (
    plugin TEXT NOT NULL,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (plugin, name)
  )`);
}

/**
 * Run all migrations for a single plugin in declared order, skipping
 * ones already in `_plugin_migrations`. Plugin migrations are
 * expected to be idempotent (CREATE TABLE IF NOT EXISTS etc.) so even
 * a half-applied migration that crashes mid-way can be re-attempted
 * on next boot without leaving the schema in a weird state.
 */
export async function runPluginMigrations(
  handle: DB,
  pluginName: string,
  migrations: PluginMigration[],
): Promise<void> {
  await ensurePluginMigrationsTable(handle);

  const appliedRows = await handle.db.execute<{ name: string }>(
    sql`SELECT name FROM _plugin_migrations WHERE plugin = ${pluginName}`,
  );
  const applied = new Set(appliedRows.rows.map((r) => (r as { name: string }).name));

  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    console.log(`[plugin:${pluginName}] applying migration ${m.name}`);
    // Execute raw SQL. Drizzle's `sql.raw()` would interpret placeholders;
    // we want the plugin's SQL verbatim, so use db.execute() with a sql tag
    // whose body is the literal string. (`sql.raw` is the official escape
    // hatch for "I really mean this exact SQL".)
    await handle.db.execute(sql.raw(m.up));
    await handle.db.execute(
      sql`INSERT INTO _plugin_migrations (plugin, name, applied_at) VALUES (${pluginName}, ${m.name}, ${new Date().toISOString()})`,
    );
  }
}
