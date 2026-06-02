// Plugin-owned migrations for slack_thread_mappings. The loader
// applies these once on first boot (tracked in `_plugin_migrations`
// keyed by (plugin, name)) and skips them on subsequent boots.
//
// `CREATE TABLE IF NOT EXISTS` is a no-op on installs where core's
// migration v1 has already created the table -- this avoids breaking
// upgrade paths from pre-3E installs. Fresh installs with the slack
// plugin enabled get the table here.

import type { PluginMigration } from "@vonzio/plugin-api";

const initialSchema: PluginMigration = {
  name: "0001_initial_slack_schema",
  up: `
    CREATE TABLE IF NOT EXISTS slack_thread_mappings (
      id SERIAL PRIMARY KEY,
      slack_team_id TEXT NOT NULL,
      slack_channel_id TEXT NOT NULL,
      slack_thread_ts TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS slack_thread_lookup_idx ON slack_thread_mappings(slack_team_id, slack_channel_id, slack_thread_ts);
    CREATE INDEX IF NOT EXISTS slack_thread_session_idx ON slack_thread_mappings(session_id);
  `,
};

export const slackMigrations: PluginMigration[] = [initialSchema];
