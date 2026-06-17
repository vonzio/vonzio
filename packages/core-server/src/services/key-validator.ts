/**
 * Validates Anthropic / Ollama API keys by hitting a lightweight endpoint.
 */
import { anthropicAuthHeaders } from "./anthropic-auth.js";

export interface KeyValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate an Anthropic API key by calling /v1/models.
 * Returns { valid: true } or { valid: false, error: "..." }.
 */
export async function validateAnthropicKey(
  key: string,
  type: import("@vonzio/shared").ProfileProvider = "api_key",
  baseUrl?: string | null,
): Promise<KeyValidationResult> {
  if (type === "ollama") {
    const { validateOllamaKey } = await import("./ollama-service.js");
    return validateOllamaKey(key);
  }

  if (type === "openai") {
    const { validateOpenAIKey } = await import("./openai-service.js");
    return validateOpenAIKey(key, baseUrl);
  }

  // api_key → x-api-key; claude_subscription → Authorization: Bearer.
  // /v1/models is accepted by both (verified against a live oat token).
  const headers = anthropicAuthHeaders(type, key);

  try {
    const res = await fetch("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      await res.body?.cancel(); // release connection back to pool
      return { valid: true };
    }

    // Subscription oat tokens expire (~1yr, no refresh) and hit the Pro/Max
    // session caps — give those failures provider-specific guidance instead of
    // the generic API-key copy.
    const isSubscription = type === "claude_subscription";

    // Check known status codes before parsing body
    if (res.status === 401) {
      await res.body?.cancel();
      return {
        valid: false,
        error: isSubscription
          ? "Token expired or invalid — re-run `claude setup-token` and paste the new token"
          : "Invalid API key",
      };
    }
    if (res.status === 403) {
      await res.body?.cancel();
      return { valid: false, error: "Key is disabled or lacks permissions" };
    }
    if (res.status === 429) {
      await res.body?.cancel();
      return {
        valid: false,
        error: isSubscription
          ? "Claude subscription limit reached — try again later"
          : "Rate limit reached — try again later",
      };
    }

    // Parse body only for unexpected status codes
    const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
    const errorMsg = body?.error?.message ?? `HTTP ${res.status}`;
    return { valid: false, error: errorMsg };
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { valid: false, error: "Anthropic API unreachable (timeout)" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, error: `Connection failed: ${msg}` };
  }
}
