/**
 * Single source of truth for how a stored Anthropic credential authenticates
 * against the native Anthropic API (api.anthropic.com), keyed by provider.
 *
 * - Normal API keys (`api_key`, the `sk-ant-api03-…` shape) → `x-api-key`.
 * - Claude subscription OAuth tokens (`claude_subscription`, the
 *   `sk-ant-oat01-…` shape from `claude setup-token`) → `Authorization: Bearer`.
 *   Verified 2026-06-16 against a live token: `x-api-key` is rejected 401 for
 *   oat tokens, Bearer works on both /v1/messages and /v1/models. The
 *   `oauth-2025-04-20` beta header is optional for server-side calls (the
 *   in-container Agent SDK injects it itself) so we omit it here.
 *
 * Used by key-validator, model-list-service, and the server-side judge so the
 * three direct-to-Anthropic call sites can never drift on auth.
 */
export function anthropicAuthHeaders(
  provider: string | undefined,
  secret: string,
): Record<string, string> {
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (provider === "claude_subscription") {
    headers["Authorization"] = `Bearer ${secret}`;
  } else {
    headers["x-api-key"] = secret;
  }
  return headers;
}
