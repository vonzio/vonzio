import { eq, or, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { encrypt, decrypt } from "../auth/crypto.js";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";
import type { Profile, ResolvedProfile, McpServerConfig, RegistryConfig, ProfileProvider } from "@vonzio/shared";
import type { ApiKeyService } from "./api-key-service.js";
import { slugify, isValidSlug, resolveCollision } from "./slug.js";
import { ValidationError } from "../errors.js";

export interface CreateProfileInput {
  name: string;
  slug?: string;
  /**
   * Provider override. Defaults to "api_key" (and requires api_key_id).
   * Set to "ollama" to create a key-less profile for Ollama Cloud — used
   * by the OSS onboarding wizard when the user picks Ollama instead of
   * an Anthropic credential. The orchestrator/model resolver handles the
   * branch on provider at runtime.
   */
  provider?: ProfileProvider;
  api_key_id?: string;
  default_tools?: string[];
  default_egress_domains?: string[];
  mcp_servers?: McpServerConfig[];
  agent_ids?: string[];
  skill_ids?: string[];
  claude_md?: string;
  git_provider_id?: string; // deprecated — single provider
  git_provider_ids?: string[];
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  container_image?: string;
  container_registry?: RegistryConfig;
  setup_commands?: string[];
  persistent_sessions?: boolean;
  memory_enabled?: boolean;
  max_turns?: number | null;
  auto_continue?: boolean;
  max_continuations?: number;
  continuation_budget_usd?: number | null;
  concurrency_limit?: number;
}

export class ProfileService {
  constructor(
    private db: DrizzleDB,
    private encryptionKey: string,
    private apiKeyService?: ApiKeyService,
  ) {}

  /** Pick a slug for a profile, validating user-provided ones and resolving collisions for auto-generated ones */
  private async resolveSlug(
    input: { slug?: string; name: string },
    userId: string | null,
    excludeProfileId?: string,
  ): Promise<string> {
    const rows = await this.db.select({ id: schema.profiles.id, slug: schema.profiles.slug })
      .from(schema.profiles)
      .where(userId ? eq(schema.profiles.user_id, userId) : isNull(schema.profiles.user_id));
    const taken = new Set(rows.filter((r) => r.id !== excludeProfileId).map((r) => r.slug));

    if (input.slug !== undefined && input.slug !== "") {
      if (!isValidSlug(input.slug)) {
        throw new ValidationError("Slug must be lowercase letters, digits, and hyphens, max 64 chars (e.g. 'my-coder')");
      }
      if (taken.has(input.slug)) {
        throw new ValidationError(`Slug "${input.slug}" is already used by another of your agents`);
      }
      return input.slug;
    }

    return resolveCollision(slugify(input.name), taken);
  }

  /** Verify the user can access the given API key */
  private async validateApiKeyAccess(apiKeyId: string | null | undefined, userId: string | null | undefined, userRole?: string): Promise<void> {
    if (!apiKeyId || !userId || !this.apiKeyService) return;
    const accessible = await this.apiKeyService.list(userId, userRole);
    if (!accessible.some((k) => k.id === apiKeyId)) {
      throw new Error("API key not accessible to this user");
    }
  }

  async create(input: CreateProfileInput, userId?: string, userRole?: string): Promise<Profile> {
    const id = `prof_${nanoid()}`;
    const now = new Date().toISOString();

    // Use specified key, or leave null (user must configure manually)
    const apiKeyId = input.api_key_id ?? null;

    // Validate that the user can access the specified key
    await this.validateApiKeyAccess(apiKeyId, userId ?? null, userRole);

    const slug = await this.resolveSlug({ slug: input.slug, name: input.name }, userId ?? null);

    const row = {
      id,
      user_id: userId ?? null,
      name: input.name,
      slug,
      provider: input.provider ?? "api_key",
      api_key_id: apiKeyId ?? null,
      default_tools: input.default_tools ?? [],
      default_egress_domains: input.default_egress_domains ?? [],
      mcp_servers: this.encryptMcpServers(input.mcp_servers ?? []),
      agent_ids: input.agent_ids ?? [],
      skill_ids: input.skill_ids ?? [],
      claude_md: input.claude_md ?? null,
      git_provider_id: input.git_provider_id ?? (input.git_provider_ids?.[0] ?? null),
      git_provider_ids: input.git_provider_ids ?? (input.git_provider_id ? [input.git_provider_id] : []),
      model: input.model ?? null,
      effort: input.effort ?? null,
      container_image: input.container_image ?? null,
      container_registry: input.container_registry ? this.encryptRegistry(input.container_registry) : null,
      setup_commands: input.setup_commands ?? [],
      persistent_sessions: input.persistent_sessions ?? true,
      concurrency_limit: input.concurrency_limit ?? 5,
      memory_enabled: true,
      max_turns: input.max_turns ?? null,
      auto_continue: input.auto_continue ?? false,
      max_continuations: input.max_continuations ?? 5,
      continuation_budget_usd: input.continuation_budget_usd ?? null,
      created_at: now,
      last_used_at: null,
    };

    await this.db.insert(schema.profiles).values(row);
    return this.mapRow(row, true);
  }

  async get(id: string): Promise<Profile | null> {
    const rows = await this.db.select().from(schema.profiles).where(eq(schema.profiles.id, id));
    if (rows.length === 0) return null;
    return this.mapRow(rows[0], true);
  }

  /** Get profile with decrypted MCP/registry secrets (no API key — use getResolved for that) */
  async getWithSecrets(id: string): Promise<Profile | null> {
    const rows = await this.db.select().from(schema.profiles).where(eq(schema.profiles.id, id));
    if (rows.length === 0) return null;
    return this.mapRow(rows[0], false);
  }

  /** Get profile joined with its API key credentials — for orchestrator use */
  async getResolved(id: string): Promise<ResolvedProfile | null> {
    const profile = await this.getWithSecrets(id);
    if (!profile) return null;

    let resolvedApiKey: string | undefined;
    let resolvedAuthToken: string | undefined;
    let resolvedProvider: ProfileProvider = "api_key";

    if (this.apiKeyService && profile.api_key_id) {
      const apiKey = await this.apiKeyService.getWithSecrets(profile.api_key_id);

      if (apiKey) {
        resolvedApiKey = apiKey.api_key;
        resolvedAuthToken = apiKey.auth_token;
        resolvedProvider = apiKey.provider;
      }
    }

    return {
      ...profile,
      resolved_api_key: resolvedApiKey,
      resolved_auth_token: resolvedAuthToken,
      resolved_provider: resolvedProvider,
    };
  }

  async list(userId?: string): Promise<Profile[]> {
    const query = this.db.select().from(schema.profiles);
    if (userId) {
      const rows = await query.where(
        or(eq(schema.profiles.user_id, userId), isNull(schema.profiles.user_id)),
      );
      return rows.map((r) => this.mapRow(r, true));
    }
    const rows = await query;
    return rows.map((r) => this.mapRow(r, true));
  }

  async update(id: string, input: Partial<CreateProfileInput>, userRole?: string): Promise<Profile | null> {
    const existing = await this.db.select().from(schema.profiles).where(eq(schema.profiles.id, id));
    if (existing.length === 0) return null;

    // Validate that the profile's owner can access the new key
    if (input.api_key_id !== undefined) {
      await this.validateApiKeyAccess(input.api_key_id || null, existing[0].user_id, userRole);
    }

    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.slug !== undefined && input.slug !== existing[0].slug) {
      updates.slug = await this.resolveSlug(
        { slug: input.slug, name: input.name ?? existing[0].name },
        existing[0].user_id,
        id,
      );
    }
    if (input.api_key_id !== undefined) updates.api_key_id = input.api_key_id || null;
    if (input.default_tools !== undefined) updates.default_tools = input.default_tools;
    if (input.default_egress_domains !== undefined) updates.default_egress_domains = input.default_egress_domains;
    if (input.mcp_servers !== undefined) updates.mcp_servers = this.encryptMcpServers(input.mcp_servers, existing[0].mcp_servers);
    if (input.agent_ids !== undefined) updates.agent_ids = input.agent_ids;
    if (input.skill_ids !== undefined) updates.skill_ids = input.skill_ids;
    if (input.claude_md !== undefined) updates.claude_md = input.claude_md || null;
    if (input.git_provider_ids !== undefined) {
      updates.git_provider_ids = input.git_provider_ids;
      updates.git_provider_id = input.git_provider_ids[0] ?? null;
    } else if (input.git_provider_id !== undefined) {
      updates.git_provider_id = input.git_provider_id || null;
      updates.git_provider_ids = input.git_provider_id ? [input.git_provider_id] : [];
    }
    if (input.model !== undefined) updates.model = input.model || null;
    if (input.effort !== undefined) updates.effort = input.effort || null;
    if (input.container_image !== undefined) updates.container_image = input.container_image || null;
    if (input.container_registry !== undefined) {
      updates.container_registry = input.container_registry
        ? this.encryptRegistry(input.container_registry, existing[0].container_registry)
        : null;
    }
    if (input.setup_commands !== undefined) updates.setup_commands = input.setup_commands;
    if (input.persistent_sessions !== undefined) updates.persistent_sessions = input.persistent_sessions;
    if (input.memory_enabled !== undefined) updates.memory_enabled = input.memory_enabled;
    if (input.max_turns !== undefined) updates.max_turns = input.max_turns;
    if (input.auto_continue !== undefined) updates.auto_continue = input.auto_continue;
    if (input.max_continuations !== undefined) updates.max_continuations = input.max_continuations;
    if (input.continuation_budget_usd !== undefined) updates.continuation_budget_usd = input.continuation_budget_usd;
    if (input.concurrency_limit !== undefined) updates.concurrency_limit = input.concurrency_limit;

    if (Object.keys(updates).length > 0) {
      await this.db.update(schema.profiles).set(updates).where(eq(schema.profiles.id, id));
    }

    return this.get(id);
  }

  async delete(id: string): Promise<{ deleted: boolean; error?: string }> {
    const result = await this.db.delete(schema.profiles).where(eq(schema.profiles.id, id)).returning();
    return { deleted: result.length > 0 };
  }

  // ─── MCP Server encryption ───────────────────────────────────────

  private encryptMcpServers(servers: McpServerConfig[], existingEncrypted?: McpServerConfig[]): McpServerConfig[] {
    return servers.map((s, idx) => {
      const existing = existingEncrypted?.find((e) => e.name === s.name) ?? existingEncrypted?.[idx];
      return {
        ...s,
        env: s.env ? this.encryptRecordPreserving(s.env, existing?.env) : undefined,
        headers: s.headers ? this.encryptRecordPreserving(s.headers, existing?.headers) : undefined,
      };
    });
  }

  private decryptMcpServers(servers: McpServerConfig[]): McpServerConfig[] {
    return servers.map((s) => ({
      ...s,
      env: s.env ? this.decryptRecord(s.env) : undefined,
      headers: s.headers ? this.decryptRecord(s.headers) : undefined,
    }));
  }

  private redactMcpServers(servers: McpServerConfig[]): McpServerConfig[] {
    return servers.map((s) => ({
      ...s,
      env: s.env ? Object.fromEntries(Object.keys(s.env).map((k) => [k, "••••••••"])) : undefined,
      headers: s.headers ? Object.fromEntries(Object.keys(s.headers).map((k) => [k, "••••••••"])) : undefined,
    }));
  }

  // ─── Registry encryption ─────────────────────────────────────────

  private encryptRegistry(reg: RegistryConfig, existing?: RegistryConfig | null): RegistryConfig {
    let password = reg.password;
    if ((!password || password === "••••••••") && existing?.password) {
      return { ...reg, password: existing.password };
    }
    return { ...reg, password: password ? encrypt(password, this.encryptionKey) : undefined };
  }

  private decryptRegistry(reg: RegistryConfig): RegistryConfig {
    return { ...reg, password: reg.password ? decrypt(reg.password, this.encryptionKey) : undefined };
  }

  private redactRegistry(reg: RegistryConfig): RegistryConfig {
    return { url: reg.url, username: reg.username, password: reg.password ? "••••••••" : undefined };
  }

  // ─── Generic record encryption ───────────────────────────────────

  private encryptRecordPreserving(record: Record<string, string>, existing?: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(record).map(([k, v]) => {
        if (v === "••••••••" && existing?.[k]) return [k, existing[k]];
        return [k, encrypt(v, this.encryptionKey)];
      }),
    );
  }

  private decryptRecord(record: Record<string, string>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(record).map(([k, v]) => {
        try { return [k, decrypt(v, this.encryptionKey)]; }
        catch { return [k, v]; }
      }),
    );
  }

  // ─── Row mapping ─────────────────────────────────────────────────

  private mapRow(
    row: typeof schema.profiles.$inferSelect,
    redact: boolean,
  ): Profile {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      api_key_id: row.api_key_id ?? "",
      default_tools: row.default_tools,
      default_egress_domains: row.default_egress_domains,
      mcp_servers: redact ? this.redactMcpServers(row.mcp_servers) : this.decryptMcpServers(row.mcp_servers),
      agent_ids: row.agent_ids,
      skill_ids: row.skill_ids,
      claude_md: row.claude_md ?? undefined,
      git_provider_id: row.git_provider_id ?? undefined,
      git_provider_ids: row.git_provider_ids ?? [],
      model: row.model ?? undefined,
      effort: (row.effort as Profile["effort"]) ?? undefined,
      container_image: row.container_image ?? undefined,
      container_registry: row.container_registry
        ? (redact ? this.redactRegistry(row.container_registry) : this.decryptRegistry(row.container_registry))
        : undefined,
      setup_commands: row.setup_commands,
      persistent_sessions: row.persistent_sessions,
      memory_enabled: row.memory_enabled,
      max_turns: row.max_turns ?? undefined,
      auto_continue: row.auto_continue,
      max_continuations: row.max_continuations,
      continuation_budget_usd: row.continuation_budget_usd ?? undefined,
      concurrency_limit: row.concurrency_limit,
      user_id: row.user_id,
      created_at: row.created_at,
      last_used_at: row.last_used_at ?? undefined,
    };
  }
}
