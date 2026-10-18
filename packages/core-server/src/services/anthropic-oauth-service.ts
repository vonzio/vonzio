/**
 * Anthropic Claude Pro/Max subscription sign-in: the credential-acquisition
 * half of the `claude_subscription` provider, replacing "run `claude
 * setup-token` locally and paste it" with a server-owned flow: button →
 * Anthropic consent page → the user pastes the displayed `code#state` → we
 * exchange it for access + refresh tokens and rotate them server-side.
 *
 * The flow itself (PKCE, the out-of-band display mode, the token endpoints,
 * the same public client id `claude setup-token` uses) is byok's
 * `@amenophis1er/byok/core/auth`. What stays here is what a server owns:
 *
 * - **Pending sign-ins are stateless.** The PKCE verifier + CSRF state are
 *   not held in memory: `auth_id` is an AES-GCM-encrypted, USER-BOUND token
 *   minted with the server's ENCRYPTION_KEY and handed back on complete.
 *   Replica-safe, restart-safe, nothing accumulates server-side. Replay
 *   within the TTL is harmless (the code is single-use upstream) and bound
 *   to the initiating user.
 * - **Expiry is stored as a refresh threshold.** Anthropic access tokens are
 *   opaque, so `expiresAt` is the ISO time to refresh at (upstream expiry
 *   minus a 5-minute skew), persisted in api_keys.token_expires_at.
 * - **Upstream error bodies stay server-side.** They can echo request
 *   parameters; the thrown message carries the status only.
 *
 * Same ToS posture as the Codex flow: Anthropic may stop honoring
 * subscription tokens outside its own apps at any time.
 */
import {
  exchangeCode,
  parsePaste,
  refreshTokens,
  startLogin,
  type AnthropicTokens as ByokTokens,
} from "@amenophis1er/byok/core/auth";
import { encrypt, decrypt } from "../auth/crypto.js";

/** A pending sign-in is abandoned after 15 minutes. */
export const ANTHROPIC_OAUTH_TIMEOUT_MS = 15 * 60 * 1000;

/** Refresh when within this skew of expiry (mirrors the Codex 5-min margin). */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** Parse whatever the user pastes back: `code#state`, a redirect URL, or a bare code. */
export const parseAuthorizationInput = parsePaste;

interface AuthState {
  /** PKCE verifier (secret — never leaves the encrypted token). */
  v: string;
  /** Random CSRF state echoed through the consent redirect. */
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

/** Begin a sign-in: byok mints PKCE + state; they're sealed into a user-bound auth_id. */
export async function startOAuth(userId: string, encryptionKey: string, now = Date.now()): Promise<OAuthStart> {
  const { verifier, state, authorizeUrl } = await startLogin();
  const sealed: AuthState = { v: verifier, s: state, u: userId, t: now };
  const auth_id = Buffer.from(encrypt(JSON.stringify(sealed), encryptionKey)).toString("base64url");
  return { auth_id, authorize_url: authorizeUrl };
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
   *  already subtracted, so api_keys.token_expires_at stores "refresh at/after
   *  this time" and needsRefresh() compares against it with no further margin. */
  expiresAt: string;
}

function toStored(tokens: ByokTokens): AnthropicTokens {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: new Date(tokens.expiresAt - EXPIRY_SKEW_MS).toISOString(),
  };
}

/** byok's HTTP failures read "Token exchange failed (400): <body>"; keep the
 *  status, drop the body (it can echo request params), log the detail. */
function sanitized(what: string, err: unknown, hint = ""): Error {
  const message = err instanceof Error ? err.message : String(err);
  const status = /\((\d{3})\)/.exec(message)?.[1];
  if (!status) return err instanceof Error ? err : new Error(message);
  console.error(`[claude-oauth] ${what} failed (${status}): ${message.slice(0, 300)}`);
  return new Error(`${what} failed (${status})${hint}`);
}

/** Complete a sign-in: unseal, verify the caller, exchange the pasted code (byok checks the state). */
export async function completeOAuth(
  authId: string,
  userId: string,
  pastedInput: string,
  encryptionKey: string,
  now = Date.now(),
): Promise<AnthropicTokens> {
  const sealed = unseal(authId, encryptionKey, now);
  if (sealed.u !== userId) throw new Error("sign-in token belongs to a different user — start again");
  try {
    return toStored(await exchangeCode({ pasted: pastedInput, expectedState: sealed.s, verifier: sealed.v }));
  } catch (err) {
    throw sanitized("token exchange", err, " — check the pasted code and try again");
  }
}

/** Refresh grant. The refresh token is SINGLE-USE and rotates — callers must
 *  persist the returned pair (see ProfileService's refresh-before-use). */
export async function refreshAnthropicTokens(refreshToken: string): Promise<AnthropicTokens> {
  try {
    return toStored(await refreshTokens(refreshToken));
  } catch (err) {
    throw sanitized("token refresh", err);
  }
}

/** Whether a stored expiry warrants a refresh-before-use. Null expiry means a
 *  legacy pasted setup-token (long-lived, no refresh token) — never refresh. */
export function needsRefresh(tokenExpiresAt: string | null | undefined, now = Date.now()): boolean {
  if (!tokenExpiresAt) return false;
  const t = new Date(tokenExpiresAt).getTime();
  return Number.isFinite(t) && t <= now;
}
