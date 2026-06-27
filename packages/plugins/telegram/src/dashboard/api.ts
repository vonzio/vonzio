// Dashboard-side API client for @vonzio/plugin-telegram.
//
// Moved here from packages/dashboard/src/api/client.ts in Phase 3D.1e
// alongside the JSX move. The plugin owns its full request surface
// against the backend's /v1/integrations/telegram/* routes (which
// also moved with the backend in 3D.1d.1, completing the loop).
//
// The local `request()` helper is a small ~30 LOC duplicate of the
// dashboard's internal one. Duplication kept on purpose -- the
// alternative is exposing a public `@vonzio/dashboard/api` export
// that every plugin would couple to. The duplication is small and
// the contract (cookie auth, X-Org-Id from localStorage, /v1
// prefix, JSON in/out) is stable.

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
    const raw = body.error ?? body.message;
    const message =
      typeof raw === "string"
        ? raw
        : typeof raw?.message === "string"
          ? raw.message
          : raw != null
            ? JSON.stringify(raw)
            : `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return res.json();
}

// ───────────────────────────────────────────────────────────────────
// Telegram-specific endpoints + types
// ───────────────────────────────────────────────────────────────────

/**
 * A single connected Telegram bot. Replaces the legacy single-bot
 * TelegramStatus shape -- users can now pair multiple bots, each
 * optionally bound to a specific agent profile.
 */
export interface TelegramBot {
  id: string;
  bot_username: string;
  bot_user_id: string;
  linked: boolean;
  link_code: string | null;
  /** https://t.me/<bot>?start=<code> -- opens in browser, redirects to app */
  link_url: string | null;
  /** tg://resolve?domain=<bot>&start=<code> -- opens Telegram app directly */
  link_url_native: string | null;
  bound_profile_id: string | null;
  bound_profile_slug: string | null;
  bound_profile_name: string | null;
  /** true -> shared platform-hosted bot; false -> user-owned BotFather creation */
  is_platform_owned: boolean;
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

export function fetchTelegramBots(): Promise<{ bots: TelegramBot[] }> {
  return request("/integrations/telegram/bots");
}

export function connectTelegramPlatform(
  opts?: { bound_profile_id?: string | null },
): Promise<TelegramBot & { link_instructions: string }> {
  return request("/integrations/telegram/connect-platform", {
    method: "POST",
    body: JSON.stringify({ bound_profile_id: opts?.bound_profile_id ?? null }),
  });
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

/**
 * The bot best suited to receive a "resume this workspace" deep link.
 * Returns `null` when the user has no linked Telegram bots -- the
 * WorkspaceHeader slot hides the "Open in Telegram" button in that case.
 */
export interface TelegramBotForWorkspace {
  id: string;
  bot_username: string;
  /** https://t.me/<bot>?start=resume_<session> -- universal link */
  deep_link: string;
  /** tg://resolve?domain=<bot>&start=resume_<session> -- native app */
  deep_link_native: string;
  /** true when the bot's bound_profile_id matched the workspace's profile */
  matched_by_profile: boolean;
}

export function fetchTelegramBotForWorkspace(sessionId: string): Promise<{ bot: TelegramBotForWorkspace | null }> {
  return request(`/integrations/telegram/bots/for-workspace/${sessionId}`);
}

// ───────────────────────────────────────────────────────────────────
// Generic Integration endpoints (used by the Telegram settings UI for
// scope + test + set-default actions). Live here rather than in a
// separate shared package because plugins owning their settings UI
// generally need this surface, and re-publishing the dashboard's
// internal client.ts as a public API would be a wider commitment
// than this PR can validate.
// ───────────────────────────────────────────────────────────────────

export type SecretScope = "all" | "agents";

export interface Integration {
  id: string;
  type: string;
  config: Record<string, unknown>;
  scope: SecretScope;
  profile_ids: string[];
  is_default?: boolean;
  created_at: string;
  updated_at: string;
}

export function fetchIntegrations(): Promise<Integration[]> {
  return request("/integrations");
}

export function updateIntegration(
  id: string,
  input: Partial<{
    config: Record<string, unknown>;
    enabled: boolean;
    scope: SecretScope;
    profile_ids: string[];
    is_default: boolean;
  }>,
): Promise<Integration> {
  return request(`/integrations/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function testIntegration(id: string): Promise<{ status: string }> {
  return request(`/integrations/${id}/test`, { method: "POST" });
}

// ───────────────────────────────────────────────────────────────────
// Profile list (for the agent-binding dropdown). Dashboard already
// exposes a richer profiles client; the plugin only needs id + slug +
// name so a narrow local fetch keeps the dep boundary thin.
// ───────────────────────────────────────────────────────────────────

export interface ProfileSummary {
  id: string;
  slug: string;
  name: string;
}

export function fetchProfiles(): Promise<ProfileSummary[]> {
  return request("/profiles");
}
