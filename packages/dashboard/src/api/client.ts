const BASE = "/v1";

/**
 * Active-org storage key, shared with cp-dashboard's orgs extension.
 * SaaS deployments write it from the topbar OrgSwitcher; OSS leaves
 * it unset, in which case no X-Org-Id is sent and the server's
 * orgContext stays undefined (OSS code path).
 */
const ORG_ID_STORAGE_KEY = "vonzio_current_org_id";

function readCurrentOrgId(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(ORG_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = { ...options.headers as Record<string, string> };
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }
  // Inject the active org if set (SaaS only). Without this, server
  // routes like POST /v1/tasks have no orgContext and can't tag the
  // resulting workspace — cp-server's CHECK constraint then rejects
  // the insert.
  const orgId = readCurrentOrgId();
  if (orgId) {
    headers["X-Org-Id"] = orgId;
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
  /** Per-conversation API-key override (cross-key model selection). */
  api_key_id_override: string | null;
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

/** Tear down the workspace's container; the next message recreates a fresh one
 *  (applies creation-time config like the egress allowlist) without losing the
 *  conversation. */
export function restartWorkspace(id: string): Promise<{ status: string; session_id: string }> {
  return request(`/workspaces/${id}/restart`, { method: "POST" });
}

export function updateWorkspace(
  id: string,
  fields: { name?: string; starred?: boolean; pinned?: boolean; archived?: boolean; tags?: string[]; public_preview?: boolean; model_override?: string | null; api_key_id_override?: string | null },
): Promise<WorkspaceSummary> {
  return request(`/workspaces/${id}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
}

/** Models grouped by each key the user can use — powers the workspace
 *  composer's cross-key model picker. */
export interface KeyModelGroup {
  key_id: string;
  key_name: string;
  provider: string;
  models: ProfileModel[];
  error?: string;
}
export function fetchAllUserModels(): Promise<{ keys: KeyModelGroup[] }> {
  return request("/me/models");
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

export async function uploadFiles(workspaceId: string, files: File[], dest?: string): Promise<{ uploaded: { name: string; size: number }[] }> {
  const formData = new FormData();
  // Append the destination FIRST so the streaming multipart parser sees it
  // before the file parts (field order is preserved). Omitted → server default.
  if (dest) formData.append("dest", dest);
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
  /** Profile default for the composer's "Run until done" (goal-loop) toggle. */
  auto_continue?: boolean;
  user_id?: string | null;
  /** The user's default agent — preselected in the new-chat picker. */
  is_default?: boolean;
  /** SaaS-only — true when this row was materialized from an
   *  org_profile (team-shared agent). Read-only for members. */
  team_owned?: boolean;
  created_at: string;
  last_used_at?: string;
}

export function fetchProfiles(): Promise<ProfileSummary[]> {
  return request("/profiles");
}

/** New-chat starter prompts, served from config/prompt-suggestions.json. */
export interface PromptSuggestion { id: string; label: string; icon?: string; prompt: string }
export function fetchPromptSuggestions(): Promise<{ suggestions: PromptSuggestion[] }> {
  return request("/prompt-suggestions");
}

/** Mark a profile as the user's default agent (clears the flag on the others). */
export function setDefaultProfile(id: string): Promise<{ ok: boolean; id: string }> {
  return request(`/profiles/${id}/default`, { method: "POST" });
}

export function createProfile(body: Record<string, unknown>): Promise<ProfileSummary> {
  return request("/profiles", { method: "POST", body: JSON.stringify(body) });
}

export async function fetchAgentTemplates(): Promise<import("@vonzio/shared").AgentTemplate[]> {
  const res = await request<{ templates: import("@vonzio/shared").AgentTemplate[] }>("/agent-templates");
  return res.templates ?? [];
}

export function updateProfile(id: string, body: Record<string, unknown>): Promise<ProfileSummary> {
  return request(`/profiles/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteProfile(id: string): Promise<{ status: string }> {
  return request(`/profiles/${id}`, { method: "DELETE" });
}

// ── Per-agent knowledge documents (mounted read-only into containers at /knowledge) ──
export interface ProfileDocument {
  id: string;
  profile_id: string;
  name: string;
  media_type: string;
  size_bytes: number;
  created_at: string;
}

export function fetchProfileDocuments(profileId: string): Promise<ProfileDocument[]> {
  return request(`/profiles/${profileId}/documents`);
}

export function uploadProfileDocument(
  profileId: string,
  body: { name: string; media_type: string; content_b64: string },
): Promise<ProfileDocument> {
  return request(`/profiles/${profileId}/documents`, { method: "POST", body: JSON.stringify(body) });
}

export function deleteProfileDocument(profileId: string, docId: string): Promise<{ status: string }> {
  return request(`/profiles/${profileId}/documents/${docId}`, { method: "DELETE" });
}

// Workspace-scoped knowledge docs (only mounted for that conversation).
export function fetchWorkspaceDocuments(sessionId: string): Promise<ProfileDocument[]> {
  return request(`/workspaces/${sessionId}/documents`);
}

export function uploadWorkspaceDocument(
  sessionId: string,
  body: { name: string; media_type: string; content_b64: string },
): Promise<ProfileDocument> {
  return request(`/workspaces/${sessionId}/documents`, { method: "POST", body: JSON.stringify(body) });
}

export function deleteWorkspaceDocument(sessionId: string, docId: string): Promise<{ status: string }> {
  return request(`/workspaces/${sessionId}/documents/${docId}`, { method: "DELETE" });
}

// Browser-facing raw-content URLs for the in-dashboard doc viewer (same-origin
// via the dev/prod proxy, so the session cookie is sent on iframe/img loads).
export function profileDocumentRawUrl(profileId: string, docId: string): string {
  return `/v1/profiles/${profileId}/documents/${docId}/raw`;
}
export function workspaceDocumentRawUrl(sessionId: string, docId: string): string {
  return `/v1/workspaces/${sessionId}/documents/${docId}/raw`;
}

export interface ProfileModel {
  id: string;
  display_name: string | null;
  provider: "anthropic" | "ollama" | "openai";
}

export function fetchProfileModels(profileId: string): Promise<{ models: ProfileModel[] }> {
  return request(`/profiles/${encodeURIComponent(profileId)}/models`);
}

/** Models for a specific API key — lets the agent editor refresh the picker
 *  when the key dropdown changes before the profile is saved. */
export function fetchModelsForApiKey(apiKeyId: string): Promise<{ models: ProfileModel[] }> {
  return request(`/anthropic-keys/${encodeURIComponent(apiKeyId)}/models`);
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

// Slack endpoints moved to @vonzio/plugin-slack/dashboard/api in
// Phase 3E.2 -- the dashboard no longer references any
// /v1/integrations/slack/* endpoints directly.

export function fetchGmailConfig(): Promise<{ enabled: boolean }> {
  return request("/integrations/gmail/config");
}

// Telegram API client lives in @vonzio/plugin-telegram/dashboard/api
// as of Phase 3D.1e -- the dashboard no longer references any /v1/
// integrations/telegram/* endpoints directly.

export function getGmailAuthorizeUrl(returnPath?: string): Promise<{ url: string }> {
  const params = returnPath ? `?returnPath=${encodeURIComponent(returnPath)}` : "";
  return request(`/integrations/gmail/authorize${params}`);
}

// Teller (bank data) moved to the external @vonzio/plugin-teller plugin —
// its frontend talks to /v1/integrations/teller/* directly.

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
  base_url?: string | null;
  allowed_user_ids: string[];
  created_at: string;
  last_used_at?: string;
}

export function fetchUserAnthropicKeys(): Promise<UserAnthropicKey[]> {
  return request("/anthropic-keys");
}

export function createUserAnthropicKey(body: {
  name: string; provider: string; api_key?: string; base_url?: string;
}): Promise<UserAnthropicKey> {
  return request("/anthropic-keys", { method: "POST", body: JSON.stringify(body) });
}

export function updateUserAnthropicKey(id: string, body: Record<string, unknown>): Promise<UserAnthropicKey> {
  return request(`/anthropic-keys/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

/** Validate a credential without saving — for the dialog's "Test connection"
 *  button. Pass raw entered values, and/or an `id` to fall back to the stored
 *  secret when the key field is left masked. */
export function validateUserAnthropicKey(body: {
  provider?: string; api_key?: string; base_url?: string | null; id?: string;
}): Promise<{ valid: boolean; error?: string }> {
  return request("/anthropic-keys/validate", { method: "POST", body: JSON.stringify(body) });
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
