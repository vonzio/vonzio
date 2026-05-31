// Builtin chat-surface presence providers that haven't been extracted
// into their own plugins yet. Today this is just slack -- telegram
// runs as a real plugin and registers its provider in
// `@vonzio/plugin-telegram`'s init(). When the slack plugin
// extraction lands (Phase 3E candidate), delete this file's slack
// provider + its registration in server.ts.

import { eq } from "drizzle-orm";
import type { SessionPresenceProvider } from "@vonzio/plugin-api";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";

/**
 * Slack provider. Reads `slack_thread_mappings` for session-binding
 * checks. No engaged-session list yet (slack has no thread-claim
 * concept), and no owner-surface check (the ask-user fallback's
 * widening was a telegram-only behavior).
 */
export function buildSlackPresenceProvider(db: DrizzleDB): SessionPresenceProvider {
  return {
    surface: "slack",
    metadata: {
      label: "Slack (thread bound — same latency caveat)",
      slow: true,
    },
    async hasSession(sessionId) {
      const rows = await db
        .select({ id: schema.slackThreadMappings.session_id })
        .from(schema.slackThreadMappings)
        .where(eq(schema.slackThreadMappings.session_id, sessionId))
        .limit(1);
      return rows.length > 0;
    },
    async resolveUserIdBySession(sessionId) {
      const rows = await db
        .select({ user_id: schema.slackThreadMappings.user_id })
        .from(schema.slackThreadMappings)
        .where(eq(schema.slackThreadMappings.session_id, sessionId))
        .limit(1);
      return rows[0]?.user_id ?? null;
    },
  };
}
