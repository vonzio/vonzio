/**
 * Anthropic Claude Pro/Max subscription OAuth service.
 * Self-contained — the credential-acquisition half of the `claude_subscription`
 * provider, replacing the "run `claude setup-token` locally and paste it" UX
 * with a server-owned sign-in: button → Anthropic consent page → user pastes
 * the displayed code → we exchange it for access+refresh tokens and rotate
 * them server-side thereafter.
 *
 * Flow shape: authorization-code + PKCE for a PUBLIC client. Anthropic exposes
 * no third-party device-code grant, but its authorize endpoint supports an
 * out-of-band display mode (`code=true` + the console callback redirect):
 * after consent the browser shows a `code#state` string for the user to copy —
 * that replaces device-flow polling with a single paste.
 *
 * Same ToS posture as the Codex flow (see codex-oauth-service.ts and the
 * provider warning in PROVIDER_CATALOG): the client_id is Anthropic's own
 * public app id — there is no third-party client to register — and Anthropic
 * may stop honoring subscription tokens outside its own apps at any time.
 * Overridable via ANTHROPIC_OAUTH_CLIENT_ID for future-proofing.
 *
 * The tokens this yields are used exactly like a pasted setup-token
 * (CLAUDE_CODE_OAUTH_TOKEN against the native Anthropic API) — this module
 * only handles acquisition + refresh. Unlike Codex JWTs, Anthropic access
 * tokens are OPAQUE, so expiry is captured from `expires_in` at exchange time
 * and persisted (api_keys.token_expires_at, migration 37).
 */

import { createHash, randomBytes } from "node:crypto";

export const ANTHROPIC_OAUTH_CLIENT_ID =
  process.env.ANTHROPIC_OAUTH_CLIENT_ID ?? "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const ANTHROPIC_AUTHORIZE_URL =
  process.env.ANTHROPIC_OAUTH_AUTHORIZE_URL ?? "https://claude.ai/oauth/authorize";
export const ANTHROPIC_TOKEN_URL =
  process.env.ANTHROPIC_OAUTH_TOKEN_URL ?? "https://platform.claude.com/v1/oauth/token";
/** Out-of-band display redirect: after consent this page SHOWS the
 *  `code#state` string for the user to copy back — no server callback. */
export const ANTHROPIC_CODE_REDIRECT_URI =
  process.env.ANTHROPIC_OAUTH_REDIRECT_URI ?? "https://console.anthropic.com/oauth/code/callback";
/** Scope set the Claude Code client requests; inference is the one we need,
 *  the rest keep the token fully usable by the in-container SDK. */
export const ANTHROPIC_OAUTH_SCOPE =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

/** A pending sign-in is abandoned after 15 minutes. */
export const ANTHROPIC_OAUTH_TIMEOUT_MS = 15 * 60 * 1000;

/** Refresh when within this skew of expiry (mirrors the Codex 5-min margin). */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** Injectable fetch so the network legs are unit-testable. */
export type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

const defaultFetch: FetchLike = globalThis.fetch as unknown as FetchLike;

// ─── PKCE (pure) ──────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

export function codeChallengeS256(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** Build the consent-page URL. Pure. `code=true` selects the display-the-code
 *  mode; `state` carries the PKCE verifier (the reference clients do the same,
 *  and the exchange leg echoes it back). */
export function buildAuthorizeUrl(opts: { verifier: string; codeChallenge: string }): string {
  const u = new URL(ANTHROPIC_AUTHORIZE_URL);
  u.searchParams.set("code", "true");
  u.searchParams.set("client_id", ANTHROPIC_OAUTH_CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", ANTHROPIC_CODE_REDIRECT_URI);
  u.searchParams.set("scope", ANTHROPIC_OAUTH_SCOPE);
  u.searchParams.set("code_challenge", opts.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", opts.verifier);
  return u.toString();
}

/** Parse whatever the user pastes back — the raw `code#state` string the
 *  consent page displays, a full redirect URL, or a bare code. Pure. */
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = (input ?? "").trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch { /* not a URL */ }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  return { code: value };
}

// ─── Pending sign-ins (in-memory, single-process) ─────────────────────

interface PendingAuth {
  verifier: string;
  createdAt: number;
}

const pending = new Map<string, PendingAuth>();

function prunePending(now: number): void {
  for (const [id, p] of pending) {
    if (now - p.createdAt > ANTHROPIC_OAUTH_TIMEOUT_MS) pending.delete(id);
  }
}

export interface OAuthStart {
  auth_id: string;
  authorize_url: string;
}

/** Begin a sign-in: mint PKCE state, remember the verifier server-side, hand
 *  the browser the consent URL. */
export function startOAuth(now = Date.now()): OAuthStart {
  prunePending(now);
  const verifier = generateCodeVerifier();
  const auth_id = base64url(randomBytes(16));
  pending.set(auth_id, { verifier, createdAt: now });
  return {
    auth_id,
    authorize_url: buildAuthorizeUrl({ verifier, codeChallenge: codeChallengeS256(verifier) }),
  };
}

export interface AnthropicTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO expiry with the 5-min pre-expiry skew already applied. */
  expiresAt: string;
}

function tokensFromResponse(data: { access_token?: string; refresh_token?: string; expires_in?: number }, now: number): AnthropicTokens {
  if (!data.access_token || !data.refresh_token) {
    throw new Error("token endpoint returned no token pair");
  }
  const ttlMs = (data.expires_in ?? 3600) * 1000;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(now + ttlMs - EXPIRY_SKEW_MS).toISOString(),
  };
}

/** Complete a sign-in: parse the pasted code, exchange it (PKCE) for tokens.
 *  Consumes the pending auth on success. */
export async function completeOAuth(
  authId: string,
  pastedInput: string,
  fetchImpl: FetchLike = defaultFetch,
  now = Date.now(),
): Promise<AnthropicTokens> {
  prunePending(now);
  const p = pending.get(authId);
  if (!p) throw new Error("sign-in expired or unknown — start again");

  const { code, state } = parseAuthorizationInput(pastedInput);
  if (!code) throw new Error("paste the code shown after approving in the browser");
  if (state && state !== p.verifier) throw new Error("OAuth state mismatch — start again");

  const res = await fetchImpl(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      code,
      state: state ?? p.verifier,
      redirect_uri: ANTHROPIC_CODE_REDIRECT_URI,
      code_verifier: p.verifier,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`token exchange failed (${res.status}): ${body.slice(0, 300)}`);
  }
  pending.delete(authId);
  return tokensFromResponse((await res.json()) as Record<string, never>, now);
}

/** Refresh grant. The refresh token is SINGLE-USE and rotates — callers must
 *  persist the returned pair (see ProfileService's refresh-before-use). */
export async function refreshAnthropicTokens(
  refreshToken: string,
  fetchImpl: FetchLike = defaultFetch,
  now = Date.now(),
): Promise<AnthropicTokens> {
  const res = await fetchImpl(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`token refresh failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return tokensFromResponse((await res.json()) as Record<string, never>, now);
}

/** Whether a stored expiry warrants a refresh-before-use. Null expiry means a
 *  legacy pasted setup-token (long-lived, no refresh token) — never refresh. */
export function needsRefresh(tokenExpiresAt: string | null | undefined, now = Date.now()): boolean {
  if (!tokenExpiresAt) return false;
  const t = new Date(tokenExpiresAt).getTime();
  return Number.isFinite(t) && t <= now;
}
