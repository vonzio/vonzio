export const PROFILE_PROVIDERS = ["api_key", "ollama", "openai", "claude_subscription", "openai_subscription"] as const;
export type ProfileProvider = (typeof PROFILE_PROVIDERS)[number];

/**
 * Canonical catalog of supported credential providers — the SINGLE source of
 * truth for the provider list and its UI metadata. Every place that lets a
 * user add/choose a key (the first-key modal, the onboarding wizard, the
 * Settings → keys editor) renders from this so a new provider is added once
 * here and shows up everywhere. Backend validation derives its enum from the
 * same list (PROFILE_PROVIDERS below).
 */
export interface ProviderInfo {
  /** UI discriminator used by the onboarding/settings forms. */
  kind: "anthropic_key" | "openai" | "ollama" | "anthropic_oauth" | "openai_oauth";
  /** The stored `provider` value on the credential / profile. */
  provider: ProfileProvider;
  /** Human label shown in pickers ("Anthropic API key"). */
  label: string;
  /** One-line helper under the picker. */
  hint: string;
  /** Field label above the key input ("Anthropic API key"). */
  fieldLabel: string;
  /** Input placeholder ("sk-ant-…"). */
  placeholder: string;
  /** Default name pre-filled for a new key of this kind. */
  defaultKeyName: string;
  /** Where to obtain a key (shown as a link); omitted when not applicable. */
  consoleUrl?: string;
  /** Expected key prefix, for the "Starts with …" hint; omitted when none. */
  keyPrefix?: string;
  /** Whether this provider accepts an OpenAI-compatible base URL override. */
  supportsBaseUrl: boolean;
  /** True for providers whose credential is obtained via an interactive OAuth
   *  device login rather than a pasted key/token — the paste-a-key forms hide
   *  these and a "Sign in" flow handles them instead. */
  oauthLogin?: boolean;
  /** Entitlement token required to see/use this provider, if any. Absent → shown
   *  to everyone. Present → only when the caller's entitlements include it. OSS
   *  self-host grants these by default; SaaS gates them (e.g. an admin allowlist
   *  for `subscription_oauth`). Enforced in the UI (hide) and, on SaaS, server-side. */
  entitlement?: string;
  /** A prominent caution shown above the credential field — used for providers
   *  whose subscription-token use now carries a terms-of-service/cost caveat
   *  (e.g. Anthropic prohibited third-party OAuth-token use in Feb 2026, and
   *  bills it per-token rather than against the plan). Omitted when none. */
  warning?: string;
}

export const PROVIDER_CATALOG: readonly ProviderInfo[] = [
  {
    kind: "anthropic_key",
    provider: "api_key",
    label: "Anthropic API key",
    hint: "From console.anthropic.com — starts with sk-ant-",
    fieldLabel: "Anthropic API key",
    placeholder: "sk-ant-…",
    defaultKeyName: "My Anthropic key",
    consoleUrl: "https://console.anthropic.com/settings/keys",
    keyPrefix: "sk-ant-",
    supportsBaseUrl: false,
  },
  {
    kind: "openai",
    provider: "openai",
    label: "OpenAI (or OpenAI-compatible)",
    hint: "From platform.openai.com — starts with sk-. Also Azure / OpenRouter / vLLM / LM Studio via a base URL.",
    fieldLabel: "OpenAI API key",
    placeholder: "sk-…",
    defaultKeyName: "My OpenAI key",
    consoleUrl: "https://platform.openai.com/api-keys",
    keyPrefix: "sk-",
    supportsBaseUrl: true,
  },
  {
    kind: "ollama",
    provider: "ollama",
    label: "Ollama Cloud API key",
    hint: "From ollama.com — paid tier required for now (local Ollama coming later)",
    fieldLabel: "Ollama API key",
    placeholder: "Paste Ollama Cloud key",
    defaultKeyName: "My Ollama Cloud key",
    consoleUrl: "https://ollama.com/settings/keys",
    supportsBaseUrl: false,
  },
  {
    kind: "anthropic_oauth",
    provider: "claude_subscription",
    label: "Claude subscription (Pro/Max)",
    hint: "Run `claude setup-token` locally and paste the sk-ant-oat01- token. Uses your own subscription.",
    fieldLabel: "Claude OAuth token",
    placeholder: "sk-ant-oat01-…",
    defaultKeyName: "My Claude subscription",
    consoleUrl: "https://code.claude.com/docs/en/authentication",
    keyPrefix: "sk-ant-oat01-",
    supportsBaseUrl: false,
    warning:
      "No guarantee Anthropic will keep honoring subscription tokens used outside its own apps.",
  },
  {
    kind: "openai_oauth",
    provider: "openai_subscription",
    label: "ChatGPT subscription (Plus/Pro)",
    hint: "Sign in with your ChatGPT account (Codex). Uses your own subscription instead of a metered API key.",
    fieldLabel: "ChatGPT account",
    placeholder: "",
    defaultKeyName: "My ChatGPT subscription",
    consoleUrl: "https://chatgpt.com",
    supportsBaseUrl: false,
    oauthLogin: true,
    entitlement: "subscription_oauth",
  },
] as const;

/** Look up a provider's metadata by its stored `provider` value. */
export function providerInfoByProvider(p: ProfileProvider): ProviderInfo {
  return PROVIDER_CATALOG.find((x) => x.provider === p) ?? PROVIDER_CATALOG[0];
}

