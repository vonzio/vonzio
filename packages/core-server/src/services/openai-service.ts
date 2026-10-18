/**
 * OpenAI (and OpenAI-compatible) endpoint settings. Listing and validation go
 * through byok (see byok-connection.ts); the in-container gateway
 * (packages/llm-gateway) runs the agent runner's Anthropic Messages calls as
 * byok turns against the same root.
 *
 * Defaults to api.openai.com. Override OPENAI_BASE_URL to point at any
 * OpenAI-compatible endpoint (Azure OpenAI gateway, OpenRouter, a local
 * vLLM/LM Studio server, etc.) — the same value is forwarded into the
 * container as the gateway's upstream.
 */

export const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com";

/**
 * Normalize a user-supplied OpenAI-compatible base URL to the host root that
 * the gateway and these REST calls expect (they append `/v1/...`). Tolerates
 * a pasted `/v1` suffix and trailing slashes, so `https://api.openai.com`,
 * `https://api.openai.com/`, and `https://api.openai.com/v1` all resolve the
 * same. An empty/blank value falls back to the server default.
 */
export function normalizeOpenAIBaseUrl(url?: string | null): string {
  const trimmed = (url ?? "").trim();
  let base = trimmed || OPENAI_BASE_URL;
  // Tolerate a scheme-less paste like "api.x.ai" — without this the gateway's
  // `new URL(target)` throws and the agent container crashes on first call.
  // Default to https; an explicit http:// (local vLLM/LM Studio) is preserved.
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return base.replace(/\/+$/, "").replace(/\/v1$/, "");
}
