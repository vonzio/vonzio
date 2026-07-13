import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { encrypt, decrypt } from "../auth/crypto.js";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";
import { getActiveOrgId } from "../lib/active-org.js";
import type { AnthropicKey, ProfileProvider } from "@vonzio/shared";

export interface CreateApiKeyInput {
  name: string;
  provider: ProfileProvider;
  api_key?: string;
  /** Secondary secret for OAuth-subscription providers: the rotating refresh
   *  token (the access token goes in `api_key`). Stored encrypted. */
  auth_token?: string | null;
  /** OpenAI-compatible endpoint override (openai provider only). */
  base_url?: string | null;
  allowed_user_ids?: string[];
}

export class ApiKeyService {
  private onKeyChanged?: (id: string) => void;
  private orgMembershipResolver?: (userId: string) => Promise<Set<string>>;

  constructor(
    private db: DrizzleDB,
    private encryptionKey: string,
  ) {}

  /** Register a hook fired when a key's stored config changes (update/delete)
   *  so dependent caches (e.g. the model-list cache) can invalidate. */
  setKeyChangeListener(fn: (id: string) => void): void {
    this.onKeyChanged = fn;
  }

  /** Register the SaaS org-membership resolver (cp-server). list() uses it to
   *  distinguish an org-materialized shared key (grantee is a member of the
   *  key's org → org-gated) from an explicit admin cross-user share (grantee
   *  not a member → visible regardless of active org). OSS leaves it unset. */
  setOrgMembershipResolver(fn: (userId: string) => Promise<Set<string>>): void {
    this.orgMembershipResolver = fn;
  }

  async create(input: CreateApiKeyInput, userId?: string): Promise<AnthropicKey> {
    const id = `apk_${nanoid()}`;
    const now = new Date().toISOString();

    const row = {
      id,
      user_id: userId ?? null,
      // Pin the caller's active org (SaaS) so the org_id-NOT-NULL CHECK on
      // api_keys is satisfied — same seam workspaces use via the active-org
      // ALS (see session-registry). In OSS there's no active org, so this is
      // null and the column stays NULL as before. Org-level shared creds are
      // a separate path (OrgCredentialService materialization).
      org_id: getActiveOrgId(),
      name: input.name,
      provider: input.provider,
      encrypted_api_key: input.api_key ? encrypt(input.api_key, this.encryptionKey) : null,
      encrypted_auth_token: input.auth_token ? encrypt(input.auth_token, this.encryptionKey) : null,
      base_url: input.base_url || null,
      created_at: now,
      last_used_at: null,
    };

    await this.db.insert(schema.anthropicKeys).values(row);

    // Insert junction table rows for allowed users
    if (input.allowed_user_ids?.length) {
      await this.db.insert(schema.apiKeyUsers).values(
        input.allowed_user_ids.map((uid) => ({ api_key_id: id, user_id: uid })),
      );
    }

    const allowed_user_ids = input.allowed_user_ids ?? [];
    return this.mapRow(row, true, allowed_user_ids);
  }

  async get(id: string): Promise<AnthropicKey | null> {
    const rows = await this.db.select().from(schema.anthropicKeys).where(eq(schema.anthropicKeys.id, id));
    if (rows.length === 0) return null;
    const allowedUserIds = await this.getAllowedUserIds(id);
    return this.mapRow(rows[0], true, allowedUserIds);
  }

  async getWithSecrets(id: string): Promise<AnthropicKey | null> {
    const rows = await this.db.select().from(schema.anthropicKeys).where(eq(schema.anthropicKeys.id, id));
    if (rows.length === 0) return null;
    const allowedUserIds = await this.getAllowedUserIds(id);
    return this.mapRow(rows[0], false, allowedUserIds);
  }

  /** Persist a rotated OAuth-subscription credential (new access + refresh
   *  token). Used by the resolve-time refresh: OpenAI refresh tokens are
   *  single-use, so the rotated refresh token MUST be stored or the next
   *  refresh fails. Writes secrets directly without touching name/sharing. */
  async rotateSubscriptionTokens(id: string, accessToken: string, refreshToken: string): Promise<void> {
    await this.db.update(schema.anthropicKeys).set({
      encrypted_api_key: encrypt(accessToken, this.encryptionKey),
      encrypted_auth_token: encrypt(refreshToken, this.encryptionKey),
    }).where(eq(schema.anthropicKeys.id, id));
    this.onKeyChanged?.(id);
  }

