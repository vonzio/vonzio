/**
 * OpenAI Codex subscription (Sign in with ChatGPT) OAuth service.
 * Self-contained — the credential-acquisition half of the `openai_subscription`
 * provider. The inference half lives in docker/llm-gateway.cjs (Codex mode).
 *
 * Why this exists: a ChatGPT Plus/Pro subscription is far cheaper per token than
 * a metered API key, and OpenAI's Codex CLI reaches it via an OAuth device flow.
 * We reimplement that flow so a Vonzio agent can run on the user's own
 * subscription. See features/0047 for the full design, the ToS caveats (this is
 * *tolerated, not permitted* — a personal credential used against the consumer
 * ChatGPT terms), and the SaaS gating.
 *
 * The token this yields does NOT work against api.openai.com — Codex inference
 * goes to a separate backend (https://chatgpt.com/backend-api/codex). This
 * module only handles credential acquisition + refresh; it never calls the
 * inference backend.
 *
 * Constants are verified against the openai/codex source. The client_id is
 * OpenAI's own Codex CLI app id (there is no separate "third-party" client to
 * register), overridable via CODEX_OAUTH_CLIENT_ID for future-proofing.
 */

import { createHash, randomBytes } from "node:crypto";

export const CODEX_ISSUER = process.env.CODEX_OAUTH_ISSUER ?? "https://auth.openai.com";
export const CODEX_CLIENT_ID = process.env.CODEX_OAUTH_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann";
/** Loopback redirect the Codex CLI registers; used by the browser auth-code (PKCE) leg. */
export const CODEX_REDIRECT_URI = process.env.CODEX_OAUTH_REDIRECT_URI ?? "http://localhost:1455/auth/callback";
/** Redirect URI the DEVICE-code exchange must use (differs from the loopback one). */
export const CODEX_DEVICE_REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`;
/** Minimum scopes third-party reimplementations send (drop the connector scopes). */
export const CODEX_SCOPE = "openid profile email offline_access";
/** JWT claim namespace carrying `chatgpt_account_id`. */
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

/** Models reachable via a ChatGPT subscription through the Codex backend. The
 *  Codex backend has no cheap enumeration endpoint (even the Codex CLI/Pi bake a
 *  static list), so this is a curated list the model picker renders — kept in
 *  sync with the Codex CLI's set. Flagship first. Actual availability depends on
 *  the plan tier (some are Pro-only); an unavailable pick surfaces a clear error.
 *  Update as OpenAI ships new Codex models. */
export const CODEX_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
] as const;
/** Device-code login times out after 15 minutes (the server doesn't return an
 *  expiry in the usercode response, so this constant bounds the poll loop). */
export const CODEX_DEVICE_TIMEOUT_MS = 15 * 60 * 1000;

const AUTHORIZE_URL = `${CODEX_ISSUER}/oauth/authorize`;
const TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
const DEVICE_USERCODE_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/token`;
/** Where the user is told to go to approve a device-code login. */
export const CODEX_DEVICE_VERIFY_URL = `${CODEX_ISSUER}/codex/device`;

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

/** A fresh PKCE verifier (43–128 chars, base64url of 32 random bytes). Pure-ish
 *  (uses CSPRNG); the transform below is what the tests pin. */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/** S256 challenge for a verifier — `base64url(sha256(verifier))`. Pure. */
export function codeChallengeS256(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** Build the authorize URL for the loopback/PKCE leg. Pure. The Codex-specific
 *  query params (`id_token_add_organizations`, `codex_cli_simplified_flow`) are
 *  what the backend expects from a Codex client; `originator` is intentionally
 *  ours by default (truthful), see features/0047 §5. */
export function buildAuthorizeUrl(opts: {
  state: string;
  codeChallenge: string;
  redirectUri?: string;
  originator?: string;
}): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", CODEX_CLIENT_ID);
  u.searchParams.set("redirect_uri", opts.redirectUri ?? CODEX_REDIRECT_URI);
  u.searchParams.set("scope", CODEX_SCOPE);
  u.searchParams.set("code_challenge", opts.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", opts.state);
  u.searchParams.set("id_token_add_organizations", "true");
  u.searchParams.set("codex_cli_simplified_flow", "true");
  u.searchParams.set("originator", opts.originator ?? "vonzio");
  return u.toString();
}

// ─── Token shapes ─────────────────────────────────────────────────────

export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Absolute expiry (epoch ms) derived from the response's `expires_in`. */
  expiresAt: number;
  /** ChatGPT account id, decoded from the id_token — required as a request
   *  header by the Codex backend for workspace/team tokens. */
  accountId?: string;
}

