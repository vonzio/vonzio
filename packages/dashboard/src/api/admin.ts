const BASE = "/admin";

async function adminRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
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
    throw new Error(body.error ?? "Request failed");
  }

  return res.json();
}

// --- Bootstrap ---

export interface BootstrapResult {
  caller_key: string;
  caller_key_id: string;
  profile_id: string;
  profile_name: string;
}

export function bootstrap(body: {
  name?: string;
  api_key?: string;
  auth_token?: string;
  provider?: string;
}): Promise<BootstrapResult> {
  return adminRequest("/bootstrap", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// --- API Tokens ---

export interface ApiTokenInfo {
  id: string;
  name: string;
  allowed_profile_ids: string[];
  rate_limit_rpm: number;
  created_at: string;
  last_used_at: string | null;
}

export interface CreateTokenResult {
  id: string;
  name: string;
  caller_key: string;
  allowed_profile_ids: string[];
}

export function fetchApiTokens(): Promise<ApiTokenInfo[]> {
  return adminRequest("/keys");
}

export function createApiToken(body: {
  name: string;
  allowed_profile_ids: string[];
  rate_limit_rpm?: number;
}): Promise<CreateTokenResult> {
  return adminRequest("/keys", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateApiToken(id: string, body: Partial<{
  name: string;
  allowed_profile_ids: string[];
  rate_limit_rpm: number;
}>): Promise<ApiTokenInfo> {
  return adminRequest(`/keys/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteApiToken(id: string): Promise<{ status: string }> {
  return adminRequest(`/keys/${id}`, { method: "DELETE" });
}

// --- Invites ---

export interface InviteInfo {
  id: string;
  email: string;
  role: string;
  invited_by: string;
  api_key_ids: string[];
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export function fetchInvites(): Promise<InviteInfo[]> {
  return adminRequest("/invites");
}

export function createInvite(body: { email: string; role?: string; api_key_ids?: string[] }): Promise<{ invite: InviteInfo; token?: string }> {
  return adminRequest("/invites", { method: "POST", body: JSON.stringify(body) });
}

export function revokeInvite(id: string): Promise<{ status: string }> {
  return adminRequest(`/invites/${id}`, { method: "DELETE" });
}

// --- Anthropic API Keys (admin only) ---

export interface AnthropicKeyInfo {
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

export function fetchAnthropicKeys(userId?: string): Promise<AnthropicKeyInfo[]> {
  const qs = userId ? `?user_id=${encodeURIComponent(userId)}` : "";
  return adminRequest(`/api-keys${qs}`);
}

export function createAnthropicKey(body: {
  name: string;
  provider: string;
  api_key?: string;
  auth_token?: string;
}): Promise<AnthropicKeyInfo> {
  return adminRequest("/api-keys", { method: "POST", body: JSON.stringify(body) });
}

export function updateAnthropicKey(id: string, body: Partial<{
  name: string;
  api_key: string;
  auth_token: string;
  allowed_user_ids: string[];
}>): Promise<AnthropicKeyInfo> {
  return adminRequest(`/api-keys/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteAnthropicKey(id: string): Promise<{ status: string }> {
  return adminRequest(`/api-keys/${id}`, { method: "DELETE" });
}

export function validateAnthropicKey(id: string): Promise<{ valid: boolean; error?: string }> {
  return adminRequest(`/api-keys/${id}/validate`, { method: "POST" });
}

// --- User Feature Flags ---

export function updateUserFlags(userId: string, feature_flags: string): Promise<{ status: string; feature_flags: string }> {
  return adminRequest(`/users/${userId}/flags`, { method: "PATCH", body: JSON.stringify({ feature_flags }) });
}

// --- Admin Profiles ---

export function fetchAdminProfiles(): Promise<unknown[]> {
  return adminRequest("/profiles");
}

export function createAdminProfile(body: Record<string, unknown>): Promise<unknown> {
  return adminRequest("/profiles", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateAdminProfile(id: string, body: Record<string, unknown>): Promise<unknown> {
  return adminRequest(`/profiles/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteAdminProfile(id: string): Promise<{ status: string }> {
  return adminRequest(`/profiles/${id}`, { method: "DELETE" });
}

// --- Tool Files ---

export interface ToolFileInfo {
  id: string;
  name: string;
  description: string | null;
  file_name: string;
  source: "filesystem" | "uploaded";
  input_schema: string | null;
  created_at: string;
  updated_at: string;
}

export function fetchToolFiles(): Promise<ToolFileInfo[]> {
  return adminRequest("/tools");
}

export function fetchToolCode(id: string): Promise<{ id: string; code: string }> {
  return adminRequest(`/tools/${id}/code`);
}

export function uploadToolFile(body: {
  name: string;
  description?: string;
  file_name: string;
  code: string;
  input_schema?: string;
}): Promise<ToolFileInfo> {
  return adminRequest("/tools", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deleteToolFile(id: string): Promise<{ status: string }> {
  return adminRequest(`/tools/${id}`, { method: "DELETE" });
}

// --- Skills ---

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  content: string;
  source: "filesystem" | "uploaded";
  created_at: string;
  updated_at: string;
}

export function fetchSkills(): Promise<SkillInfo[]> {
  return adminRequest("/skills");
}

export function uploadSkill(body: {
  name: string;
  description: string;
  content: string;
}): Promise<SkillInfo> {
  return adminRequest("/skills", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deleteSkill(id: string): Promise<{ status: string }> {
  return adminRequest(`/skills/${id}`, { method: "DELETE" });
}

// --- Agents (Subagents) ---

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  created_at: string;
  updated_at: string;
}

export function fetchAgents(): Promise<AgentInfo[]> {
  return adminRequest("/agents");
}

export function createAgent(body: {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
}): Promise<AgentInfo> {
  return adminRequest("/agents", { method: "POST", body: JSON.stringify(body) });
}

export function deleteAgent(id: string): Promise<{ status: string }> {
  return adminRequest(`/agents/${id}`, { method: "DELETE" });
}

// --- Git Providers ---

export interface GitProviderInfo {
  id: string;
  name: string;
  type: "github" | "gitlab" | "bitbucket";
  auth_method: "pat" | "oauth";
  token: string; // redacted
  user_name?: string;
  user_email?: string;
  created_at: string;
}

export function fetchGitProviders(): Promise<GitProviderInfo[]> {
  return adminRequest("/git-providers");
}

export function createGitProvider(body: {
  name: string;
  type: "github" | "gitlab" | "bitbucket";
  token: string;
  user_name?: string;
  user_email?: string;
}): Promise<GitProviderInfo> {
  return adminRequest("/git-providers", { method: "POST", body: JSON.stringify(body) });
}

export function updateGitProvider(id: string, body: Partial<{
  name: string;
  type: "github" | "gitlab" | "bitbucket";
  token: string;
  user_name: string;
  user_email: string;
}>): Promise<GitProviderInfo> {
  return adminRequest(`/git-providers/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteGitProvider(id: string): Promise<{ status: string }> {
  return adminRequest(`/git-providers/${id}`, { method: "DELETE" });
}

// --- Docker Images ---

export interface DockerImageInfo {
  name: string;
  tag: string;
  id: string;
  size: number;
  created: string;
}

export function fetchDockerImages(): Promise<DockerImageInfo[]> {
  return adminRequest("/images");
}

// --- Events (beta observability) ---

export interface EventRow {
  id: number;
  user_id: string | null;
  user_email: string | null;
  user_name: string | null;
  session_id: string | null;
  event: string;
  source: "server" | "client";
  properties: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface EventFilters {
  user_id?: string;
  event?: string;
  source?: "server" | "client";
  since?: string;
  until?: string;
  limit?: number;
}

export interface FunnelStep {
  key: string;
  label: string;
  users: number;
}

export function fetchAdminEvents(filters: EventFilters = {}): Promise<{ events: EventRow[] }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  const suffix = qs.toString() ? `?${qs}` : "";
  return adminRequest(`/events${suffix}`);
}

export function fetchEventFunnel(since?: string): Promise<{ since: string; steps: FunnelStep[] }> {
  const suffix = since ? `?since=${encodeURIComponent(since)}` : "";
  return adminRequest(`/events/funnel${suffix}`);
}
