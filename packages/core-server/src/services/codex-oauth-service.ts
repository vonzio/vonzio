/**
 * OpenAI Codex subscription (Sign in with ChatGPT): the credential-acquisition
 * half of the `openai_subscription` provider. The inference half is the
 * in-container gateway (packages/llm-gateway, codex mode).
 *
 * The device flow itself (non-standard: polls by `device_auth_id`, approval
 * returns an authorization code + server-issued verifier, exchanged at the
 * device redirect) is byok's `@amenophis1er/byok/core/auth`, which also
 * decodes the account id and expiry from the JWT. What stays here:
 *
 * - the curated Codex model list (the picker's fallback when the live
 *   catalog is unavailable, and the `CODEX_MODELS` env override);
 * - the stored-token shape (`CodexTokens`) and the refresh-before-use
 *   helpers ProfileService drives.
 *
 * ToS posture: a personal credential used against the consumer ChatGPT terms
 * (tolerated, not permitted); see features/0047.
 */
import {
  accountIdFromJwt as byokAccountIdFromJwt,
  exchangeDeviceCode,
  pollDevice,
  refreshOpenAiTokens,
  startDeviceLogin as byokStartDeviceLogin,
  type OpenAiTokens,
} from "@amenophis1er/byok/core/auth";

/** Models reachable via a ChatGPT subscription through the Codex backend, used
 *  when the live catalog (byok `listModels`) can't be fetched. Flagship first.
 *  Actual availability depends on the plan tier. */
export const CODEX_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
] as const;

/** The Codex model list to surface, honoring a `CODEX_MODELS` env override
 *  (comma/space-separated ids) so an operator can pin the list without a
 *  release. Falls back to the baked default when unset/empty. */
export function codexModels(): string[] {
  const raw = (process.env.CODEX_MODELS ?? "").trim();
  if (!raw) return [...CODEX_MODELS];
  const ids = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return ids.length > 0 ? ids : [...CODEX_MODELS];
}

export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry (epoch ms): the JWT's `exp`, else from `expires_in`. */
  expiresAt: number;
  /** ChatGPT account id, decoded from the token — the Codex backend wants it
   *  as a request header for workspace/team tokens. */
  accountId?: string;
}

const toStored = (t: OpenAiTokens): CodexTokens => ({
  accessToken: t.accessToken,
  refreshToken: t.refreshToken,
  expiresAt: t.expiresAt,
  accountId: t.accountId,
});

/** Decode the ChatGPT account id from a Codex JWT (no signature check — it's
 *  only a routing header). Undefined on any malformed input. */
export const accountIdFromJwt = (jwt: string): string | undefined => byokAccountIdFromJwt(jwt) || undefined;

/** True when a token is expired or within `skewMs` of expiring. Pure. */
export function needsRefresh(tokens: Pick<CodexTokens, "expiresAt">, now = Date.now(), skewMs = 5 * 60 * 1000): boolean {
  return tokens.expiresAt - now <= skewMs;
}

/** Absolute expiry (epoch ms) from an access-token JWT's `exp` claim; 0 (treat
 *  as expired) when the token is malformed or has no exp. Pure. */
export function expiryFromAccessToken(jwt: string): number {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return 0;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export interface DeviceCodeStart {
  /** The Codex device flow keys polls by `device_auth_id`, not `device_code`. */
  deviceAuthId: string;
  userCode: string;
  verifyUrl: string;
  intervalSec: number;
  /** Absolute epoch ms after which polling should stop. */
  expiresAt: number;
}

/** Kick off the device flow. A 404 upstream means the account hasn't enabled
 *  device-code login; byok words that for the user. */
export async function startDeviceLogin(): Promise<DeviceCodeStart> {
  return byokStartDeviceLogin();
}

export type DevicePoll =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "authorized"; authorizationCode: string; codeVerifier: string }
  | { status: "denied"; error: string };

/** One poll. On approval it returns an authorization code + verifier for
 *  `exchangeAuthCode`, not tokens. Single-shot so the wait loop stays the route's. */
export async function pollDeviceToken(deviceAuthId: string, userCode: string): Promise<DevicePoll> {
  return pollDevice(deviceAuthId, userCode);
}

/** Exchange the approval for tokens (device redirect URI). */
export async function exchangeAuthCode(opts: { code: string; codeVerifier: string }): Promise<CodexTokens> {
  return toStored(await exchangeDeviceCode({ authorizationCode: opts.code, codeVerifier: opts.codeVerifier }));
}

/** Rotate a refresh token. SINGLE-USE: the caller must persist the returned
 *  pair. A response omitting refresh_token keeps the old one. */
export async function refreshTokens(refreshToken: string): Promise<CodexTokens> {
  return toStored(await refreshOpenAiTokens(refreshToken));
}
