/**
 * OpenAI (and OpenAI-compatible) integration service.
 * Self-contained — delete this file plus docker/llm-gateway.cjs to remove the
 * feature.
 *
 * vonzio's agent runner speaks the Anthropic Messages API; the in-container
 * `llm-gateway.cjs` translates that to OpenAI Chat Completions. This service
 * only handles the dashboard-side concerns: listing models and validating keys
 * against the OpenAI-compatible REST surface (`/v1/models`, Bearer auth).
 *
 * Defaults to api.openai.com. Override OPENAI_BASE_URL to point at any
 * OpenAI-compatible endpoint (Azure OpenAI gateway, OpenRouter, a local
 * vLLM/LM Studio server, etc.) — the same value is forwarded into the
 * container as the gateway's upstream.
 */

import { safeFetchCore } from "../lib/safe-webhook-fetch.js";

export const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com";

export interface OpenAIModel {
  id: string;
  name: string;
}

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

export async function fetchOpenAIModels(apiKey: string, baseUrl?: string | null): Promise<OpenAIModel[]> {
  const root = normalizeOpenAIBaseUrl(baseUrl);
  // `root` derives from a fully user-supplied base_url, so this is an SSRF sink
  // (cloud-metadata cred theft / internal port scan via 169.254.169.254,
  // 127.0.0.1:PORT, RFC1918, etc.). Route through the SSRF-safe fetch helper:
  // it rejects non-http(s) schemes, resolves the host and blocks private/
  // loopback/link-local/reserved IPs BEFORE connecting, and pins the connection
  // to the validated IP (DNS-rebind defense). Legitimate public endpoints
  // (api.openai.com, openrouter, etc.) are unaffected.
  const res = await safeFetchCore(
    `${root}/v1/models`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    { timeoutMs: 10_000 },
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`OpenAI API returned ${res.status}`);
  }
  const data = JSON.parse(new TextDecoder("utf-8").decode(res.bytes)) as {
    data?: Array<{ id: string }>;
  };
  return (data.data ?? []).map((m) => ({ id: m.id, name: m.id }));
}

export async function validateOpenAIKey(apiKey: string, baseUrl?: string | null): Promise<{ valid: boolean; error?: string }> {
  try {
    await fetchOpenAIModels(apiKey, baseUrl);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}
