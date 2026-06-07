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

export const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com";

export interface OpenAIModel {
  id: string;
  name: string;
}

export async function fetchOpenAIModels(apiKey: string): Promise<OpenAIModel[]> {
  const res = await fetch(`${OPENAI_BASE_URL}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`OpenAI API returned ${res.status}`);
  }
  const data = (await res.json()) as { data?: Array<{ id: string }> };
  return (data.data ?? []).map((m) => ({ id: m.id, name: m.id }));
}

export async function validateOpenAIKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  try {
    await fetchOpenAIModels(apiKey);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}
