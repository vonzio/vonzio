// Plugin-owned migrations for the telegram tables. The loader applies
// these once on first boot (tracked in `_plugin_migrations` keyed by
// (plugin, name)) and skips them on subsequent boots.
//
// Each migration uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF
// NOT EXISTS so it's a no-op on installs where core's v14 + v19
// migrations have already created the tables -- this avoids breaking
// upgrade paths from pre-3D.1c installs. After 3D.1d removes
// `telegram-events.ts` from core (the last in-core reader), core's
// v14 + v19 migrations can be deleted; this file remains the sole
// source of truth.

import type { PluginMigration } from "@vonzio/plugin-api";

/**
 * Initial schema -- mirrors core's `db/migrations.ts` v14 + v19 in
 * one combined migration. Kept as one transaction (well, one apply
 * step) so a fresh install gets all three tables atomically. SQL
 * matches what core wrote, verbatim, including the
 * IF NOT EXISTS guards.
 */
const initialSchema: PluginMigration = {
  name: "0001_initial_telegram_schema",
  up: `
    CREATE TABLE IF NOT EXISTS telegram_active_sessions (
      bot_user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      tg_user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      PRIMARY KEY (bot_user_id, chat_id, tg_user_id)
    );
    CREATE INDEX IF NOT EXISTS telegram_active_session_idx ON telegram_active_sessions(session_id);

    CREATE TABLE IF NOT EXISTS telegram_sessions (
      session_id TEXT PRIMARY KEY,
      bot_user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      tg_user_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      title TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE INDEX IF NOT EXISTS telegram_sessions_chat_idx ON telegram_sessions(bot_user_id, chat_id, started_at);

    CREATE TABLE IF NOT EXISTS telegram_playbook_threads (
      bot_user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      label TEXT,
      sent_at TEXT NOT NULL,
      claimed_at TEXT,
      dismissed_at TEXT,
      PRIMARY KEY (bot_user_id, chat_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS telegram_playbook_threads_chat_sent_idx ON telegram_playbook_threads(bot_user_id, chat_id, sent_at);
    CREATE INDEX IF NOT EXISTS telegram_playbook_threads_session_idx ON telegram_playbook_threads(session_id);
  `,
};

export const telegramMigrations: PluginMigration[] = [initialSchema];
