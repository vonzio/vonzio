/**
 * Validates Anthropic API keys / subscription tokens by hitting a lightweight endpoint.
 */

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
): Promise<KeyValidationResult> {
  if (type === "ollama") {
    const { validateOllamaKey } = await import("./ollama-service.js");
    return validateOllamaKey(key);
  }

  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
  };

  if (type === "api_key") {
    headers["x-api-key"] = key;
  } else {
    headers["Authorization"] = `Bearer ${key}`;
  }

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

    // Check known status codes before parsing body
    if (res.status === 401) {
      await res.body?.cancel();
      return { valid: false, error: "Invalid API key" };
    }
    if (res.status === 403) {
      await res.body?.cancel();
      return { valid: false, error: "Key is disabled or lacks permissions" };
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
