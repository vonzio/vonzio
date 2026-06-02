// Dashboard-side API client for @vonzio/plugin-slack.
//
// Moved here from packages/dashboard/src/api/client.ts in Phase 3E.2
// alongside the backend extraction. The plugin owns the full
// request surface against the backend's /v1/integrations/slack/*
// routes (which also moved with the backend, completing the loop).
//
// Local `request()` helper duplicates ~30 LOC of dashboard's internal
// one. Same rationale as plugin-telegram's dashboard/api.ts -- the
// alternative is exposing a public @vonzio/dashboard/api export that
// every plugin would couple to.

const BASE = "/v1";
const ORG_ID_STORAGE_KEY = "vonzio_current_org_id";

function readCurrentOrgId(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(ORG_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers as Record<string, string> };
  if (options.body) headers["Content-Type"] = "application/json";
  const orgId = readCurrentOrgId();
  if (orgId) headers["X-Org-Id"] = orgId;
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

// ───────────────────────────────────────────────────────────────────
// Slack endpoints
// ───────────────────────────────────────────────────────────────────

export function fetchSlackConfig(): Promise<{ enabled: boolean }> {
  return request("/integrations/slack/config");
}

export function getSlackAuthorizeUrl(returnPath?: string): Promise<{ url: string }> {
  const params = returnPath ? `?returnPath=${encodeURIComponent(returnPath)}` : "";
  return request(`/integrations/slack/authorize${params}`);
}
