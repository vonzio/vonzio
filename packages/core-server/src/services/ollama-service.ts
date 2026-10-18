/**
 * Ollama Cloud integration service. Listing and validation go through byok
 * (see byok-connection.ts); this keeps the endpoint setting and the
 * capabilities probe byok has no equivalent for.
 */

// Defaults to Ollama Cloud. Overridable via env so a self-hoster can point at
// a private/enterprise Ollama deployment or any Anthropic-compatible gateway —
// the value is used both for the model list (here) and, via OLLAMA_TARGET_URL,
// as the in-container proxy's upstream for the agent's LLM calls. The E2E chat
// suite uses this to redirect the agent at a local mock.
export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "https://ollama.com";

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
