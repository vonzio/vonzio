// Telegram chat-surface presence provider. Registered in init() so
// core's orchestrator + ask-user-fallback + workspace-service can
// ask "is this session bound to a telegram chat?" without reading
// the telegram tables directly.
//
// Reads now go through the plugin-owned drizzle schema (db/schema.ts)
// instead of raw SQL -- the queries are typed end-to-end and
// refactors to the schema are caught at compile time.

import { eq, isNotNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  PluginContext,
  SessionPresenceProvider,
} from "@vonzio/plugin-api";
import type { TelegramConfig } from "./types.js";
import { telegramSessions, telegramPlaybookThreads } from "./db/schema.js";

/**
 * Build the provider bound to the plugin context. Returned for the
 * plugin's init() to hand to `ctx.core.sessionPresence.register(...)`.
 *
 * The agent-visible label matches what was hard-coded in core's
 * presence.ts before the inversion -- preserving the system-prompt
 * surface verbatim so prompt-text diffs from this refactor are zero.
 */
export function buildTelegramPresenceProvider(ctx: PluginContext): SessionPresenceProvider {
  // PluginCore.db is typed `unknown` (the contract intentionally
  // doesn't lock plugins to a specific drizzle dialect). Plugins
  // cast to the dialect they actually use; we're on node-postgres.
  const db = ctx.core.db as NodePgDatabase<Record<string, never>>;

  return {
    surface: "telegram",
    metadata: {
      label: "Telegram (chat bound — may take minutes if the user isn't near their phone)",
      slow: true,
    },

    async hasSession(sessionId) {
      // Indexed lookup on telegram_sessions.session_id (the PK).
      const rows = await db
        .select({ id: telegramSessions.session_id })
        .from(telegramSessions)
        .where(eq(telegramSessions.session_id, sessionId))
        .limit(1);
      return rows.length > 0;
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
      const rows = await db
        .select({ session_id: telegramPlaybookThreads.session_id })
        .from(telegramPlaybookThreads)
        .where(isNotNull(telegramPlaybookThreads.claimed_at));
      const ids = new Set<string>();
      for (const row of rows) ids.add(row.session_id);
      return ids;
    },

    async resolveUserIdBySession(sessionId) {
      // Fallback when the in-memory SessionRegistry doesn't have a
      // workspace for this session yet -- e.g. a /new from telegram
      // wrote a telegram_sessions row but the workspace registration
      // is still in flight.
      const rows = await db
        .select({ user_id: telegramSessions.user_id })
        .from(telegramSessions)
        .where(eq(telegramSessions.session_id, sessionId))
        .limit(1);
      return rows[0]?.user_id ?? null;
    },
  };
}
