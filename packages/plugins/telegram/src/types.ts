// Provider-specific config shape for a Telegram integration row.
//
// The plugin owns this type. The cross-package break against core's
// integration-service.ts is mechanical: core writes these field names
// into the integration's `config` JSONB column; the plugin reads
// them out. As long as the field names match, the wire shape is
// stable.

export interface TelegramConfig {
  bot_token: string;
  bot_user_id: string;
  bot_username: string;
  webhook_secret: string;
  /** One-time code the bot owner sends as `/link <code>` in DM to claim the bot. Cleared after linking. */
  link_code?: string;
  /** Telegram user_id of the owner. Set on successful /link. */
  owner_tg_user_id?: string;
  /**
   * Optional agent-profile binding. When set, `/new` and the first
   * plain-text message in a fresh chat default to this profile.
   */
  bound_profile_id?: string | null;
  /** True when this row is the platform bot's row (shared across users). */
  is_platform_owned?: boolean;
}
