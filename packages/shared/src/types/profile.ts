export const PROFILE_PROVIDERS = ["api_key", "ollama", "openai", "claude_subscription"] as const;
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
  kind: "anthropic_key" | "openai" | "ollama" | "anthropic_oauth";
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
  claude_md?: string;
  git_provider_id?: string; // deprecated
  git_provider_ids: string[];
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  container_image?: string;
  container_registry?: RegistryConfig;
  setup_commands: string[];
  persistent_sessions: boolean;
  memory_enabled: boolean;
  max_turns?: number;
  auto_continue: boolean;
  max_continuations: number;
  continuation_budget_usd?: number;
  concurrency_limit: number;
  user_id?: string | null;
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
