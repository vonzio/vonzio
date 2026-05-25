import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { encrypt, decrypt } from "../auth/crypto.js";
import type { DrizzleDB } from "../db/index.js";
import * as schema from "../db/schema.js";
import { normalizeScope as normalizeScopeShared, isGrantedToProfile, type Scope } from "./scope.js";

export type SecretScope = Scope;

export interface UserSecret {
  id: string;
  user_id: string;
  name: string;
  value: string; // redacted or decrypted depending on context
  scope: SecretScope;
  profile_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface SecretScopeInput {
  scope?: SecretScope;
  profile_ids?: string[];
}

const SECRET_NAME_REGEX = /^[A-Z_][A-Z0-9_]*$/;

const normalizeScope = normalizeScopeShared;

export class SecretVaultService {
  constructor(
    private db: DrizzleDB,
    private encryptionKey: string,
  ) {}

  async list(userId: string): Promise<UserSecret[]> {
    const rows = await this.db
      .select()
      .from(schema.userSecrets)
      .where(eq(schema.userSecrets.user_id, userId));
    return rows.map((r) => this.mapRow(r, true));
  }

  async create(
    userId: string,
    name: string,
    value: string,
    scopeInput: SecretScopeInput = {},
  ): Promise<UserSecret> {
    if (!SECRET_NAME_REGEX.test(name)) {
      throw new Error(
        "Secret name must match ^[A-Z_][A-Z0-9_]*$ (uppercase letters, digits, underscores)",
      );
    }
    const { scope, profile_ids } = normalizeScope(scopeInput);

    const id = `sec_${nanoid()}`;
    const now = new Date().toISOString();
    const row = {
      id,
      user_id: userId,
      name,
      encrypted_value: encrypt(value, this.encryptionKey),
      scope,
      profile_ids,
      created_at: now,
      updated_at: now,
    };

    await this.db.insert(schema.userSecrets).values(row);
    return this.mapRow(row, true);
  }

  async update(
    id: string,
    userId: string,
    input: { name?: string; value?: string; scope?: SecretScope; profile_ids?: string[] },
  ): Promise<UserSecret | null> {
    const rows = await this.db
      .select()
      .from(schema.userSecrets)
      .where(
        and(eq(schema.userSecrets.id, id), eq(schema.userSecrets.user_id, userId)),
      );
    if (rows.length === 0) return null;

    const existing = rows[0];
    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (input.name !== undefined) {
      if (!SECRET_NAME_REGEX.test(input.name)) {
        throw new Error(
          "Secret name must match ^[A-Z_][A-Z0-9_]*$ (uppercase letters, digits, underscores)",
        );
      }
      updates.name = input.name;
    }

    if (input.value !== undefined) {
      updates.encrypted_value = encrypt(input.value, this.encryptionKey);
    }

    if (input.scope !== undefined || input.profile_ids !== undefined) {
      // Merge against the row's current values so a caller can change just
      // one side (e.g. add a profile id without re-asserting scope=agents).
      const { scope, profile_ids } = normalizeScope({
        scope: input.scope ?? (existing.scope as SecretScope),
        profile_ids: input.profile_ids ?? existing.profile_ids,
      });
      updates.scope = scope;
      updates.profile_ids = profile_ids;
    }

    await this.db
      .update(schema.userSecrets)
      .set(updates)
      .where(eq(schema.userSecrets.id, id));

    const updated = await this.db
      .select()
      .from(schema.userSecrets)
      .where(eq(schema.userSecrets.id, id));
    return updated.length > 0 ? this.mapRow(updated[0], true) : null;
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(schema.userSecrets)
      .where(
        and(eq(schema.userSecrets.id, id), eq(schema.userSecrets.user_id, userId)),
      );
    if (rows.length === 0) return false;

    await this.db
      .delete(schema.userSecrets)
      .where(eq(schema.userSecrets.id, id));
    return true;
  }

  /**
   * Decrypt the secrets granted to a specific profile — orchestrator use only,
   * never expose via API. A secret is granted when `scope = 'all'` or the
   * profile id appears in `profile_ids`.
   */
  async getDecryptedForProfile(
    userId: string,
    profileId: string,
  ): Promise<Record<string, string>> {
    const rows = await this.db
      .select()
      .from(schema.userSecrets)
      .where(eq(schema.userSecrets.user_id, userId));

    const env: Record<string, string> = {};
    for (const row of rows) {
      if (!isGrantedToProfile({ scope: row.scope as Scope, profile_ids: row.profile_ids ?? [] }, profileId)) continue;
      try {
        env[row.name] = decrypt(row.encrypted_value, this.encryptionKey);
      } catch {
        // Skip secrets that fail to decrypt (e.g. key rotation)
      }
    }
    return env;
  }

  private mapRow(
    row: typeof schema.userSecrets.$inferSelect,
    redact: boolean,
  ): UserSecret {
    return {
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      value: redact ? "••••••••" : decrypt(row.encrypted_value, this.encryptionKey),
      scope: row.scope as SecretScope,
      profile_ids: row.profile_ids ?? [],
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
