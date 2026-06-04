// PluginStorageKv (`ctx.storage`) implementation. Backed by the core-owned
// `plugin_storage` table (migration 22). Every read/write is filtered
// server-side by `plugin_id`, so one plugin has no API path to another's keys.
// Gated by the `storage.kv` capability.

import { sql } from "drizzle-orm";
import type { DB } from "../db/index.js";
import type { PluginStorageKv } from "@vonzio/plugin-api";

/**
 * Build the `ctx.storage` surface for a plugin. `pluginId` is the plugin's
 * stable name; it scopes every row. JSONB values round-trip as parsed JS
 * objects (node-postgres decodes jsonb), so callers get their stored shape.
 */
export function makePluginStorage(handle: DB, pluginId: string): PluginStorageKv {
  return {
    async get<T>(key: string): Promise<T | null> {
      const res = await handle.db.execute<{ value: T }>(
        sql`SELECT value FROM plugin_storage WHERE plugin_id = ${pluginId} AND key = ${key} LIMIT 1`,
      );
      const row = res.rows[0] as { value: T } | undefined;
      return row ? row.value : null;
    },

    async set<T>(key: string, value: T): Promise<void> {
      const json = JSON.stringify(value);
      const now = new Date().toISOString();
      await handle.db.execute(
        sql`INSERT INTO plugin_storage (plugin_id, key, value, updated_at)
            VALUES (${pluginId}, ${key}, ${json}::jsonb, ${now})
            ON CONFLICT (plugin_id, key)
            DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      );
    },

    async delete(key: string): Promise<void> {
      await handle.db.execute(
        sql`DELETE FROM plugin_storage WHERE plugin_id = ${pluginId} AND key = ${key}`,
      );
    },

    async list(prefix?: string): Promise<Array<{ key: string; value: unknown }>> {
      const res =
        prefix === undefined
          ? await handle.db.execute<{ key: string; value: unknown }>(
              sql`SELECT key, value FROM plugin_storage WHERE plugin_id = ${pluginId} ORDER BY key`,
            )
          : await handle.db.execute<{ key: string; value: unknown }>(
              // Escape LIKE metacharacters in the prefix so a `%`/`_` in the
              // caller's prefix is treated literally.
              sql`SELECT key, value FROM plugin_storage
                  WHERE plugin_id = ${pluginId}
                    AND key LIKE ${prefix.replace(/[\\%_]/g, "\\$&") + "%"} ESCAPE '\\'
                  ORDER BY key`,
            );
      return res.rows.map((r) => ({ key: (r as { key: string }).key, value: (r as { value: unknown }).value }));
    },
  };
}