  /** List keys visible to a user: their own + shared keys where they are in api_key_users.
   *
   * Grant-based visibility (union model): an explicit api_key_users grant IS
   * the sharing intent, so a granted key is visible regardless of the active
   * org — a member invited to a team sees the team's shared keys even while
   * their active org is their personal one (they should never have to
   * context-switch to use a key deliberately shared with them). The active-org
   * check only gates the implicit admin path (admins see fully-shared keys
   * without a grant, but only inside the org the key belongs to — that keeps
   * an admin of org A from listing org B's keys just by role). Personal-scope
   * keys (user_id matches) and legacy admin-shared keys (user_id null AND
   * org_id null) are always visible. OSS has no membership resolver →
   * org-tagged shared keys behave as before for the (single-tenant) default.
   */
  async list(userId?: string, userRole?: string): Promise<AnthropicKey[]> {
    const rows = await this.db.select().from(schema.anthropicKeys);

    // Pre-fetch all junction table rows to avoid N+1
    const allJunctions = await this.db.select().from(schema.apiKeyUsers);
    const junctionMap = new Map<string, string[]>();
    for (const j of allJunctions) {
      const arr = junctionMap.get(j.api_key_id) ?? [];
      arr.push(j.user_id);
      junctionMap.set(j.api_key_id, arr);
    }

    if (!userId) {
      return rows.map((r) => this.mapRow(r, true, junctionMap.get(r.id) ?? []));
    }

    const activeOrgId = getActiveOrgId();
    const memberOrgIds = this.orgMembershipResolver
      ? await this.orgMembershipResolver(userId)
      : new Set<string>();

    // User sees: their own keys + any key explicitly granted to them via the
    // api_key_users junction — whether it's a fully-shared key (user_id null)
    // OR a key owned by someone else who shared it (e.g. an admin's own key
    // with the grantee added to allowed_user_ids). Honoring the junction only
    // for user_id-null keys silently dropped admin-owned shares. Admins also
    // see fully-shared keys regardless of an explicit grant (they manage them)
    // — but NOT other users' personal keys.
    return rows
      .filter((r) => {
        if (r.user_id === userId) return true; // own key
        const grantedByJunction = (junctionMap.get(r.id) ?? []).includes(userId);
        const adminShared = userRole === "admin" && !r.user_id;
        if (!grantedByJunction && !adminShared) return false;
        if (grantedByJunction) return true; // explicit grant wins in any org context
        // Implicit admin visibility only: org-tagged key outside the active
        // org → hide when the admin is a member of that org (a real
        // org-context switch shouldn't surface another org's keys by role).
        if (r.org_id && r.org_id !== activeOrgId && memberOrgIds.has(r.org_id)) return false;
        return true;
      })
      .map((r) => this.mapRow(r, true, junctionMap.get(r.id) ?? []));
  }

  async update(id: string, input: Partial<CreateApiKeyInput>): Promise<AnthropicKey | null> {
    const existing = await this.db.select().from(schema.anthropicKeys).where(eq(schema.anthropicKeys.id, id));
    if (existing.length === 0) return null;

    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.provider !== undefined) updates.provider = input.provider;
    if (input.api_key !== undefined && input.api_key !== "••••••••") {
      updates.encrypted_api_key = input.api_key ? encrypt(input.api_key, this.encryptionKey) : null;
    }
    if (input.auth_token !== undefined) {
      updates.encrypted_auth_token = input.auth_token ? encrypt(input.auth_token, this.encryptionKey) : null;
    }
    if (input.base_url !== undefined) updates.base_url = (typeof input.base_url === "string" ? input.base_url.trim() : input.base_url) || null;

    if (Object.keys(updates).length > 0) {
      await this.db.update(schema.anthropicKeys).set(updates).where(eq(schema.anthropicKeys.id, id));
    }

