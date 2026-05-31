// Telegram chat-surface presence provider. Registered in init() so
// core's orchestrator + ask-user-fallback + workspace-service can
// ask "is this session bound to a telegram chat?" without reading
// the telegram tables directly.
//
// Until the telegram schema move (Phase 3D.1c) the reads still target
// core-owned tables -- `telegram_sessions`, `telegram_playbook_threads`,
// and `user_integrations`. Raw SQL is used so the plugin doesn't have
// to duplicate core's pgTable definitions for tables that are about
// to move anyway; once they relocate, this file switches to typed
// drizzle queries against plugin-owned schema (same pattern as
// notify-handler.ts).

import { sql } from "drizzle-orm";
import type {
  PluginContext,
  SessionPresenceProvider,
} from "@vonzio/plugin-api";
import type { TelegramConfig } from "./types.js";

interface DbHandle {
  execute(query: ReturnType<typeof sql>): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Build the provider bound to the plugin context. Returned for the
 * plugin's init() to hand to `ctx.core.sessionPresence.register(...)`.
 *
 * The agent-visible label matches what was hard-coded in core's
 * presence.ts before the inversion -- preserving the system-prompt
 * surface verbatim so prompt-text diffs from this refactor are zero.
 */
export function buildTelegramPresenceProvider(ctx: PluginContext): SessionPresenceProvider {
  const db = ctx.core.db as DbHandle;

  return {
    surface: "telegram",
    metadata: {
      label: "Telegram (chat bound — may take minutes if the user isn't near their phone)",
      slow: true,
    },

    async hasSession(sessionId) {
      // One indexed lookup on telegram_sessions.session_id (covered by
      // telegram_sessions_chat_idx). Returns presence, not the row.
      const result = await db.execute(sql`
        SELECT 1 FROM telegram_sessions WHERE session_id = ${sessionId} LIMIT 1
      `);
      return result.rows.length > 0;
    },

    async hasOwnerSurface(userId) {
      // Mirrors the legacy ask-user-fallback check: "does this user
      // have a LINKED Telegram bot (one whose owner has completed
      // /link, so the bot can DM them)?" Walks the user's integrations
      // via core's adapter; the actual schema read happens inside
      // core, not here.
      try {
        const bots = await ctx.core.integrations.listByUserAndType(userId, "telegram");
        return bots.some((b) => {
          const cfg = b.config as unknown as TelegramConfig;
          return !!cfg.owner_tg_user_id;
        });
      } catch {
        // Match the legacy try/catch behavior: a transient integration
        // lookup failure shouldn't claim presence on every session.
        return false;
      }
    },

    async listEngagedSessionIds() {
      // Sessions where the user tapped "Reply here" on a playbook
      // thread (feature #18) -- claimed_at IS NOT NULL. Without these
      // staying visible, the workspace list's pb-* filter would hide
      // ongoing telegram-bound playbook conversations.
      const result = await db.execute(sql`
        SELECT session_id FROM telegram_playbook_threads WHERE claimed_at IS NOT NULL
      `);
      const ids = new Set<string>();
      for (const row of result.rows) {
        const sid = row.session_id;
        if (typeof sid === "string") ids.add(sid);
      }
      return ids;
    },

    async resolveUserIdBySession(sessionId) {
      // Fallback when the in-memory SessionRegistry doesn't have a
      // workspace for this session yet -- e.g. a /new from telegram
      // wrote a telegram_sessions row but the workspace registration
      // is still in flight.
      const result = await db.execute(sql`
        SELECT user_id FROM telegram_sessions WHERE session_id = ${sessionId} LIMIT 1
      `);
      const row = result.rows[0];
      if (!row) return null;
      const userId = row.user_id;
      return typeof userId === "string" ? userId : null;
    },
  };
}
