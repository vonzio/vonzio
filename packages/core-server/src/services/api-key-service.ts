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
  auth_token?: string;
  allowed_user_ids?: string[];
}

export class ApiKeyService {
  constructor(
    private db: DrizzleDB,
    private encryptionKey: string,
  ) {}

  async create(input: CreateApiKeyInput, userId?: string): Promise<AnthropicKey> {
    const id = `apk_${nanoid()}`;
    const now = new Date().toISOString();

    const row = {
      id,
      user_id: userId ?? null,
      // user-side create path never sets org_id; only the cp-server
      // materialization path (OrgCredentialService) populates it.
      org_id: null,
      name: input.name,
      provider: input.provider,
      encrypted_api_key: input.api_key ? encrypt(input.api_key, this.encryptionKey) : null,
      encrypted_auth_token: input.auth_token ? encrypt(input.auth_token, this.encryptionKey) : null,
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

  /** List keys visible to a user: their own + shared keys where they are in api_key_users.
   *
   * Active-org scoping: shared keys with org_id set are only included
   * when the active org (from getActiveOrgId()) matches. This prevents
   * cross-tenant leak — a member of Vonzio + their own personal org
   * sees the Vonzio team key only when active org IS Vonzio. Personal-
   * scope keys (user_id matches) and legacy admin-shared keys (user_id
   * null AND org_id null) are visible regardless. OSS deployments
   * never pin an active org → org_id-tagged shared keys stay hidden,
   * which is the right OSS default (cp-server isn't running anyway).
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

    // User sees: their own keys + shared keys they are explicitly granted access to
    return rows
      .filter((r) => {
        if (r.user_id === userId) return true; // own key
        if (!r.user_id) {
          // Shared key tagged with an org → only visible when active org matches.
          if (r.org_id && r.org_id !== activeOrgId) return false;
          if (userRole === "admin") return true;
          const allowed = junctionMap.get(r.id) ?? [];
          return allowed.includes(userId);
        }
        return false;
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
    if (input.auth_token !== undefined && input.auth_token !== "••••••••") {
      updates.encrypted_auth_token = input.auth_token ? encrypt(input.auth_token, this.encryptionKey) : null;
    }

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

    return this.get(id);
  }

  async delete(id: string): Promise<{ deleted: boolean; error?: string }> {
    // Clear api_key_id from all profiles referencing this key before deleting
    await this.db.update(schema.profiles)
      .set({ api_key_id: null })
      .where(eq(schema.profiles.api_key_id, id));
    // Junction table rows are cascade-deleted by FK constraint
    const result = await this.db.delete(schema.anthropicKeys).where(eq(schema.anthropicKeys.id, id)).returning();
    return { deleted: result.length > 0 };
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
      auth_token: redact
        ? (row.encrypted_auth_token ? "••••••••" : undefined)
        : (row.encrypted_auth_token ? decrypt(row.encrypted_auth_token, this.encryptionKey) : undefined),
      allowed_user_ids: allowedUserIds,
      created_at: row.created_at,
      last_used_at: row.last_used_at ?? undefined,
    };
  }
}