/** Normalize an OAuth token JSON response into our stored shape. Pure.
 *  `now` is injectable so the expiry math is testable. */
export function parseTokenResponse(raw: unknown, now = Date.now()): CodexTokens {
  const r = (raw ?? {}) as Record<string, unknown>;
  const accessToken = typeof r.access_token === "string" ? r.access_token : "";
  const refreshToken = typeof r.refresh_token === "string" ? r.refresh_token : "";
  const idToken = typeof r.id_token === "string" ? r.id_token : undefined;
  if (!accessToken) throw new Error("token response missing access_token");
  // Default to a conservative 15-minute lifetime if the server omits expires_in;
  // the caller refreshes proactively before this anyway.
  const expiresInSec = typeof r.expires_in === "number" && r.expires_in > 0 ? r.expires_in : 900;
  // The account id lives in BOTH the access and id tokens; the working Codex
  // clients decode it from the access token, so prefer that and fall back.
  const accountId = accountIdFromJwt(accessToken) ?? (idToken ? accountIdFromJwt(idToken) : undefined);
  return {
    accessToken,
    refreshToken,
    idToken,
    expiresAt: now + expiresInSec * 1000,
    accountId,
  };
}

/** Decode the ChatGPT account id from a Codex JWT (access or id token) WITHOUT
 *  verifying its signature — clients don't hold OpenAI's signing key; the value
 *  is only a routing header, and the token itself is the bearer credential.
 *  Reads `chatgpt_account_id` under the `https://api.openai.com/auth` namespace.
 *  Returns undefined on any malformed input rather than throwing. Pure. */
export function accountIdFromJwt(jwt: string): string | undefined {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return undefined;
    const payloadJson = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const ns = payload[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
    const id = ns?.chatgpt_account_id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** True when a token is expired or within `skewMs` of expiring — i.e. should be
 *  refreshed before the next use. Pure. */
export function needsRefresh(tokens: Pick<CodexTokens, "expiresAt">, now = Date.now(), skewMs = 5 * 60 * 1000): boolean {
  return tokens.expiresAt - now <= skewMs;
}

/** Absolute expiry (epoch ms) decoded from an access-token JWT's `exp` claim,
 *  so the refresh-before-use path can check expiry without a stored column.
 *  Returns 0 (treat as expired) when the token is malformed or has no exp. Pure. */
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

// ─── Network legs (device-code flow + refresh) ────────────────────────

export interface DeviceCodeStart {
  /** The Codex device flow keys polls by `device_auth_id`, not the RFC-8628
   *  `device_code`. */
  deviceAuthId: string;
  userCode: string;
  verifyUrl: string;
  /** Seconds between polls the server asks us to honor. */
  intervalSec: number;
  /** Absolute epoch ms after which polling should stop. */
  expiresAt: number;
}

/** Kick off the Codex device flow. The user visits `verifyUrl` and enters
 *  `userCode`; we then poll with `pollDeviceToken`. The usercode response body
 *  is just `{ client_id }` and returns `device_auth_id` + `user_code` +
 *  `interval` (interval may be a string). A 404 means the account hasn't enabled
 *  device-code login (Settings → Security). */
export async function startDeviceLogin(fetchImpl: FetchLike = defaultFetch, now = Date.now()): Promise<DeviceCodeStart> {
  const res = await fetchImpl(DEVICE_USERCODE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error("device-code login is not enabled on this ChatGPT account (Settings → Security → allow device code login)");
    }
    throw new Error(`device login start failed (${res.status}): ${await res.text()}`);
  }
  const j = (await res.json()) as Record<string, unknown>;
  const deviceAuthId = typeof j.device_auth_id === "string" ? j.device_auth_id : "";
  const userCode = typeof j.user_code === "string" ? j.user_code : "";
  if (!deviceAuthId || !userCode) throw new Error(`device login start returned no code: ${JSON.stringify(j)}`);
  const rawInterval = typeof j.interval === "string" ? Number(j.interval.trim()) : j.interval;
  const intervalSec = typeof rawInterval === "number" && Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 5;
  return {
    deviceAuthId,
    userCode,
    verifyUrl: CODEX_DEVICE_VERIFY_URL,
    intervalSec,
    expiresAt: now + CODEX_DEVICE_TIMEOUT_MS,
  };
}

export type DevicePoll =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "authorized"; authorizationCode: string; codeVerifier: string }
  | { status: "denied"; error: string };

