const BASE = "/v1";

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = { ...options.headers as Record<string, string> };
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: "include",
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? "Request failed");
  }

  return res.json();
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// --- Tasks ---

export interface TaskResult {
  text: string;
  tool_calls: { tool: string; input: Record<string, unknown>; output: string; timestamp: string }[];
  session_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  turns: number;
}

export interface TaskSummary {
  id: string;
  mode: string;
  status: string;
  prompt: string;
  profile_id: string;
  session_id?: string;
  allowed_tools?: string[];
  egress_domains?: string[];
  claude_md?: string;
  priority: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  cancelled_at?: string;
  attempt: number;
  result?: TaskResult;
  error?: string;
}

export interface TaskListResponse {
  tasks: TaskSummary[];
  total: number;
}

export function fetchTasks(params?: {
  status?: string;
  mode?: string;
  page?: number;
  limit?: number;
}): Promise<TaskListResponse> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.mode) qs.set("mode", params.mode);
  if (params?.page) qs.set("page", String(params.page));
  if (params?.limit) qs.set("limit", String(params.limit));
  const query = qs.toString();
  return request(`/tasks${query ? `?${query}` : ""}`);
}

export function fetchTask(id: string): Promise<TaskSummary> {
  return request(`/tasks/${id}`);
}

export function cancelTask(id: string): Promise<{ status: string }> {
  return request(`/tasks/${id}`, { method: "DELETE" });
}

export function createTask(body: Record<string, unknown>): Promise<{ task_id: string; status: string; created_at: string }> {
  return request("/tasks", { method: "POST", body: JSON.stringify(body) });
}

// --- Workspaces ---

export interface WorkspaceSummary {
  session_id: string;
  container_id: string | null;
  user_id: string;
  profile_id: string;
  name: string | null;
  starred: boolean;
  pinned: boolean;
  tags: string[];
  archived: boolean;
  persistent: boolean;
  public_preview: boolean;
  status: string;
  last_active_at: string;
  created_at: string;
  expires_at: string;
  model_override: string | null;
  /** Set by core-server when the agent is routed through a SaaS VPN
   *  tunnel; absent/null otherwise. Drives the "VPN: <name>" pill in
   *  the workspace header. */
  attached_tunnel?: { id: string; name: string } | null;
}

export interface WorkspaceListResponse {
  workspaces: WorkspaceSummary[];
  total: number;
}

export function fetchWorkspaces(params?: { status?: string }): Promise<WorkspaceListResponse> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  const query = qs.toString();
  return request(`/workspaces${query ? `?${query}` : ""}`);
}

export function fetchWorkspace(id: string): Promise<WorkspaceSummary> {
  return request(`/workspaces/${id}`);
}

export function deleteWorkspace(id: string): Promise<{ status: string }> {
  return request(`/workspaces/${id}`, { method: "DELETE" });
}

export function updateWorkspace(
  id: string,
  fields: { name?: string; starred?: boolean; pinned?: boolean; archived?: boolean; tags?: string[]; public_preview?: boolean; model_override?: string | null },
): Promise<WorkspaceSummary> {
  return request(`/workspaces/${id}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
}

export interface SessionEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  ts: number;
}

export function fetchWorkspaceEvents(id: string): Promise<SessionEvent[]> {
  return request(`/workspaces/${id}/events`);
}

export interface FileEntry {
  name: string;
  size: number;
  type: "file" | "directory";
}

export function fetchWorkspaceFiles(
  workspaceId: string,
  path = "/workspace/",
): Promise<{ files: FileEntry[]; path: string }> {
  return request(`/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`);
}

export function workspaceArchiveUrl(workspaceId: string, paths: string[], name?: string): string {
  const qs = paths.map((p) => `paths=${encodeURIComponent(p)}`).join("&");
  const named = name ? `&name=${encodeURIComponent(name)}` : "";
  return `/v1/workspaces/${workspaceId}/archive?${qs}${named}`;
}

export async function uploadFiles(workspaceId: string, files: File[]): Promise<{ uploaded: { name: string; size: number }[] }> {
  const formData = new FormData();
  for (const file of files) {
    formData.append("file", file);
  }
  const res = await fetch(`/v1/workspaces/${workspaceId}/upload`, {
    method: "POST",
    credentials: "include",
    body: formData,
    // No Content-Type header — browser sets it with boundary for multipart
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Upload failed: ${res.status}`);
  }
  return res.json();
}

