/**
 * OpenCode (Sign in with OpenCode): the credential-acquisition half of the
 * `opencode` provider. The inference half is the in-container gateway
 * (packages/llm-gateway, opencode mode).
 *
 * The flow is a plain RFC 8628 device grant against the OpenCode Console,
 * implemented by byok's `@amenophis1er/byok/core/auth`. OpenCode accepts any
 * client id and shows it on the approval page, so vonzio names itself.
 * Tokens are opaque (no JWT): the expiry comes from `expires_in` and is
 * persisted in api_keys.token_expires_at, the organization in
 * api_keys.account_id.
 *
 * The token reaches OpenCode's paid models only: the free tier answers 403
 * to any client but OpenCode's own (see OPENCODE_FREE_TIER).
 */
import {
  OPENCODE_BASE,
  pollOpencode,
  refreshOpencodeTokens,
  startOpencodeLogin,
  type OpencodeTokens as ByokOpencodeTokens,
} from "@amenophis1er/byok/core/auth";

export { OPENCODE_BASE };

/** Shown on OpenCode's approval page. */
export const OPENCODE_CLIENT_ID = "vonzio";

/** User-facing copy for the 403 a free-tier account gets from a third-party client. */
export const OPENCODE_FREE_TIER =
  "OpenCode's free tier only works in OpenCode's own apps; a paid plan is needed.";

/** Refresh this long before the upstream expiry. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export interface OpencodeTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO refresh threshold (upstream expiry minus the skew), as stored in
   *  api_keys.token_expires_at; needsRefresh compares against it directly. */
  expiresAt: string;
  /** The organization the token was issued for (x-opencode-org-id). */
  orgId?: string;
}

const toStored = (t: ByokOpencodeTokens): OpencodeTokens => ({
  accessToken: t.accessToken,
  refreshToken: t.refreshToken,
  expiresAt: new Date(t.expiresAt - EXPIRY_SKEW_MS).toISOString(),
  ...(t.orgId ? { orgId: t.orgId } : {}),
});

export interface OpencodeDeviceStart {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  intervalSec: number;
  /** Absolute epoch ms after which polling should stop. */
  expiresAt: number;
}

/** Kick off the device grant under vonzio's client id. */
export function startDeviceLogin(): Promise<OpencodeDeviceStart> {
  return startOpencodeLogin(OPENCODE_CLIENT_ID);
}

export type OpencodePoll =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "authorized"; tokens: OpencodeTokens }
  | { status: "denied"; error: string };

/** One poll of the token endpoint. Single-shot so the wait loop stays the client's. */
export async function pollDeviceToken(deviceCode: string): Promise<OpencodePoll> {
  const poll = await pollOpencode(deviceCode, OPENCODE_CLIENT_ID);
  return poll.status === "authorized" ? { status: "authorized", tokens: toStored(poll.tokens) } : poll;
}

/** Rotate the token pair; the caller must persist the result. */
export async function refreshTokens(refreshToken: string): Promise<OpencodeTokens> {
  return toStored(await refreshOpencodeTokens(refreshToken, OPENCODE_CLIENT_ID));
}

/** Whether a stored refresh threshold has passed. Null means unknown: refresh. */
export function needsRefresh(tokenExpiresAt: string | null | undefined, now = Date.now()): boolean {
  if (!tokenExpiresAt) return true;
  const t = new Date(tokenExpiresAt).getTime();
  return !Number.isFinite(t) || t <= now;
}
