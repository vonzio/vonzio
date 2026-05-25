import { eq, or, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { encrypt, decrypt } from "../auth/crypto.js";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";

export interface GitProvider {
  id: string;
  name: string;
  type: "github" | "gitlab" | "bitbucket";
  auth_method: "pat" | "oauth";
  token?: string; // decrypted or redacted
  user_name?: string;
  user_email?: string;
  created_at: string;
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

  /** Get with decrypted token — for orchestrator internal use */
  async getWithSecret(id: string): Promise<GitProvider | null> {
    const rows = await this.db.select().from(schema.gitProviders).where(eq(schema.gitProviders.id, id));
    return rows.length > 0 ? this.mapRow(rows[0], false) : null;
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
      user_name: opts.userName,
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
    return {
      id: row.id,
      name: row.name,
      type: row.type as GitProvider["type"],
      auth_method: (row.auth_method as GitProvider["auth_method"]) ?? "pat",
      token: redact ? "••••••••" : decrypt(row.encrypted_token, this.encryptionKey),
      user_name: row.user_name ?? undefined,
      user_email: row.user_email ?? undefined,
      created_at: row.created_at,
    };
  }
}