export interface McpServerConfig {
  name: string;
  type: "sdk" | "stdio" | "http";
  /** SDK type: tool IDs to include */
  tools?: string[];
  /** Stdio type: command to run */
  command?: string;
  /** Stdio type: command arguments */
  args?: string[];
  /** Stdio/HTTP type: environment variables (may contain secrets — encrypted in DB) */
  env?: Record<string, string>;
  /** HTTP type: server URL */
  url?: string;
  /** HTTP type: request headers (may contain secrets — encrypted in DB) */
  headers?: Record<string, string>;
}

export interface RegistryConfig {
  url: string;
  username?: string;
  password?: string;
}

export const AGENT_MODELS = ["sonnet", "opus", "haiku", "inherit"] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];

export interface SubagentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  model?: AgentModel;
}

export interface AnthropicKey {
  id: string;
  user_id?: string | null;
  /**
   * When set, the key is materialized from an org_credential (SaaS
   * only). The user sees it in their list because they're a member of
   * the org, but it's owned by the org owner — read-only from the
   * user's perspective. OSS deployments leave this null.
   */
  org_id?: string | null;
  name: string;
  provider: ProfileProvider;
  api_key?: string;
  /**
   * Secondary secret, only for OAuth-subscription providers: the rotating
   * REFRESH token (the `api_key` field holds the short-lived access token).
   * Stored in `encrypted_auth_token`; returned only from with-secrets reads,
   * never in redacted listings. Undefined for key-based providers.
   */
  auth_token?: string;
  /**
   * OpenAI-compatible endpoint override (non-secret). Only meaningful for
   * `provider: "openai"` — lets a single instance mix OpenAI proper with
   * OpenRouter / Azure / vLLM / LM Studio per key. Null/undefined falls back
   * to the server-wide `OPENAI_BASE_URL` (default https://api.openai.com).
   */
  base_url?: string | null;
  allowed_user_ids: string[];
  created_at: string;
  last_used_at?: string;
}

export interface Profile {
  id: string;
  name: string;
  slug: string;
  api_key_id: string;
  default_tools: string[];
  default_egress_domains: string[];
  mcp_servers: McpServerConfig[];
  agent_ids: string[];
  skill_ids: string[];
  /** Opt-in platform-MCP capability groups this agent may use beyond the
   *  default-on set. Gated/sensitive tools (e.g. deleting workspaces) only
   *  appear in the agent's platform toolset when their group is listed here.
   *  See PLATFORM_CAPABILITY_GROUPS. */
  platform_capabilities: string[];
  claude_md?: string;
  git_provider_id?: string; // deprecated
  git_provider_ids: string[];
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  container_image?: string;
  container_registry?: RegistryConfig;
  setup_commands: string[];
  persistent_sessions: boolean;
  /** Feature 0001: allow this profile's workspaces to run a nested docker daemon
   *  (build images, `docker compose` dev stacks). Effective only when the host
   *  sets DOCKER_ACCESS_MODE; forces allow-all egress for those workspaces. */
  docker_access: boolean;
  /** Feature 0041: per-profile memory ceiling (Docker memory string, e.g. "6g").
   *  Undefined → the global session default; capped at CONTAINER_MEMORY_LIMIT_MAX. */
  memory_limit?: string;
  memory_enabled: boolean;
  max_turns?: number;
  auto_continue: boolean;
  max_continuations: number;
  continuation_budget_usd?: number;
  concurrency_limit: number;
  user_id?: string | null;
  /** The user's default agent — preselected in the new-chat picker and used
   *  for new conversations. At most one per user. */
  is_default: boolean;
  /**
   * SaaS-only flag. `true` when the row is a per-member materialization
   * of an org_profile (team-shared agent). Dashboard uses this to
   * segment "Your agents" vs "Team agents" and hide the edit/delete
   * affordances. Server enforces read-only via 403 on PATCH/DELETE;
   * the flag just stops the UI from offering the action. Undefined on
   * OSS / personal rows.
   */
  team_owned?: boolean;
  created_at: string;
  last_used_at?: string;
}

/**
 * Catalog of OPT-IN platform-MCP capability groups (Bucket B). The default-on
 * tools (introspection + the originally-shipped writes) carry no group and are
 * always available; only the powerful/destructive groups below are gated behind
 * an explicit per-agent opt-in stored in `profile.platform_capabilities`.
 * Single source of truth shared by the server (tool filtering) and the dashboard
 * (the per-agent toggle UI). The `group` strings must match the tool defs.
 */
export interface PlatformCapabilityGroup {
  group: string;
  label: string;
  description: string;
}

export const PLATFORM_CAPABILITY_GROUPS: readonly PlatformCapabilityGroup[] = [
  {
    group: "workspace_destructive",
    label: "Delete workspaces",
    description: "Let this agent permanently delete workspaces (tears down the container and drops the conversation).",
  },
  {
    group: "profiles_write",
    label: "Manage agents",
    description: "Let this agent create, edit, and delete agents (profiles) — including changing its own configuration.",
  },
  {
    group: "preview_access",
    label: "Change preview exposure",
    description: "Let this agent make a workspace's web service publicly reachable (public, or public-with-code). Off by default — turn on only if you want agents to expose ports to the internet.",
  },
] as const;

/** Profile joined with its API key credentials — used by orchestrator only */
export interface ResolvedProfile extends Profile {
  resolved_api_key?: string;
  resolved_provider: ProfileProvider;
  /** OpenAI-compatible base URL from the resolved key (openai provider only). */
  resolved_base_url?: string;
}

export interface CallerKey {
  id: string;
  name: string;
  key_hash: string;
  allowed_profile_ids: string[];
  rate_limit_rpm: number;
  created_at: string;
  last_used_at?: string;
}
