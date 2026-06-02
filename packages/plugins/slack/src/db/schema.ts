// Plugin-owned drizzle schema for slack_thread_mappings.
//
// Mirrors the pgTable that lived in core's db/schema.ts until Phase
// 3E.2. The physical table is the same; the dialect handle in the
// plugin's runtime is the same. After this PR core's schema.ts loses
// the slackThreadMappings export; this file is the sole source of
// truth.
//
// One note on migrations: slack_thread_mappings was created in core's
// migration v1 (the initial-schema dump), not in a separate version
// like telegram's v14/v19 were. We CAN'T delete those v1 lines
// without breaking fresh installs that don't load the slack plugin.
// What we do instead: leave v1 alone, ship an idempotent
// `CREATE TABLE IF NOT EXISTS` plugin migration. Existing installs
// have the table from v1 -- the plugin migration no-ops. Fresh
// installs without the slack plugin never need the table.

import { pgTable, text, serial, index } from "drizzle-orm/pg-core";

/**
 * Slack thread routing: links a (team, channel, thread_ts) triple to
 * the vonzio session_id its messages route to. One row per slack
 * conversation; the thread_lookup index makes inbound webhook
 * routing O(1).
 */
export const slackThreadMappings = pgTable(
  "slack_thread_mappings",
  {
    id: serial("id").primaryKey(),
    slack_team_id: text("slack_team_id").notNull(),
    slack_channel_id: text("slack_channel_id").notNull(),
    slack_thread_ts: text("slack_thread_ts").notNull(),
    session_id: text("session_id").notNull(),
    user_id: text("user_id").notNull(),
    profile_id: text("profile_id").notNull(),
    created_at: text("created_at").notNull(),
  },
  (table) => [
    index("slack_thread_lookup_idx").on(table.slack_team_id, table.slack_channel_id, table.slack_thread_ts),
    index("slack_thread_session_idx").on(table.session_id),
  ],
);
