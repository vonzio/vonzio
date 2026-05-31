// Plugin-owned drizzle schema for the three telegram tables.
//
// These pgTable definitions intentionally mirror the ones in core's
// db/schema.ts (versions v14 + v19). Until 3D.1d removes
// `telegram-events.ts` from core, BOTH definitions exist in the
// workspace and point at the same physical tables -- core's drizzle
// reads inside telegram-events.ts use core's tables; the plugin's
// reads (presence-provider, notify-handler, and eventually
// telegram-events when it moves) use these. Drizzle is happy with
// duplicate pgTable definitions targeting the same name; the only
// constraint is that the column shapes match.
//
// After 3D.1d:
//   - core's telegram_* tables in db/schema.ts can be deleted
//   - core's v14 + v19 migrations can be deleted (the plugin's
//     CREATE TABLE IF NOT EXISTS migration is idempotent)
//
// New columns / indexes go here from now on. Don't add them to
// core's mirror -- that file is on its way out.

import { pgTable, text, primaryKey, index } from "drizzle-orm/pg-core";

/**
 * "Active session" routing -- maps (bot, chat, telegram user) to the
 * vonzio session_id their messages currently route to. One row per
 * conversation; updated on every /switch or /new.
 */
export const telegramActiveSessions = pgTable(
  "telegram_active_sessions",
  {
    bot_user_id: text("bot_user_id").notNull(),
    chat_id: text("chat_id").notNull(),
    tg_user_id: text("tg_user_id").notNull(),
    session_id: text("session_id").notNull(),
    profile_id: text("profile_id").notNull(),
    user_id: text("user_id").notNull(),
    last_used_at: text("last_used_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bot_user_id, table.chat_id, table.tg_user_id] }),
    index("telegram_active_session_idx").on(table.session_id),
  ],
);

/**
 * Playbook-thread routing rows (feature #18). One row per outbound
 * playbook message that carries an inline-keyboard "Reply here"
 * button -- claimed_at populates when the user taps it (or auto-claims
 * via a direct reply); dismissed_at populates if they tap "Keep my
 * chat". The (bot, chat, message_id) PK matches the Telegram
 * callback_query payload that drives the dispatch.
 *
 * `message_id` is text not bigint because Telegram message_ids
 * occasionally exceed JS safe-integer range and JSON parses lose
 * precision; comparisons are exact-string anyway.
 */
export const telegramPlaybookThreads = pgTable(
  "telegram_playbook_threads",
  {
    bot_user_id: text("bot_user_id").notNull(),
    chat_id: text("chat_id").notNull(),
    message_id: text("message_id").notNull(),
    session_id: text("session_id").notNull(),
    label: text("label"),
    sent_at: text("sent_at").notNull(),
    claimed_at: text("claimed_at"),
    dismissed_at: text("dismissed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.bot_user_id, table.chat_id, table.message_id] }),
    index("telegram_playbook_threads_chat_sent_idx").on(table.bot_user_id, table.chat_id, table.sent_at),
    index("telegram_playbook_threads_session_idx").on(table.session_id),
  ],
);

/**
 * Long-lived session metadata, keyed by vonzio session_id. Stores the
 * (bot, chat, tg_user) triple that birthed the session + ownership
 * info so re-engaging from any chat surface can recover the right
 * profile.
 */
export const telegramSessions = pgTable(
  "telegram_sessions",
  {
    session_id: text("session_id").primaryKey(),
    bot_user_id: text("bot_user_id").notNull(),
    chat_id: text("chat_id").notNull(),
    tg_user_id: text("tg_user_id").notNull(),
    user_id: text("user_id").notNull(),
    profile_id: text("profile_id").notNull(),
    title: text("title"),
    started_at: text("started_at").notNull(),
    ended_at: text("ended_at"),
  },
  (table) => [
    index("telegram_sessions_chat_idx").on(table.bot_user_id, table.chat_id, table.started_at),
  ],
);
