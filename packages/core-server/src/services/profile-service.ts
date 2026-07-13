import { eq, or, isNull, and, desc, asc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { encrypt, decrypt } from "../auth/crypto.js";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";
import type { Profile, ResolvedProfile, McpServerConfig, RegistryConfig, ProfileProvider } from "@vonzio/shared";
import type { ApiKeyService } from "./api-key-service.js";
import { slugify, isValidSlug, resolveCollision } from "./slug.js";
import { ValidationError } from "../errors.js";
import { parseMemory } from "../container/docker-manager.js";

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
  platform_capabilities?: string[];
  claude_md?: string;
  git_provider_id?: string; // deprecated — single provider
  git_provider_ids?: string[];
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  container_image?: string;
  container_registry?: RegistryConfig;
  setup_commands?: string[];
  persistent_sessions?: boolean;
  docker_access?: boolean;
  memory_limit?: string | null;
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
    /** Feature 0041: max a profile's memory_limit may request (Docker memory
     *  string, e.g. "16g"). Undefined = no ceiling enforced here. */
    private maxMemoryLimit?: string,
  ) {}

  // Resolves a default model id for a key (first available from the provider).
  // Injected post-construction because the model-list service depends on this
  // service (would be circular in the constructor).
  private defaultModelResolver?: (apiKeyId: string) => Promise<string | null>;
  setDefaultModelResolver(fn: (apiKeyId: string) => Promise<string | null>): void {
    this.defaultModelResolver = fn;
  }

  /** When a key is attached but no model is chosen, pick a provider-appropriate
   *  default. Only for ollama/openai — an empty model on those resolves to a
   *  Claude id at run time and fails ("model … may not exist"). Anthropic keeps
   *  an empty model (the SDK picks a valid Claude default). */
  private async pickDefaultModel(model: string | null, apiKeyId: string | null): Promise<string | null> {
    if (model || !apiKeyId || !this.defaultModelResolver || !this.apiKeyService) return model;
    const key = await this.apiKeyService.get(apiKeyId);
    if (!key || (key.provider !== "ollama" && key.provider !== "openai")) return model;
    return (await this.defaultModelResolver(apiKeyId)) ?? null;
  }

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

  /** Enabling docker_access (feature 0001) gives a workspace a nested docker
   *  daemon, which voids the egress/VPN guarantees — and, in dind-privileged
   *  mode, container confinement. It is a host-security-relevant capability, so
   *  only admins may turn it on; SaaS layers plan-gating on top in cp-server.
   *  Disabling it (or leaving it unset) is always allowed. */
  private assertDockerAccessAllowed(dockerAccess: boolean | undefined, userRole?: string): void {
    if (dockerAccess === true && userRole !== "admin") {
      throw new ValidationError("docker_access can only be enabled by an administrator");
    }
  }

  /** Feature 0041: a per-profile memory_limit may not exceed the configured max
   *  (validation.ts already checks the Docker-memory FORMAT; this enforces the
   *  ceiling). Null/undefined = keep the global default. */
  private assertMemoryLimitAllowed(memoryLimit: string | null | undefined): void {
    if (!memoryLimit || !this.maxMemoryLimit) return;
    if (parseMemory(memoryLimit) > parseMemory(this.maxMemoryLimit)) {
      throw new ValidationError(`memory_limit ${memoryLimit} exceeds the maximum ${this.maxMemoryLimit}`);
    }
  }

  async create(input: CreateProfileInput, userId?: string, userRole?: string): Promise<Profile> {
    this.assertDockerAccessAllowed(input.docker_access, userRole);
    this.assertMemoryLimitAllowed(input.memory_limit);
    const id = `prof_${nanoid()}`;
    const now = new Date().toISOString();

    // Use specified key, or leave null (user must configure manually)
    const apiKeyId = input.api_key_id ?? null;

    // Validate that the user can access the specified key
    await this.validateApiKeyAccess(apiKeyId, userId ?? null, userRole);

    const slug = await this.resolveSlug({ slug: input.slug, name: input.name }, userId ?? null);

    // First agent a user owns becomes their default, so the new-chat picker
    // always has one preselected. Subsequent agents are non-default until the
    // user picks one. Shared rows (no userId) are never auto-defaulted.
    let isDefault = false;
    if (userId) {
      const existingDefault = await this.db
        .select({ id: schema.profiles.id })
        .from(schema.profiles)
        .where(and(eq(schema.profiles.user_id, userId), eq(schema.profiles.is_default, true)))
        .limit(1);
      isDefault = existingDefault.length === 0;
    }

    // Auto-pick a model for ollama/openai keys when none was specified, so the
    // agent is immediately runnable (covers onboarding's auto-created agent).
    const model = await this.pickDefaultModel(input.model ?? null, apiKeyId);

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
      platform_capabilities: input.platform_capabilities ?? [],
      claude_md: input.claude_md ?? null,
      git_provider_id: input.git_provider_id ?? (input.git_provider_ids?.[0] ?? null),
      git_provider_ids: input.git_provider_ids ?? (input.git_provider_id ? [input.git_provider_id] : []),
      model,
      effort: input.effort ?? null,
      container_image: input.container_image ?? null,
      container_registry: input.container_registry ? this.encryptRegistry(input.container_registry) : null,
      setup_commands: input.setup_commands ?? [],
      persistent_sessions: input.persistent_sessions ?? true,
      docker_access: input.docker_access ?? false,
      memory_limit: input.memory_limit ?? null,
      concurrency_limit: input.concurrency_limit ?? 5,
      memory_enabled: true,
      max_turns: input.max_turns ?? null,
      auto_continue: input.auto_continue ?? false,
      max_continuations: input.max_continuations ?? 5,
      continuation_budget_usd: input.continuation_budget_usd ?? null,
      is_default: isDefault,
      created_at: now,
      last_used_at: null,
    };

    await this.db.insert(schema.profiles).values(row);
    return this.mapRow(row, true);
  }

  /** Mark `id` as the user's default agent, clearing the flag on their other
   *  agents (at most one default per user). Returns false if the profile
   *  doesn't exist or isn't owned by the user. */
  async setDefault(id: string, userId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ user_id: schema.profiles.user_id })
        .from(schema.profiles)
        .where(eq(schema.profiles.id, id));
      if (rows.length === 0 || rows[0].user_id !== userId) return false;
      await tx
        .update(schema.profiles)
        .set({ is_default: false })
        .where(and(eq(schema.profiles.user_id, userId), eq(schema.profiles.is_default, true)));
      await tx
        .update(schema.profiles)
        .set({ is_default: true })
        .where(eq(schema.profiles.id, id));
      return true;
    });
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

  /** Get profile joined with its API key credentials — for orchestrator use.
   *  `opts.apiKeyIdOverride` resolves the credential from a different key than
   *  the profile's attached one (cross-key model selection) — the rest of the
   *  profile (tools, prompt, MCP) is unchanged. Falls back to the profile's
   *  key if the override is missing/inaccessible. */
  async getResolved(id: string, opts?: { apiKeyIdOverride?: string | null }): Promise<ResolvedProfile | null> {
    const profile = await this.getWithSecrets(id);
    if (!profile) return null;

    let resolvedApiKey: string | undefined;
    let resolvedProvider: ProfileProvider = "api_key";
    let resolvedBaseUrl: string | undefined;

    const effectiveKeyId = opts?.apiKeyIdOverride || profile.api_key_id;
    if (this.apiKeyService && effectiveKeyId) {
      let apiKey = await this.apiKeyService.getWithSecrets(effectiveKeyId);
      // Override key vanished (deleted/revoked) — fall back to the profile's
      // own key so a stale per-conversation override doesn't leave the agent
      // with no credential.
      if (!apiKey && opts?.apiKeyIdOverride && profile.api_key_id && profile.api_key_id !== effectiveKeyId) {
        apiKey = await this.apiKeyService.getWithSecrets(profile.api_key_id);
      }

      if (apiKey) {
        resolvedApiKey = apiKey.api_key;
        resolvedProvider = apiKey.provider;
        resolvedBaseUrl = apiKey.base_url ?? undefined;

        // OAuth-subscription refresh-before-use: the stored access token is
        // short-lived; if it's near expiry, rotate it with the (single-use)
        // refresh token and persist the new pair before the turn runs. A
        // refresh failure is non-fatal here — fall through with the existing
        // token so the actual model call surfaces the auth error to the user.
        if (apiKey.provider === "openai_subscription" && apiKey.api_key && apiKey.auth_token) {
          const { expiryFromAccessToken, needsRefresh, refreshTokens } = await import("./codex-oauth-service.js");
          if (needsRefresh({ expiresAt: expiryFromAccessToken(apiKey.api_key) })) {
            try {
              const rotated = await refreshTokens(apiKey.auth_token);
              await this.apiKeyService.rotateSubscriptionTokens(effectiveKeyId, rotated.accessToken, rotated.refreshToken);
              resolvedApiKey = rotated.accessToken;
            } catch {
              /* keep the existing (possibly expired) token; the call will 401 */
            }
          }
        }
      }
    }

    return {
      ...profile,
      resolved_api_key: resolvedApiKey,
      resolved_provider: resolvedProvider,
      resolved_base_url: resolvedBaseUrl,
    };
  }

  async list(userId?: string): Promise<Profile[]> {
    // Default agent first (preselected everywhere — home picker, chat surfaces,
    // the `profiles[0]` fallback), then oldest-first for a stable order.
    const order = [desc(schema.profiles.is_default), asc(schema.profiles.created_at)];
    const query = this.db.select().from(schema.profiles);
    if (userId) {
      const rows = await query
        .where(or(eq(schema.profiles.user_id, userId), isNull(schema.profiles.user_id)))
        .orderBy(...order);
      return rows.map((r) => this.mapRow(r, true));
    }
    const rows = await query.orderBy(...order);
    return rows.map((r) => this.mapRow(r, true));
  }

  async update(id: string, input: Partial<CreateProfileInput>, userRole?: string): Promise<Profile | null> {
    this.assertDockerAccessAllowed(input.docker_access, userRole);
    this.assertMemoryLimitAllowed(input.memory_limit);
    const existing = await this.db.select().from(schema.profiles).where(eq(schema.profiles.id, id));
    if (existing.length === 0) return null;

    // Validate key access only when the key actually CHANGES. Re-validating an
    // unchanged key broke editing any field (e.g. egress) on profiles whose key
    // is grandfathered/backfilled (e.g. an org_system_backfill key the user
    // doesn't directly "own") — an unrelated edit would 500. The key was valid
    // when set; only a change needs re-checking.
    const updates: Record<string, unknown> = {};
    if (input.api_key_id !== undefined && (input.api_key_id || null) !== (existing[0].api_key_id ?? null)) {
      await this.validateApiKeyAccess(input.api_key_id || null, existing[0].user_id, userRole);
      // On a key change, a model that belonged to the old key's provider can be
      // stale (e.g. a claude-* model left on a now-Ollama agent). When the
      // caller isn't explicitly setting a model, re-pick if the agent is
      // model-less OR the provider changed: ollama/openai → a real default,
      // anthropic / no key → null (the SDK picks a valid Claude default). This
      // keeps profile.model from ever mismatching the linked key.
      if (input.model === undefined && this.apiKeyService) {
        const oldProvider = existing[0].api_key_id ? (await this.apiKeyService.get(existing[0].api_key_id))?.provider : undefined;
        const newProvider = input.api_key_id ? (await this.apiKeyService.get(input.api_key_id))?.provider : undefined;
        if (!existing[0].model || oldProvider !== newProvider) {
          updates.model = input.api_key_id ? await this.pickDefaultModel(null, input.api_key_id) : null;
        }
      }
    }
    if (input.name !== undefined) updates.name = input.name;
    if (input.slug !== undefined && input.slug !== existing[0].slug) {
      updates.slug = await this.resolveSlug(
        { slug: input.slug, name: input.name ?? existing[0].name },
        existing[0].user_id,
        id,
      );
    }
    if (input.api_key_id !== undefined) updates.api_key_id = input.api_key_id || null;
    // Keep the profile.provider column in sync with the linked key. Without
    // this, changing the API key (e.g. Ollama → Anthropic) leaves a stale
    // provider that can mislead anything reading the column directly.
    if (input.provider !== undefined) {
      updates.provider = input.provider;
    } else if (input.api_key_id && this.apiKeyService) {
      const key = await this.apiKeyService.get(input.api_key_id);
      if (key?.provider) updates.provider = key.provider;
    }
    if (input.default_tools !== undefined) updates.default_tools = input.default_tools;
    if (input.default_egress_domains !== undefined) updates.default_egress_domains = input.default_egress_domains;
    if (input.mcp_servers !== undefined) updates.mcp_servers = this.encryptMcpServers(input.mcp_servers, existing[0].mcp_servers);
    if (input.agent_ids !== undefined) updates.agent_ids = input.agent_ids;
    if (input.skill_ids !== undefined) updates.skill_ids = input.skill_ids;
    if (input.platform_capabilities !== undefined) updates.platform_capabilities = input.platform_capabilities;
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
    // docker_access (like egress/VPN) is baked into the container at creation:
    // toggling it here only affects containers created AFTER this update. A live
    // persistent session keeps its current confinement until it is restarted
    // (recreated). Operators must restart the workspace for a toggle to apply.
    if (input.docker_access !== undefined) updates.docker_access = input.docker_access;
    if (input.memory_limit !== undefined) updates.memory_limit = input.memory_limit || null;
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
      platform_capabilities: row.platform_capabilities ?? [],
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
      docker_access: row.docker_access,
      memory_limit: row.memory_limit ?? undefined,
      memory_enabled: row.memory_enabled,
      max_turns: row.max_turns ?? undefined,
      auto_continue: row.auto_continue,
      max_continuations: row.max_continuations,
      continuation_budget_usd: row.continuation_budget_usd ?? undefined,
      concurrency_limit: row.concurrency_limit,
      user_id: row.user_id,
      is_default: row.is_default,
      created_at: row.created_at,
      last_used_at: row.last_used_at ?? undefined,
    };
  }
}
