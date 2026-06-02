// Slack chat-surface presence provider. Registered in init() so
// core's orchestrator + ask-user-fallback + workspace-service can
// ask "is this session bound to a slack thread?" without reading
// the slack tables directly.
//
// As of Phase 3E.2 the plugin owns the slack_thread_mappings schema;
// reads here go through typed drizzle against the plugin-owned
// pgTable in ./db/schema.ts.

import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  PluginContext,
  SessionPresenceProvider,
} from "@vonzio/plugin-api";
import { slackThreadMappings } from "./db/schema.js";

/**
 * Build the provider bound to the plugin context. Returned for the
 * plugin's init() to hand to `ctx.core.sessionPresence.register(...)`.
 *
 * Same agent-visible label core's builtin used pre-extraction so the
 * Reachability section in the agent system prompt reads identically.
 */
export function buildSlackPresenceProvider(ctx: PluginContext): SessionPresenceProvider {
  const db = ctx.core.db as NodePgDatabase<Record<string, never>>;

  return {
    surface: "slack",
    metadata: {
      label: "Slack (thread bound — same latency caveat)",
      slow: true,
    },

    async hasSession(sessionId) {
      const rows = await db
        .select({ id: slackThreadMappings.session_id })
        .from(slackThreadMappings)
        .where(eq(slackThreadMappings.session_id, sessionId))
        .limit(1);
      return rows.length > 0;
    },

    async resolveUserIdBySession(sessionId) {
      const rows = await db
        .select({ user_id: slackThreadMappings.user_id })
        .from(slackThreadMappings)
        .where(eq(slackThreadMappings.session_id, sessionId))
        .limit(1);
      return rows[0]?.user_id ?? null;
    },
  };
}
