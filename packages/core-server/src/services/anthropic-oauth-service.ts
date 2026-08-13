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
import { encrypt, decrypt } from "../auth/crypto.js";

export const ANTHROPIC_OAUTH_CLIENT_ID =
  process.env.ANTHROPIC_OAUTH_CLIENT_ID ?? "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
// Endpoints + params verified against the LIVE `claude setup-token` (Claude
// Code 2.1.220) — captured from its actual authorize URL, not from older
// reference implementations, several of which predate Anthropic's endpoint
// migrations. Two failure modes those stale constants produced, for the
// record (each only surfaces AFTER the user clicks Authorize, because the
// consent page renders without validating them):
//   - a retired redirect_uri (console.anthropic.com) → grant rejected;
//   - the old six-scope list → grant rejected (only user:inference is
//     grantable to this client now).
export const ANTHROPIC_AUTHORIZE_URL =
  process.env.ANTHROPIC_OAUTH_AUTHORIZE_URL ?? "https://claude.com/cai/oauth/authorize";
export const ANTHROPIC_TOKEN_URL =
  process.env.ANTHROPIC_OAUTH_TOKEN_URL ?? "https://platform.claude.com/v1/oauth/token";
/** Out-of-band display redirect: after consent this page SHOWS the
 *  `code#state` string for the user to copy back — no server callback. */
export const ANTHROPIC_CODE_REDIRECT_URI =
  process.env.ANTHROPIC_OAUTH_REDIRECT_URI ?? "https://platform.claude.com/oauth/code/callback";
/** Exactly what the live setup-token requests — inference only. */
export const ANTHROPIC_OAUTH_SCOPE = "user:inference";

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
 *  mode. `state` is a RANDOM CSRF value — never the PKCE verifier, which must
 *  not appear in a URL (browser history, referrers, consent-page logs). */
export function buildAuthorizeUrl(opts: { state: string; codeChallenge: string }): string {
  // Percent-encoded by hand: URLSearchParams serializes spaces as '+'
  // (form-encoding), and Anthropic's authorize endpoint rejects that with
  // "Authorization failed — Invalid request format". The scope list needs
  // literal %20 separators (verified against the live consent page).
  const params: Array<[string, string]> = [
    ["code", "true"],
    ["client_id", ANTHROPIC_OAUTH_CLIENT_ID],
    ["response_type", "code"],
    ["redirect_uri", ANTHROPIC_CODE_REDIRECT_URI],
    ["scope", ANTHROPIC_OAUTH_SCOPE],
    ["code_challenge", opts.codeChallenge],
    ["code_challenge_method", "S256"],
    ["state", opts.state],
  ];
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `${ANTHROPIC_AUTHORIZE_URL}?${query}`;
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
    // Tolerate stray whitespace around the '#' — copy-paste from the consent
    // page sometimes picks it up, and state comparison is exact.
    const [code, state] = value.split("#", 2).map((p) => p.trim());
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

// ─── Pending sign-ins (stateless, encrypted) ──────────────────────────
//
// The PKCE verifier + CSRF state are NOT held in server memory: auth_id is an
// AES-GCM-encrypted, USER-BOUND token minted with the server's ENCRYPTION_KEY
// and handed back on complete. That makes the flow replica-safe (any instance
// can complete a sign-in another instance started), restart-safe, and
// un-DoS-able (nothing accumulates server-side). Replay of an auth_id within
// its TTL is harmless: the authorization code itself is single-use upstream,
// so a second exchange fails at Anthropic — and the token is bound to the
// initiating user, so nobody else's session can consume it.

interface AuthState {
  /** PKCE verifier (secret — never leaves the encrypted token). */
  v: string;
  /** Random CSRF state echoed through the consent redirect. Distinct from
   *  the verifier: state travels in the authorize URL, the verifier must not. */
  s: string;
  /** Initiating user id — complete() rejects any other caller. */
  u: string;
  /** Mint time (ms). */
  t: number;
}

export interface OAuthStart {
  auth_id: string;
  authorize_url: string;
}

/** Begin a sign-in: mint PKCE + state, seal them into a user-bound auth_id. */
export function startOAuth(userId: string, encryptionKey: string, now = Date.now()): OAuthStart {
  const verifier = generateCodeVerifier();
  // 32 bytes → 43-char state, matching the reference client exactly (some
  // validation surfaces are picky about parameter shapes).
  const state = base64url(randomBytes(32));
  const sealed: AuthState = { v: verifier, s: state, u: userId, t: now };
  const auth_id = Buffer.from(encrypt(JSON.stringify(sealed), encryptionKey)).toString("base64url");
  return {
    auth_id,
    authorize_url: buildAuthorizeUrl({ state, codeChallenge: codeChallengeS256(verifier) }),
  };
}

function unseal(authId: string, encryptionKey: string, now: number): AuthState {
  let parsed: AuthState;
  try {
    parsed = JSON.parse(decrypt(Buffer.from(authId, "base64url").toString("utf8"), encryptionKey)) as AuthState;
  } catch {
    throw new Error("sign-in token invalid — start again");
  }
  if (!parsed.v || !parsed.s || !parsed.u || !parsed.t || now - parsed.t > ANTHROPIC_OAUTH_TIMEOUT_MS) {
    throw new Error("sign-in expired — start again");
  }
  return parsed;
}

export interface AnthropicTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO refresh threshold, NOT the raw upstream expiry: the 5-min skew is
   *  already subtracted here, so api_keys.token_expires_at stores
   *  "refresh at/after this time" and needsRefresh() compares against it
   *  directly with no further margin. */
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

/** Complete a sign-in: unseal the auth token, verify the caller and the
 *  pasted state, exchange the code (PKCE) for tokens. */
export async function completeOAuth(
  authId: string,
  userId: string,
  pastedInput: string,
  encryptionKey: string,
  fetchImpl: FetchLike = defaultFetch,
  now = Date.now(),
): Promise<AnthropicTokens> {
  const sealed = unseal(authId, encryptionKey, now);
  if (sealed.u !== userId) throw new Error("sign-in token belongs to a different user — start again");

  const { code, state } = parseAuthorizationInput(pastedInput);
  if (!code) throw new Error("paste the code shown after approving in the browser");
  // State is REQUIRED: the consent page displays code#state — a paste without
  // it is truncated, and accepting it would waive the CSRF check entirely.
  if (!state) throw new Error("paste the FULL code, including the part after '#'");
  if (state !== sealed.s) throw new Error("OAuth state mismatch — start again");

  const res = await fetchImpl(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      code,
      state,
      redirect_uri: ANTHROPIC_CODE_REDIRECT_URI,
      code_verifier: sealed.v,
    }),
  });
  if (!res.ok) {
    // Detail stays server-side; upstream bodies can echo request params.
    console.error(`[claude-oauth] token exchange failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`);
    throw new Error(`token exchange failed (${res.status}) — check the pasted code and try again`);
  }
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
    console.error(`[claude-oauth] token refresh failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`);
    throw new Error(`token refresh failed (${res.status})`);
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
