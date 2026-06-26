import { eq, or, and, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { encrypt, decrypt } from "../auth/crypto.js";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";

export interface GitProvider {
  id: string;
  name: string;
  type: "github" | "gitlab" | "bitbucket";
  auth_method: "pat" | "oauth" | "github_app";
  token?: string; // decrypted or redacted
  installation_id?: string;
  user_name?: string;
  user_email?: string;
  created_at: string;
}

/**
 * Mints short-lived GitHub App installation tokens. Injected (rather than
 * imported) to keep GitProviderService free of a hard dependency on the app
 * config — when no GitHub App is configured the minter is simply absent and
 * `github_app` rows can't be created in the first place.
 */
export interface InstallationTokenMinter {
  getInstallationToken(installationId: string): Promise<string>;
}

export interface CreateGitProviderInput {
  name: string;
  type: "github" | "gitlab" | "bitbucket";
  token: string;
  user_name?: string;
  user_email?: string;
}

export class GitProviderService {
  constructor(
    private db: DrizzleDB,
    private encryptionKey: string,
    private tokenMinter?: InstallationTokenMinter,
  ) {}

  async list(userId?: string): Promise<GitProvider[]> {
    const query = this.db.select().from(schema.gitProviders);
    const rows = userId
      ? await query.where(or(eq(schema.gitProviders.user_id, userId), isNull(schema.gitProviders.user_id)))
      : await query;
    return rows.map((r) => this.mapRow(r, true));
  }

  async get(id: string): Promise<GitProvider | null> {
    const rows = await this.db.select().from(schema.gitProviders).where(eq(schema.gitProviders.id, id));
    return rows.length > 0 ? this.mapRow(rows[0], true) : null;
  }

  /**
   * Get with a usable token — for orchestrator internal use.
   *
   * For PAT/OAuth rows this is the decrypted stored token. For GitHub App rows
   * there is no stored token: we mint a fresh, short-lived installation access
   * token on the spot. The orchestrator injects the result as GITHUB_TOKEN at
   * session start, so the agent always boots with a valid token (good for the
   * installation token's 1-hour lifetime — long enough for a session's git
   * operations).
   */
  async getWithSecret(id: string): Promise<GitProvider | null> {
    const rows = await this.db.select().from(schema.gitProviders).where(eq(schema.gitProviders.id, id));
    if (rows.length === 0) return null;
    const provider = this.mapRow(rows[0], false);
    if (provider.auth_method === "github_app") {
      if (!this.tokenMinter || !provider.installation_id) {
        // App misconfigured or row predates the minter — no usable token.
        provider.token = undefined;
        return provider;
      }
      provider.token = await this.tokenMinter.getInstallationToken(provider.installation_id);
    }
    return provider;
  }

  async create(input: CreateGitProviderInput, userId?: string): Promise<GitProvider> {
    const id = `git_${nanoid()}`;
    const row = {
      id,
      user_id: userId ?? null,
      name: input.name,
      type: input.type,
      auth_method: "pat" as const,
      encrypted_token: encrypt(input.token, this.encryptionKey),
      installation_id: null,
      user_name: input.user_name ?? null,
      user_email: input.user_email ?? null,
      created_at: new Date().toISOString(),
    };
    await this.db.insert(schema.gitProviders).values(row);
    return this.mapRow(row, true);
  }

  async createFromOAuth(opts: {
    type: "github" | "gitlab" | "bitbucket";
    token: string;
    userName: string;
    userEmail?: string;
    userId: string;
  }): Promise<GitProvider> {
    const id = `git_${nanoid()}`;
    const row = {
      id,
      user_id: opts.userId,
      name: `${opts.type} (${opts.userName})`,
      type: opts.type,
      auth_method: "oauth" as const,
      encrypted_token: encrypt(opts.token, this.encryptionKey),
      installation_id: null,
      user_name: opts.userName,
      user_email: opts.userEmail ?? null,
      created_at: new Date().toISOString(),
    };
    await this.db.insert(schema.gitProviders).values(row);
    return this.mapRow(row, true);
  }

  /**
   * Create (or refresh) a GitHub App provider row from a completed installation.
   * Keyed on (userId, installationId): re-installing or re-running setup updates
   * the existing row rather than piling up duplicates. No token is stored —
   * `getWithSecret` mints one on demand from `installation_id`.
   */
  async createFromGitHubApp(opts: {
    installationId: string;
    accountLogin: string;
    userId: string;
    userEmail?: string;
  }): Promise<GitProvider> {
    const existing = await this.db
      .select()
      .from(schema.gitProviders)
      .where(
        and(
          eq(schema.gitProviders.user_id, opts.userId),
          eq(schema.gitProviders.installation_id, opts.installationId),
        ),
      );

    const name = `GitHub App (${opts.accountLogin})`;
    if (existing.length > 0) {
      await this.db
        .update(schema.gitProviders)
        .set({ name, user_name: opts.accountLogin, user_email: opts.userEmail ?? existing[0].user_email })
        .where(eq(schema.gitProviders.id, existing[0].id));
      return (await this.get(existing[0].id))!;
    }

    const id = `git_${nanoid()}`;
    const row = {
      id,
      user_id: opts.userId,
      name,
      type: "github" as const,
      auth_method: "github_app" as const,
      // No static secret for App installs; store an encrypted empty placeholder
      // to satisfy the NOT NULL column.
      encrypted_token: encrypt("", this.encryptionKey),
      installation_id: opts.installationId,
      user_name: opts.accountLogin,
      user_email: opts.userEmail ?? null,
      created_at: new Date().toISOString(),
    };
    await this.db.insert(schema.gitProviders).values(row);
    return this.mapRow(row, true);
  }

  async update(id: string, input: Partial<CreateGitProviderInput>): Promise<GitProvider | null> {
    const existing = await this.db.select().from(schema.gitProviders).where(eq(schema.gitProviders.id, id));
    if (existing.length === 0) return null;

    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.type !== undefined) updates.type = input.type;
    if (input.token !== undefined && input.token !== "••••••••") {
      updates.encrypted_token = encrypt(input.token, this.encryptionKey);
    }
    if (input.user_name !== undefined) updates.user_name = input.user_name || null;
    if (input.user_email !== undefined) updates.user_email = input.user_email || null;

    if (Object.keys(updates).length > 0) {
      await this.db.update(schema.gitProviders).set(updates).where(eq(schema.gitProviders.id, id));
    }

    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(schema.gitProviders).where(eq(schema.gitProviders.id, id)).returning();
    return result.length > 0;
  }

  private mapRow(row: typeof schema.gitProviders.$inferSelect, redact: boolean): GitProvider {
    const auth_method = (row.auth_method as GitProvider["auth_method"]) ?? "pat";
    // GitHub App rows carry no static token (it's minted in getWithSecret), so
    // never surface a "decrypted" placeholder for them.
    const token = auth_method === "github_app"
      ? undefined
      : redact ? "••••••••" : decrypt(row.encrypted_token, this.encryptionKey);
    return {
      id: row.id,
      name: row.name,
      type: row.type as GitProvider["type"],
      auth_method,
      token,
      installation_id: row.installation_id ?? undefined,
      user_name: row.user_name ?? undefined,
      user_email: row.user_email ?? undefined,
      created_at: row.created_at,
    };
  }
}