    // When sharing changes, update the junction table
    if (input.allowed_user_ids !== undefined) {
      const oldAllowed = new Set(await this.getAllowedUserIds(id));
      const newAllowed = new Set(input.allowed_user_ids);

      // Remove users who lost access
      const removed = [...oldAllowed].filter((uid) => !newAllowed.has(uid));
      for (const uid of removed) {
        await this.db.delete(schema.apiKeyUsers).where(
          and(eq(schema.apiKeyUsers.api_key_id, id), eq(schema.apiKeyUsers.user_id, uid)),
        );
        // Clear api_key_id on profiles that reference this key and belong to removed users
        await this.db.update(schema.profiles)
          .set({ api_key_id: null })
          .where(and(eq(schema.profiles.api_key_id, id), eq(schema.profiles.user_id, uid)));
      }

      // Add users who gained access
      const added = [...newAllowed].filter((uid) => !oldAllowed.has(uid));
      if (added.length > 0) {
        await this.db.insert(schema.apiKeyUsers).values(
          added.map((uid) => ({ api_key_id: id, user_id: uid })),
        );
      }
    }

    this.onKeyChanged?.(id);
    return this.get(id);
  }

  async delete(id: string): Promise<{ deleted: boolean; error?: string }> {
    // Clear api_key_id from all profiles referencing this key before deleting
    await this.db.update(schema.profiles)
      .set({ api_key_id: null })
      .where(eq(schema.profiles.api_key_id, id));
    // Clear any per-conversation key overrides pinned to this key so workspaces
    // fall back cleanly to their profile's key (resolve also guards this).
    await this.db.update(schema.workspaces)
      .set({ api_key_id_override: null })
      .where(eq(schema.workspaces.api_key_id_override, id));
    // Junction table rows are cascade-deleted by FK constraint
    const result = await this.db.delete(schema.anthropicKeys).where(eq(schema.anthropicKeys.id, id)).returning();
    this.onKeyChanged?.(id);
    return { deleted: result.length > 0 };
  }

  /** Whether `id` is a key the user may use — own + admin + shared/org-granted,
   *  the same visibility as list(). Centralizes the access check that routes
   *  gating a key id (model listing, validate, per-conversation key override)
   *  would otherwise each inline. */
  async isAccessible(id: string, userId: string, userRole?: string): Promise<boolean> {
    const visible = await this.list(userId, userRole);
    return visible.some((k) => k.id === id);
  }

  /** Get the first API key accessible to a user — for auto-assignment */
  async getDefaultForUser(userId: string): Promise<AnthropicKey | null> {
    const keys = await this.list(userId);
    return keys.length > 0 ? keys[0] : null;
  }

  /** Get allowed user IDs from the junction table */
  private async getAllowedUserIds(keyId: string): Promise<string[]> {
    const users = await this.db.select({ user_id: schema.apiKeyUsers.user_id })
      .from(schema.apiKeyUsers).where(eq(schema.apiKeyUsers.api_key_id, keyId));
    return users.map((u) => u.user_id);
  }

  private mapRow(
    row: typeof schema.anthropicKeys.$inferSelect,
    redact: boolean,
    allowedUserIds: string[],
  ): AnthropicKey {
    return {
      id: row.id,
      user_id: row.user_id,
      // org_id is populated by cp-server when the row is the
      // materialization of an org_credential (shared team key). OSS
      // leaves it null — the column is nullable everywhere.
      org_id: row.org_id,
      name: row.name,
      provider: row.provider,
      api_key: redact
        ? (row.encrypted_api_key ? "••••••••" : undefined)
        : (row.encrypted_api_key ? decrypt(row.encrypted_api_key, this.encryptionKey) : undefined),
      // Refresh token: never surfaced in redacted reads; decrypted for the
      // orchestrator's refresh-before-use path.
      auth_token: redact
        ? undefined
        : (row.encrypted_auth_token ? decrypt(row.encrypted_auth_token, this.encryptionKey) : undefined),
      // base_url is non-secret config — returned in both redacted and
      // with-secrets reads so the editor can show it and the orchestrator
      // can resolve it.
      base_url: row.base_url ?? null,
      allowed_user_ids: allowedUserIds,
      created_at: row.created_at,
      last_used_at: row.last_used_at ?? undefined,
    };
  }
}
