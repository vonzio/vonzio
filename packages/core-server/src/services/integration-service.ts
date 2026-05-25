import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { encrypt, decrypt } from "../auth/crypto.js";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";
import { normalizeScope, isGrantedToProfile, type Scope, type ScopeInput } from "./scope.js";

export interface SlackConfig {
  team_id: string;
  team_name: string;
  bot_token: string;
  bot_user_id: string;
  authed_user_id: string;
  channel_id?: string;
}

export interface GmailConfig {
  email: string;
  refresh_token: string;
  access_token?: string;
  token_expiry?: number;
}

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
   * Optional agent-profile binding. When set, `/new` (without a leading
   * `@slug`) and the first plain-text message in a fresh chat default to
   * this profile, and the agent name appears in /help. Lets a user run
   * one Telegram bot per agent flavor — direct access without `@slug`.
   * Empty/unset = legacy behavior (first profile from profileService).
   */
  bound_profile_id?: string;
  /**
   * True when this row points at the shared platform-hosted bot (a
   * single PLATFORM_TELEGRAM_BOT_TOKEN serves all Vonzio users). The
   * bot_token field is then ignored at send time — runtime pulls the
   * token from env so rotation is a single config change. Disconnect
   * also skips deleteWebhook for these rows.
   */
  is_platform_owned?: boolean;
}

export interface TellerConfig {
  /** Teller's stable identifier for this enrollment (one bank linkage). */
  enrollment_id: string;
  /** Per-enrollment access token returned by Teller Connect — stored encrypted. */
  access_token: string;
  /** Institution display name (e.g. "PNC", "Chase") for the UI. */
  institution_name?: string;
  /** Institution's stable Teller id (e.g. "pnc"); useful for grouping/filters. */
  institution_id?: string;
  /** Teller-side user id (one per enrollment; same person can have many). */
  teller_user_id?: string;
  /** Wall-clock when this enrollment was first linked. */
  enrolled_at?: string;
}

export interface Integration {
  id: string;
  user_id: string;
  type: string;
  config: Record<string, unknown>;
  enabled: boolean;
  is_default: boolean;
  /** 'all' = available to every agent owned by user; 'agents' = restricted to profile_ids. */
  scope: Scope;
  profile_ids: string[];
  created_at: string;
  updated_at: string;
}

/**
 * Pick out the provider-stable external identifier from a config payload so we
 * can store it in an indexed column. Only telegram needs this today; other
 * types are looked up by user_id (slack falls back to a scan in
 * getBySlackTeamAndUser, which is fine — that path is also low-frequency).
 */
function extractExternalId(type: string, config: Record<string, unknown>): string | null {
  if (type === "telegram") {
    const id = config.bot_user_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }
  if (type === "teller") {
    const id = config.enrollment_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }
  return null;
}

export class IntegrationService {
  constructor(
    private db: DrizzleDB,
    private encryptionKey: string,
  ) {}

  async create(
    userId: string,
    type: string,
    config: Record<string, unknown>,
    scopeInput: ScopeInput = {},
  ): Promise<Integration> {
    const id = `int_${nanoid()}`;
    const now = new Date().toISOString();
    const { scope, profile_ids } = normalizeScope(scopeInput);
    const row = {
      id,
      user_id: userId,
      type,
      external_id: extractExternalId(type, config),
      encrypted_config: encrypt(JSON.stringify(config), this.encryptionKey),
      enabled: true,
      scope,
      profile_ids,
      created_at: now,
      updated_at: now,
    };
    await this.db.insert(schema.userIntegrations).values(row);
    return {
      id, user_id: userId, type, config, enabled: true, is_default: false,
      scope, profile_ids,
      created_at: now, updated_at: now,
    };
  }

  async findByTypeAndExternalId(type: string, externalId: string): Promise<Integration | null> {
    const rows = await this.db.select().from(schema.userIntegrations)
      .where(and(eq(schema.userIntegrations.type, type), eq(schema.userIntegrations.external_id, externalId)));
    if (rows.length === 0) return null;
    return this.mapRow(rows[0]);
  }