export async function deleteFile(workspaceId: string, path: string): Promise<{ deleted: boolean }> {
  const res = await fetch(`${BASE}/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? "Delete failed");
  }
  return res.json();
}

// --- Profiles ---

export interface ProfileSummary {
  id: string;
  name: string;
  slug: string;
  api_key_id: string;
  model?: string | null;
  default_tools: string[];
  concurrency_limit: number;
  user_id?: string | null;
  created_at: string;
  last_used_at?: string;
}

export function fetchProfiles(): Promise<ProfileSummary[]> {
  return request("/profiles");
}

export function createProfile(body: Record<string, unknown>): Promise<ProfileSummary> {
  return request("/profiles", { method: "POST", body: JSON.stringify(body) });
}

export function updateProfile(id: string, body: Record<string, unknown>): Promise<ProfileSummary> {
  return request(`/profiles/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteProfile(id: string): Promise<{ status: string }> {
  return request(`/profiles/${id}`, { method: "DELETE" });
}

export interface ProfileModel {
  id: string;
  display_name: string | null;
  provider: "anthropic" | "ollama";
}

export function fetchProfileModels(profileId: string): Promise<{ models: ProfileModel[] }> {
  return request(`/profiles/${encodeURIComponent(profileId)}/models`);
}

// --- User-facing Tools, Skills, Subagents, Git Providers ---

export function fetchUserTools(): Promise<Record<string, unknown>[]> {
  return request("/tools");
}

export function createUserTool(body: Record<string, unknown>): Promise<unknown> {
  return request("/tools", { method: "POST", body: JSON.stringify(body) });
}

export function deleteUserTool(id: string): Promise<{ status: string }> {
  return request(`/tools/${id}`, { method: "DELETE" });
}

export function fetchUserSkills(): Promise<Record<string, unknown>[]> {
  return request("/skills");
}

export function createUserSkill(body: Record<string, unknown>): Promise<unknown> {
  return request("/skills", { method: "POST", body: JSON.stringify(body) });
}

export function deleteUserSkill(id: string): Promise<{ status: string }> {
  return request(`/skills/${id}`, { method: "DELETE" });
}

export function fetchUserAgents(): Promise<Record<string, unknown>[]> {
  return request("/agents");
}

export function createUserAgent(body: Record<string, unknown>): Promise<unknown> {
  return request("/agents", { method: "POST", body: JSON.stringify(body) });
}

export function deleteUserAgent(id: string): Promise<{ status: string }> {
  return request(`/agents/${id}`, { method: "DELETE" });
}

export interface GitProviderInfo {
  id: string;
  name: string;
  type: "github" | "gitlab" | "bitbucket";
  auth_method: "pat" | "oauth";
  token: string;
  user_name?: string;
  user_email?: string;
  created_at: string;
}

export function fetchUserGitProviders(): Promise<GitProviderInfo[]> {
  return request("/git-providers");
}

export function createUserGitProvider(body: Record<string, unknown>): Promise<unknown> {
  return request("/git-providers", { method: "POST", body: JSON.stringify(body) });
}

export function updateUserGitProvider(id: string, body: Record<string, unknown>): Promise<unknown> {
  return request(`/git-providers/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteUserGitProvider(id: string): Promise<{ status: string }> {
  return request(`/git-providers/${id}`, { method: "DELETE" });
}

// --- Git OAuth ---

export interface GitOAuthConfig {
  github: boolean;
  gitlab: boolean;
  bitbucket: boolean;
}

export function fetchGitOAuthConfig(): Promise<GitOAuthConfig> {
  return request("/git-providers/oauth/config");
}

export function getGitOAuthAuthorizeUrl(provider: string, returnPath?: string): Promise<{ url: string }> {
  const params = returnPath ? `?returnPath=${encodeURIComponent(returnPath)}` : "";
  return request(`/git-providers/oauth/${provider}/authorize${params}`);
}

// --- Integrations (Slack, etc.) ---

export type IntegrationScope = "all" | "agents";

export interface Integration {
  id: string;
  user_id: string;
  type: string;
  config: Record<string, unknown>;
  enabled: boolean;
  is_default: boolean;
  scope: IntegrationScope;
  profile_ids: string[];
  created_at: string;
  updated_at: string;
}

export function fetchSlackConfig(): Promise<{ enabled: boolean }> {
  return request("/integrations/slack/config");
}

export function getSlackAuthorizeUrl(returnPath?: string): Promise<{ url: string }> {
  const params = returnPath ? `?returnPath=${encodeURIComponent(returnPath)}` : "";
  return request(`/integrations/slack/authorize${params}`);
}

export function fetchGmailConfig(): Promise<{ enabled: boolean }> {
  return request("/integrations/gmail/config");
}

// --- Telegram ---

/**
 * A single connected Telegram bot. Replaces the legacy single-bot
 * TelegramStatus shape — users can now pair multiple bots, each
 * optionally bound to a specific agent profile.
 */
export interface TelegramBot {
  id: string;
  bot_username: string;
  bot_user_id: string;
  linked: boolean;
  link_code: string | null;
  /** https://t.me/<bot>?start=<code> — opens in browser, redirects to app */
  link_url: string | null;
  /** tg://resolve?domain=<bot>&start=<code> — opens Telegram app directly */
  link_url_native: string | null;
  bound_profile_id: string | null;
  bound_profile_slug: string | null;
  bound_profile_name: string | null;
  /** true → shared platform-hosted bot; false → user-owned BotFather creation */
  is_platform_owned: boolean;
}

/** @deprecated use TelegramBot from fetchTelegramBots(). Kept for legacy components mid-rollout. */
export interface TelegramStatus extends Partial<TelegramBot> {
  connected: boolean;
}

export interface TelegramConfigInfo {
  enabled: boolean;
  publicReachable: boolean;
  webhookBase: string;
  /** Present when PLATFORM_TELEGRAM_BOT_TOKEN is configured on the server. */
  platformBot: { bot_username: string } | null;
}
export function fetchTelegramConfig(): Promise<TelegramConfigInfo> {
  return request("/integrations/telegram/config");
}

export function connectTelegramPlatform(
  opts?: { bound_profile_id?: string | null },
): Promise<TelegramBot & { link_instructions: string }> {
  return request("/integrations/telegram/connect-platform", {
    method: "POST",
    body: JSON.stringify({ bound_profile_id: opts?.bound_profile_id ?? null }),
  });
}

export function fetchTelegramStatus(): Promise<TelegramStatus> {
  return request("/integrations/telegram/status");
}

export function fetchTelegramBots(): Promise<{ bots: TelegramBot[] }> {
  return request("/integrations/telegram/bots");
}

export function connectTelegram(
  botToken: string,
  opts?: { bound_profile_id?: string | null },
): Promise<TelegramBot & { link_instructions: string }> {
  return request("/integrations/telegram/connect", {
    method: "POST",
    body: JSON.stringify({ bot_token: botToken, bound_profile_id: opts?.bound_profile_id ?? null }),
  });
}

export function updateTelegramBotBinding(botId: string, boundProfileId: string | null): Promise<TelegramBot> {
  return request(`/integrations/telegram/bots/${botId}`, {
    method: "PATCH",
    body: JSON.stringify({ bound_profile_id: boundProfileId }),
  });
}

export function disconnectTelegram(botId?: string): Promise<{ status: string }> {
  return request("/integrations/telegram/disconnect", {
    method: "POST",
    body: JSON.stringify(botId ? { bot_id: botId } : {}),
  });
}

/**
 * The bot best suited to receive a "resume this workspace" deep link.
 * Returns `null` when the user has no linked Telegram bots — the
 * dashboard hides the "Open in Telegram" button in that case.
 */
export interface TelegramBotForWorkspace {
  id: string;
  bot_username: string;
  /** https://t.me/<bot>?start=resume_<session> — universal link */
  deep_link: string;
  /** tg://resolve?domain=<bot>&start=resume_<session> — native app */
  deep_link_native: string;
  /** true when the bot's bound_profile_id matched the workspace's profile */
  matched_by_profile: boolean;
}

export function fetchTelegramBotForWorkspace(sessionId: string): Promise<{ bot: TelegramBotForWorkspace | null }> {
  return request(`/integrations/telegram/bots/for-workspace/${sessionId}`);
}

export function regenerateTelegramLinkCode(botId?: string): Promise<{
  link_code: string;
  link_url: string;
  link_url_native: string;
}> {
  return request("/integrations/telegram/regenerate-link-code", {
    method: "POST",
    body: JSON.stringify(botId ? { bot_id: botId } : {}),
  });
}

export function getGmailAuthorizeUrl(returnPath?: string): Promise<{ url: string }> {
  const params = returnPath ? `?returnPath=${encodeURIComponent(returnPath)}` : "";
  return request(`/integrations/gmail/authorize${params}`);
}

// --- Teller (bank data) ---

export interface TellerConfigInfo {
  enabled: boolean;
  application_id: string | null;
  environment: "sandbox" | "development" | "production";
}

export function fetchTellerConfig(): Promise<TellerConfigInfo> {
  return request("/integrations/teller/config");
}

/** Body shape matches Teller Connect's onSuccess payload. */
export function submitTellerEnrollment(payload: {
  accessToken: string;
  enrollment: { id: string; institution: { id?: string; name?: string } };
  user?: { id?: string };
  signature?: string;
}): Promise<{ id: string; enrollment_id: string; institution_name: string | null }> {
  return request("/integrations/teller/callback", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function fetchIntegrations(): Promise<Integration[]> {
  return request("/integrations");
}

export function deleteIntegration(id: string): Promise<{ status: string }> {
  return request(`/integrations/${id}`, { method: "DELETE" });
}

export function createIntegration(body: { type: string; config: Record<string, unknown>; is_default?: boolean }): Promise<Integration> {
  return request("/integrations", { method: "POST", body: JSON.stringify(body) });
}

export function updateIntegration(id: string, body: { config?: Record<string, unknown>; is_default?: boolean; enabled?: boolean; scope?: IntegrationScope; profile_ids?: string[] }): Promise<Integration> {
  return request(`/integrations/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function testIntegration(id: string): Promise<{ status: string; channel: string }> {
  return request(`/integrations/${id}/test`, { method: "POST" });
}

// --- User Anthropic Keys (own + admin-granted) ---

export interface UserAnthropicKey {
  id: string;
  user_id?: string | null;
  name: string;
  provider: string;
  api_key?: string;
  auth_token?: string;
  allowed_user_ids: string[];
  created_at: string;
  last_used_at?: string;
}

export function fetchUserAnthropicKeys(): Promise<UserAnthropicKey[]> {
  return request("/anthropic-keys");
}

export function createUserAnthropicKey(body: {
  name: string; provider: string; api_key?: string; auth_token?: string;
}): Promise<UserAnthropicKey> {
  return request("/anthropic-keys", { method: "POST", body: JSON.stringify(body) });
}

export function updateUserAnthropicKey(id: string, body: Record<string, unknown>): Promise<UserAnthropicKey> {
  return request(`/anthropic-keys/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteUserAnthropicKey(id: string): Promise<{ status: string }> {
  return request(`/anthropic-keys/${id}`, { method: "DELETE" });
}

export function fetchOllamaModels(apiKeyId: string): Promise<{ models: Array<{ id: string; name: string }> }> {
  return request(`/ollama/models?api_key_id=${encodeURIComponent(apiKeyId)}`);
}

// --- User API Tokens ---

export interface UserApiToken {
  id: string;
  name: string;
  caller_key?: string;
  allowed_profile_ids: string[];
  rate_limit_rpm: number;
  created_at: string;
  last_used_at?: string;
}

export function fetchUserApiTokens(): Promise<UserApiToken[]> {
  return request("/api-tokens");
}

export function createUserApiToken(body: {
  name: string; allowed_profile_ids: string[]; rate_limit_rpm?: number;
}): Promise<UserApiToken> {
  return request("/api-tokens", { method: "POST", body: JSON.stringify(body) });
}

export function updateUserApiToken(id: string, body: Record<string, unknown>): Promise<UserApiToken> {
  return request(`/api-tokens/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteUserApiToken(id: string): Promise<{ status: string }> {
  return request(`/api-tokens/${id}`, { method: "DELETE" });
}

// --- Pool ---

export interface PoolStatus {
  idle: number;
  busy: number;
  total: number;
}

export function fetchPoolStatus(): Promise<PoolStatus> {
  return request("/pool");
}

export interface ContainerInfo {
  id: string;
  status: "running" | "exited" | "created";
  labels: Record<string, string>;
  created_at: string;
  assignment: "pool-idle" | "pool-busy" | "session" | "orphan";
  session_id: string | null;
  pool_status: "idle" | "busy" | null;
}

export function fetchContainers(): Promise<{ containers: ContainerInfo[] }> {
  return request("/pool/containers");
}

export function removeContainer(id: string): Promise<{ status: string }> {
  return request(`/pool/containers/${id}`, { method: "DELETE" });
}

// --- Health ---

export interface HealthStatus {
  status: string;
  pool: PoolStatus;
  sessions: number;
  connections: number;
}

export function fetchHealth(): Promise<HealthStatus> {
  return fetch("/health", { credentials: "include" }).then((r) => r.json());
}

export async function generateWorkspaceTitle(workspaceId: string): Promise<{ name: string }> {
  const res = await fetch(`/v1/workspaces/${workspaceId}/generate-title`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new ApiError(res.status, "Title generation failed");
  return res.json();
}

// --- Memories ---

export interface MemorySummary {
  id: string;
  user_id: string;
  profile_id: string | null;
  type: "user" | "feedback" | "project" | "reference";
  name: string;
  description: string | null;
  body: string;
  importance: number;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
}

export function fetchMemories(params?: {
  type?: string;
  profile_id?: string;
  limit?: number;
  offset?: number;
}): Promise<MemorySummary[]> {
  const qs = new URLSearchParams();
  if (params?.type) qs.set("type", params.type);
  if (params?.profile_id) qs.set("profile_id", params.profile_id);
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.offset) qs.set("offset", String(params.offset));
  const query = qs.toString();
  return request(`/memories${query ? `?${query}` : ""}`);
}

export function searchMemories(params: {
  q: string;
  type?: string;
  profile_id?: string;
  limit?: number;
}): Promise<MemorySummary[]> {
  const qs = new URLSearchParams();
  qs.set("q", params.q);
  if (params.type) qs.set("type", params.type);
  if (params.profile_id) qs.set("profile_id", params.profile_id);
  if (params.limit) qs.set("limit", String(params.limit));
  return request(`/memories/search?${qs.toString()}`);
}

export function fetchMemory(id: string): Promise<MemorySummary> {
  return request(`/memories/${id}`);
}

export function createMemory(body: {
  name: string;
  type: "user" | "feedback" | "project" | "reference";
  body: string;
  description?: string;
  profile_id?: string;
}): Promise<MemorySummary> {
  return request("/memories", { method: "POST", body: JSON.stringify(body) });
}

export function updateMemory(id: string, body: {
  name?: string;
  type?: "user" | "feedback" | "project" | "reference";
  body?: string;
  description?: string;
}): Promise<MemorySummary> {
  return request(`/memories/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteMemory(id: string): Promise<{ deleted: boolean }> {
  return request(`/memories/${id}`, { method: "DELETE" });
}

export function bulkDeleteMemories(params?: {
  type?: string;
  profile_id?: string;
}): Promise<{ deleted: number }> {
  const qs = new URLSearchParams();
  if (params?.type) qs.set("type", params.type);
  if (params?.profile_id) qs.set("profile_id", params.profile_id);
  const query = qs.toString();
  return request(`/memories${query ? `?${query}` : ""}`, { method: "DELETE" });
}

// ── Secrets (vault) ──

export type SecretScope = "all" | "agents";

export interface UserSecret {
  id: string;
  user_id: string;
  name: string;
  value: string;
  scope: SecretScope;
  profile_ids: string[];
  created_at: string;
  updated_at: string;
}

export function fetchSecrets(): Promise<UserSecret[]> {
  return request("/secrets");
}

export function createSecret(body: { name: string; value: string; scope?: SecretScope; profile_ids?: string[] }): Promise<UserSecret> {
  return request("/secrets", { method: "POST", body: JSON.stringify(body) });
}

export function updateSecret(id: string, body: { name?: string; value?: string; scope?: SecretScope; profile_ids?: string[] }): Promise<UserSecret> {
  return request(`/secrets/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteSecret(id: string): Promise<{ status: string }> {
  return request(`/secrets/${id}`, { method: "DELETE" });
}

// ── Playbooks ──

export interface PlaybookChainConfig {
  max_chains: number;
  budget_cap_usd: number;
  chain_delay_ms: number;
  max_turns_per_chain?: number;
  allowed_tools?: string[];
  timeout_per_chain_seconds?: number;
}

export interface Playbook {
  id: string;
  user_id: string;
  profile_id: string;
  name: string;
  description: string;
  prompt: string;
  schedule: string;
  chain_config: PlaybookChainConfig;
  enabled: boolean;
  notify_on: "completion" | "failure" | "both" | "none";
  notification_channels: string[];
  trigger_type: "cron" | "interval" | "manual" | "webhook";
  interval_seconds?: number;
  webhook_token?: string;
  success_criteria?: Array<{ type: string; field?: string; value: string | number }>;
  last_run_at?: string;
  next_run_at?: string;
  created_at: string;
  updated_at: string;
}

export interface ActivityLogEntry {
  type: "text" | "tool_use" | "tool_result";
  tool?: string;
  input?: unknown;
  output?: string;
  text?: string;
  ts: string;
}

export interface PlaybookRun {
  id: string;
  playbook_id: string;
  playbook_name?: string;
  user_id: string;
  session_id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  decision_result?: "pass" | "fail" | "skipped";
  chain_count: number;
  total_turns: number;
  total_cost_usd: number;
  task_ids: string[];
  result_summary?: string;
  activity_log?: ActivityLogEntry[];
  error?: string;
  started_at: string;
  finished_at?: string;
}

export function fetchPlaybooks(): Promise<Playbook[]> {
  return request("/playbooks");
}

export function createPlaybook(body: {
  name: string;
  profile_id: string;
  prompt: string;
  schedule: string;
  description?: string;
  chain_config?: Partial<PlaybookChainConfig>;
  enabled?: boolean;
}): Promise<Playbook> {
  return request("/playbooks", { method: "POST", body: JSON.stringify(body) });
}

export function updatePlaybook(id: string, body: Record<string, unknown>): Promise<Playbook> {
  return request(`/playbooks/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deletePlaybook(id: string): Promise<{ status: string }> {
  return request(`/playbooks/${id}`, { method: "DELETE" });
}

export function triggerPlaybook(id: string): Promise<{ status: string }> {
  return request(`/playbooks/${id}/run`, { method: "POST" });
}

export function fetchPlaybookRuns(playbookId: string): Promise<PlaybookRun[]> {
  return request(`/playbooks/${playbookId}/runs`);
}

export function fetchAllPlaybookRuns(): Promise<PlaybookRun[]> {
  return request("/playbook-runs");
}

export function fetchPlaybookRun(id: string): Promise<PlaybookRun> {
  return request(`/playbook-runs/${id}`);
}

export function cancelPlaybookRun(id: string): Promise<{ status: string }> {
  return request(`/playbook-runs/${id}/cancel`, { method: "POST" });
}

export function fetchSchedulerStatus(): Promise<{ paused: boolean }> {
  return request("/playbooks/scheduler/status");
}
export function pauseScheduler(): Promise<{ status: string }> {
  return request("/playbooks/scheduler/pause", { method: "POST" });
}
export function resumeScheduler(): Promise<{ status: string }> {
  return request("/playbooks/scheduler/resume", { method: "POST" });
}
