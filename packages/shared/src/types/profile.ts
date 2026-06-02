export const PROFILE_PROVIDERS = ["api_key", "subscription_token", "ollama"] as const;
export type ProfileProvider = (typeof PROFILE_PROVIDERS)[number];

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
  auth_token?: string;
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
  resolved_auth_token?: string;
  resolved_provider: ProfileProvider;
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
