// Slack chat-surface presence provider. Registered in init() so
// core's orchestrator + ask-user-fallback + workspace-service can
// ask "is this session bound to a slack thread?" without reading
// the slack tables directly.
//
// Until the slack schema move (Phase 3E.2), the reads still target
// core-owned `slack_thread_mappings`. Raw SQL via ctx.core.db --
// same pattern telegram's presence provider used pre-3D.1c, switches
// to typed drizzle once the schema moves in 3E.2.

import { sql } from "drizzle-orm";
import type {
  PluginContext,
  SessionPresenceProvider,
} from "@vonzio/plugin-api";

interface DbHandle {
  execute(query: ReturnType<typeof sql>): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Build the provider bound to the plugin context. Returned for the
 * plugin's init() to hand to `ctx.core.sessionPresence.register(...)`.
 *
 * Same agent-visible label core's builtin used pre-extraction so the
 * Reachability section in the agent system prompt reads identically.
 */
export function buildSlackPresenceProvider(ctx: PluginContext): SessionPresenceProvider {
  const db = ctx.core.db as DbHandle;

  return {
    surface: "slack",
    metadata: {
      label: "Slack (thread bound — same latency caveat)",
      slow: true,
    },

    async hasSession(sessionId) {
      const result = await db.execute(sql`
        SELECT 1 FROM slack_thread_mappings WHERE session_id = ${sessionId} LIMIT 1
      `);
      return result.rows.length > 0;
    },

    async resolveUserIdBySession(sessionId) {
      const result = await db.execute(sql`
        SELECT user_id FROM slack_thread_mappings WHERE session_id = ${sessionId} LIMIT 1
      `);
      const row = result.rows[0];
      if (!row) return null;
      const userId = row.user_id;
      return typeof userId === "string" ? userId : null;
    },
  };
}