/** One poll of the device-token endpoint. Unlike a standard device flow this
 *  does NOT return tokens — on approval it returns an `authorization_code` +
 *  server-generated `code_verifier`, which the caller then exchanges via
 *  `exchangeAuthCode(..., CODEX_DEVICE_REDIRECT_URI)`. 403/404 (and the
 *  `deviceauth_authorization_pending` error, possibly nested under `error.code`)
 *  mean "keep polling". Kept single-shot so the wait loop is timer-free-testable. */
export async function pollDeviceToken(deviceAuthId: string, userCode: string, fetchImpl: FetchLike = defaultFetch): Promise<DevicePoll> {
  const res = await fetchImpl(DEVICE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
  });
  if (res.ok) {
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const authorizationCode = typeof j.authorization_code === "string" ? j.authorization_code : "";
    const codeVerifier = typeof j.code_verifier === "string" ? j.code_verifier : "";
    if (authorizationCode && codeVerifier) return { status: "authorized", authorizationCode, codeVerifier };
    return { status: "denied", error: `malformed device token response: ${JSON.stringify(j)}` };
  }
  if (res.status === 403 || res.status === 404) return { status: "pending" };
  const bodyText = await res.text().catch(() => "");
  let code: unknown;
  try {
    const err = (JSON.parse(bodyText) as { error?: string | { code?: string } }).error;
    code = typeof err === "object" ? err?.code : err;
  } catch { /* non-JSON body */ }
  if (code === "deviceauth_authorization_pending") return { status: "pending" };
  if (code === "slow_down") return { status: "slow_down" };
  return { status: "denied", error: `device auth failed (${res.status})${bodyText ? `: ${bodyText}` : ""}` };
}

/** Exchange the loopback auth code (+ PKCE verifier) for tokens. */
export async function exchangeAuthCode(opts: {
  code: string;
  codeVerifier: string;
  redirectUri?: string;
}, fetchImpl: FetchLike = defaultFetch, now = Date.now()): Promise<CodexTokens> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CODEX_CLIENT_ID,
      code: opts.code,
      code_verifier: opts.codeVerifier,
      redirect_uri: opts.redirectUri ?? CODEX_REDIRECT_URI,
    }).toString(),
  });
  if (!res.ok) throw new Error(`code exchange failed (${res.status}): ${await res.text()}`);
  return parseTokenResponse(await res.json(), now);
}

/** Rotate a refresh token for a fresh access token. OpenAI's refresh tokens are
 *  SINGLE-USE — the response returns a new refresh_token that MUST be persisted,
 *  or the next refresh 401s. The caller is responsible for storing the returned
 *  `refreshToken`. */
export async function refreshTokens(refreshToken: string, fetchImpl: FetchLike = defaultFetch, now = Date.now()): Promise<CodexTokens> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CODEX_CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!res.ok) throw new Error(`token refresh failed (${res.status}): ${await res.text()}`);
  const tokens = parseTokenResponse(await res.json(), now);
  // A refresh response may omit refresh_token (non-rotating servers) — keep the
  // old one so we don't lose the durable credential.
  if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
  return tokens;
}
