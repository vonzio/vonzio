/**
 * Ollama Cloud integration service.
 * Self-contained — delete this file to remove the feature.
 */

// Defaults to Ollama Cloud. Overridable via env so a self-hoster can point at
// a private/enterprise Ollama deployment or any Anthropic-compatible gateway —
// the value is used both for the model list (here) and, via OLLAMA_TARGET_URL,
// as the in-container proxy's upstream for the agent's LLM calls. The E2E chat
// suite uses this to redirect the agent at a local mock.
export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "https://ollama.com";

export interface OllamaModel {
  id: string;
  name: string;
}

export async function fetchOllamaModels(apiKey: string): Promise<OllamaModel[]> {
  const res = await fetch(`${OLLAMA_BASE_URL}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Ollama API returned ${res.status}`);
  }
  const data = (await res.json()) as { data: Array<{ id: string }> };
  return data.data.map((m) => ({ id: m.id, name: m.id }));
}

export async function validateOllamaKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  try {
    await fetchOllamaModels(apiKey);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}