  /**
   * All integrations of `type` matching `externalId`. For per-user
   * Telegram bots this returns a single row (one bot, one owner). For
   * the platform-hosted bot all users share the same `external_id`
   * (the platform bot's `bot_user_id`), so this returns one row per
   * paired user — the webhook handler filters further by
   * `owner_tg_user_id` or a pending pair code.
   */
  async listByTypeAndExternalId(type: string, externalId: string): Promise<Integration[]> {
    const rows = await this.db.select().from(schema.userIntegrations)
      .where(and(eq(schema.userIntegrations.type, type), eq(schema.userIntegrations.external_id, externalId)));
    return rows.map((r) => this.mapRow(r));
  }

  async getByUserAndType(userId: string, type: string): Promise<Integration | null> {
    const rows = await this.db.select().from(schema.userIntegrations)
      .where(and(eq(schema.userIntegrations.user_id, userId), eq(schema.userIntegrations.type, type)));
    if (rows.length === 0) return null;
    return this.mapRow(rows[0]);
  }

  /**
   * Returns every integration of `type` owned by `userId`. Used for the
   * Telegram multi-bot flow (one row per BotFather creation, each
   * potentially bound to a different agent profile).
   */
  async listByUserAndType(userId: string, type: string): Promise<Integration[]> {
    const rows = await this.db.select().from(schema.userIntegrations)
      .where(and(eq(schema.userIntegrations.user_id, userId), eq(schema.userIntegrations.type, type)));
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Every integration of `type`, across all users. Used by the startup
   * Telegram-commands re-sync to walk every connected bot. Decrypts
   * each row — keep callers low-frequency (one-shot at boot, not per-
   * request).
   */
  async listByType(type: string): Promise<Integration[]> {
    const rows = await this.db.select().from(schema.userIntegrations)
      .where(eq(schema.userIntegrations.type, type));
    return rows.map((r) => this.mapRow(r));
  }

  async getBySlackTeamAndUser(teamId: string, slackUserId: string): Promise<Integration | null> {
    const rows = await this.db.select().from(schema.userIntegrations)
      .where(eq(schema.userIntegrations.type, "slack"));
    for (const row of rows) {
      const config = JSON.parse(decrypt(row.encrypted_config, this.encryptionKey)) as SlackConfig;
      if (config.team_id === teamId && config.authed_user_id === slackUserId) {
        return this.mapRow(row);
      }
    }
    return null;
  }

  async list(userId: string): Promise<Integration[]> {
    const rows = await this.db.select().from(schema.userIntegrations)
      .where(eq(schema.userIntegrations.user_id, userId));
    return rows.map((r) => this.mapRow(r, true));
  }

  /**
   * Fetch by id. Defaults to redacted output so route handlers can return
   * the row to the client without leaking bot_token / api_key / refresh_token.
   * Pass `{ decrypt: true }` for internal callers that need the real config
   * (orchestrator MCP injection, token refresh in gmail-mcp, etc).
   */
  async get(id: string, opts: { decrypt?: boolean } = {}): Promise<Integration | null> {
    const rows = await this.db.select().from(schema.userIntegrations)
      .where(eq(schema.userIntegrations.id, id));
    if (rows.length === 0) return null;
    return this.mapRow(rows[0], !opts.decrypt);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(schema.userIntegrations)
      .where(eq(schema.userIntegrations.id, id))
      .returning();
    return result.length > 0;
  }

  async update(
    id: string,
    data: { config?: Record<string, unknown>; enabled?: boolean; scope?: Scope; profile_ids?: string[] },
    opts?: {
      /**
       * Compare-and-swap predicate: the row's current `updated_at` must
       * match this value or the UPDATE is a no-op. Used by Telegram
       * claim flows (`/link <code>` and `/start <code>`) to avoid a
       * TOCTOU between read-current-state and write-new-state when two
       * webhooks race to claim the same pending row. Caller sees
       * `null` returned and treats that as "someone else won — refuse."
       */
      expectUpdatedAt?: string;
    },
  ): Promise<Integration | null> {
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (data.config !== undefined) {
      updates.encrypted_config = encrypt(JSON.stringify(data.config), this.encryptionKey);
      // Re-derive external_id when config changes so the index stays in sync.
      // Read current type first — caller doesn't pass it.
      const current = await this.db.select({ type: schema.userIntegrations.type })
        .from(schema.userIntegrations)
        .where(eq(schema.userIntegrations.id, id));
      if (current[0]) {
        updates.external_id = extractExternalId(current[0].type, data.config);
      }
    }
    if (data.enabled !== undefined) {
      updates.enabled = data.enabled;
    }
    if (data.scope !== undefined || data.profile_ids !== undefined) {
      // Read current row so partial updates (e.g. just profile_ids) merge
      // against the existing scope, matching SecretVaultService.update.
      const current = await this.db.select({
        scope: schema.userIntegrations.scope,
        profile_ids: schema.userIntegrations.profile_ids,
      }).from(schema.userIntegrations).where(eq(schema.userIntegrations.id, id));
      if (current[0]) {
        const { scope, profile_ids } = normalizeScope({
          scope: data.scope ?? (current[0].scope as Scope),
          profile_ids: data.profile_ids ?? current[0].profile_ids,
        });
        updates.scope = scope;
        updates.profile_ids = profile_ids;
      }
    }

    const conditions = [eq(schema.userIntegrations.id, id)];
    if (opts?.expectUpdatedAt !== undefined) {
      conditions.push(eq(schema.userIntegrations.updated_at, opts.expectUpdatedAt));
    }
    const result = await this.db.update(schema.userIntegrations)
      .set(updates)
      .where(conditions.length === 1 ? conditions[0] : and(...conditions))
      .returning();

    // CAS failed (row missing OR updated_at didn't match the expected value).
    if (result.length === 0) return null;
    return this.get(id);
  }

  async setDefault(userId: string, integrationId: string): Promise<void> {
    // Clear all defaults for this user
    await this.db.update(schema.userIntegrations)
      .set({ is_default: false })
      .where(eq(schema.userIntegrations.user_id, userId));
    // Set the specified one
    await this.db.update(schema.userIntegrations)
      .set({ is_default: true })
      .where(eq(schema.userIntegrations.id, integrationId));
  }

  async getDefault(userId: string): Promise<Integration | null> {
    const rows = await this.db.select().from(schema.userIntegrations)
      .where(and(eq(schema.userIntegrations.user_id, userId), eq(schema.userIntegrations.is_default, true)));
    if (rows.length > 0) return this.mapRow(rows[0]);
    // Fall back to first enabled integration
    const allRows = await this.db.select().from(schema.userIntegrations)
      .where(and(eq(schema.userIntegrations.user_id, userId), eq(schema.userIntegrations.enabled, true)));
    return allRows.length > 0 ? this.mapRow(allRows[0]) : null;
  }

  /**
   * Backfill external_id for an existing integration whose row was created
   * before the column existed. Cheap path-once-per-stale-row called from the
   * webhook lookup fallback. No-op if external_id is already set or the type
   * has no derivable external identifier.
   */
  async backfillExternalId(id: string): Promise<void> {
    const integration = await this.get(id);
    if (!integration) return;
    const ext = extractExternalId(integration.type, integration.config);
    if (!ext) return;
    await this.db.update(schema.userIntegrations)
      .set({ external_id: ext })
      .where(eq(schema.userIntegrations.id, id));
  }

  private mapRow(row: typeof schema.userIntegrations.$inferSelect, redact = false): Integration {
    const config = JSON.parse(decrypt(row.encrypted_config, this.encryptionKey)) as Record<string, unknown>;
    if (redact) {
      if (config.bot_token) config.bot_token = "••••••••";
      if (config.api_key) config.api_key = "••••••••";
      if (config.secret) config.secret = "••••••••";
      if (config.refresh_token) config.refresh_token = "••••••••";
      if (config.access_token) config.access_token = "••••••••";
    }
    return {
      id: row.id,
      user_id: row.user_id,
      type: row.type,
      config,
      enabled: row.enabled,
      is_default: row.is_default,
      scope: (row.scope ?? "all") as Scope,
      profile_ids: row.profile_ids ?? [],
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Pull integrations of `type` owned by `userId` that are enabled and
   * scoped to `profileId`. This is the gate the orchestrator uses to
   * decide whether to inject an MCP server for the running agent —
   * scope='all' grants to every profile, scope='agents' only to the
   * profile ids the user explicitly selected.
   */
  async listForProfile(userId: string, type: string, profileId: string): Promise<Integration[]> {
    const rows = await this.listByUserAndType(userId, type);
    return rows.filter((r) => r.enabled && isGrantedToProfile({ scope: r.scope, profile_ids: r.profile_ids }, profileId));
  }
}
