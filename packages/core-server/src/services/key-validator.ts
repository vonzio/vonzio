/**
 * "Test connection" for a stored or pasted credential. Every provider goes
 * through byok's `listModels` (a cheap, auth-checked GET), except a ChatGPT
 * access token, which is checked offline: the Codex catalog call would fail
 * on an expired token that the resolve-time refresh renews before real use.
 *
 * An Ollama Cloud key is checked against GET /api/balance instead: ollama.com
 * serves its model list without authentication, so listing would pass any
 * string as a valid key. The balance endpoint is free and rejects a bad key
 * with 401.
 */
import type { ProfileProvider } from "@vonzio/shared";
import { describeFailure, listModelsFor, LIST_TIMEOUT_MS } from "./byok-connection.js";
import { OLLAMA_BASE_URL } from "./ollama-service.js";

export { SUBSCRIPTION_TOKEN_INVALID, SUBSCRIPTION_LIMIT_REACHED } from "./byok-connection.js";

export interface KeyValidationResult {
  valid: boolean;
  error?: string;
}

export async function validateAnthropicKey(
  key: string,
  type: ProfileProvider = "api_key",
  baseUrl?: string | null,
  /** opencode: the organization stored with the token. */
  accountId?: string | null,
): Promise<KeyValidationResult> {
  if (type === "openai_subscription") {
    const { expiryFromAccessToken } = await import("./codex-oauth-service.js");
    const exp = expiryFromAccessToken(key);
    if (exp === 0) return { valid: false, error: "Not a valid ChatGPT access token." };
    if (exp <= Date.now()) return { valid: false, error: "ChatGPT session expired — sign in again." };
    return { valid: true };
  }

  if (type === "ollama") return validateOllamaKey(key);

  try {
    await listModelsFor({ provider: type, api_key: key, base_url: baseUrl, account_id: accountId });
    return { valid: true };
  } catch (err) {
    return { valid: false, error: describeFailure(type, err) };
  }
}

/**
 * An Ollama Cloud key, through an endpoint that actually requires it. A root
 * without /api/balance (a 404/405 from an older or stand-in server) falls
 * back to listing models, which at least proves the root is reachable.
 */
async function validateOllamaKey(key: string): Promise<KeyValidationResult> {
  if (!key) return { valid: false, error: "Enter an API key first." };
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_BASE_URL.replace(/\/+$/, "")}/api/balance`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { valid: false, error: timedOut ? "Provider unreachable (timeout)" : `Provider unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.ok) return { valid: true };
  if (res.status === 401) return { valid: false, error: "Invalid API key" };
  if (res.status === 403) return { valid: false, error: "Key is disabled or lacks permissions" };
  if (res.status === 404 || res.status === 405) {
    try {
      await listModelsFor({ provider: "ollama", api_key: key });
      return { valid: true };
    } catch (err) {
      return { valid: false, error: describeFailure("ollama", err) };
    }
  }
  const body = await res.text().catch(() => "");
  return { valid: false, error: describeFailure("ollama", new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`.trim())) };
}
