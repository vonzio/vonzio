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

// Ollama model capabilities (e.g. "vision", "tools", "thinking") via /api/show.
// Cached by model id — capabilities are static per model. Used to decide whether
// an agent on this model can be sent images (see the agent-runner image guard).
const __capCache = new Map<string, string[]>();
export async function fetchOllamaModelCapabilities(apiKey: string, model: string): Promise<string[]> {
  const cached = __capCache.get(model);
  if (cached) return cached;
  const res = await fetch(`${OLLAMA_BASE_URL}/api/show`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Ollama /api/show returned ${res.status}`);
  const data = (await res.json()) as { capabilities?: string[] };
  const caps = Array.isArray(data.capabilities) ? data.capabilities : [];
  __capCache.set(model, caps);
  return caps;
}

export async function validateOllamaKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  try {
    await fetchOllamaModels(apiKey);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}
