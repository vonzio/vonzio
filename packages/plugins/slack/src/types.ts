// Slack-specific config shape stored on user_integrations.config for
// rows where type = "slack". Mirrors what core's integration-service
// used to export -- moved here in Phase 3E.2 alongside slack-events
// and slack-oauth.

export interface SlackConfig {
  team_id: string;
  team_name: string;
  bot_token: string;
  bot_user_id: string;
  authed_user_id: string;
  channel_id?: string;
}
