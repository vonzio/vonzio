/**
 * Ollama Cloud integration service.
 * Self-contained — delete this file to remove the feature.
 */

export const OLLAMA_BASE_URL = "https://ollama.com";

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
