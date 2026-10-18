/**
 * "Test connection" for a stored or pasted credential. Every provider goes
 * through byok's `listModels` (a cheap, auth-checked GET), except a ChatGPT
 * access token, which is checked offline: the Codex catalog call would fail
 * on an expired token that the resolve-time refresh renews before real use.
 */
import type { ProfileProvider } from "@vonzio/shared";
import { describeFailure, listModelsFor } from "./byok-connection.js";

export { SUBSCRIPTION_TOKEN_INVALID, SUBSCRIPTION_LIMIT_REACHED } from "./byok-connection.js";

export interface KeyValidationResult {
  valid: boolean;
  error?: string;
}

export async function validateAnthropicKey(
  key: string,
  type: ProfileProvider = "api_key",
  baseUrl?: string | null,
): Promise<KeyValidationResult> {
  if (type === "openai_subscription") {
    const { expiryFromAccessToken } = await import("./codex-oauth-service.js");
    const exp = expiryFromAccessToken(key);
    if (exp === 0) return { valid: false, error: "Not a valid ChatGPT access token." };
    if (exp <= Date.now()) return { valid: false, error: "ChatGPT session expired — sign in again." };
    return { valid: true };
  }

  try {
    await listModelsFor({ provider: type, api_key: key, base_url: baseUrl });
    return { valid: true };
  } catch (err) {
    return { valid: false, error: describeFailure(type, err) };
  }
}
