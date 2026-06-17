import type { ProfileProvider } from "./types/profile.js";

/** The provider value for a Claude Pro/Max subscription (BYO `sk-ant-oat01-`
 *  OAuth token from `claude setup-token`). Use this constant instead of the
 *  bare string so the OAuth/Bearer branch can't drift on a typo. */
export const CLAUDE_SUBSCRIPTION_PROVIDER: ProfileProvider = "claude_subscription";

/**
 * Single source of truth for how a stored Anthropic credential authenticates
 * against the native Anthropic API (api.anthropic.com), keyed by provider.
 *
 * - Normal API keys (`api_key`, the `sk-ant-api03-…` shape) → `x-api-key`.
 * - Claude subscription OAuth tokens (`claude_subscription`, the
 *   `sk-ant-oat01-…` shape) → `Authorization: Bearer`. Verified 2026-06-16
 *   against a live token: `x-api-key` is rejected 401 for oat tokens; Bearer
 *   works on both /v1/messages and /v1/models. The `oauth-2025-04-20` beta
 *   header is optional for server-side calls (the in-container Agent SDK
 *   injects it itself) so we omit it here.
 *
 * Lives in @vonzio/shared so core-server (key-validator, model-list-service,
 * judge, title generation) AND the built-in plugins (telegram/slack title
 * generation) all authenticate identically and can never drift.
 */
export function anthropicAuthHeaders(
  provider: string | undefined,
  secret: string,
): Record<string, string> {
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (provider === CLAUDE_SUBSCRIPTION_PROVIDER) {
    headers["Authorization"] = `Bearer ${secret}`;
  } else {
    headers["x-api-key"] = secret;
  }
  return headers;
}
