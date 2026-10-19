/**
 * Friendly display names for known model IDs.
 *
 * Used by both the composer's `ModelPicker` and the `WorkspaceHeader` model
 * readout when the server's `/v1/profiles/:id/models` endpoint hasn't loaded
 * yet (or returned an empty list). Keeping a single source means a new model
 * shipped by Anthropic only needs to be added here once.
 */
export const MODEL_DISPLAY_FALLBACK: Record<string, string> = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-fable-5": "Claude Fable 5",
  "claude-fable-5-1": "Claude Fable 5.1",
};

/**
 * Provider names for a key's `provider` kind, matching the Keys page and
 * onboarding. `short` is what the composer chip shows in front of the model
 * (it has to stay compact); `full` is the tooltip and info-panel wording.
 */
export const PROVIDER_LABELS: Record<string, { short: string; full: string }> = {
  api_key: { short: "Anthropic", full: "Anthropic API" },
  claude_subscription: { short: "Claude", full: "Claude subscription" },
  openai_subscription: { short: "ChatGPT", full: "ChatGPT subscription" },
  openai: { short: "OpenAI", full: "OpenAI (or OpenAI-compatible)" },
  ollama: { short: "Ollama Cloud", full: "Ollama Cloud" },
  opencode: { short: "OpenCode", full: "OpenCode" },
};

/** The full provider name for a key kind, or the raw kind when unknown. */
export function providerLabel(provider: string | null | undefined): string | null {
  if (!provider) return null;
  return PROVIDER_LABELS[provider]?.full ?? provider;
}

export interface ModelChipInput {
  /** The effective key's provider kind (null when the key isn't known). */
  provider?: string | null;
  /** The effective key's name. */
  keyName?: string | null;
  /** The effective model id (null = nothing resolved yet). */
  modelId?: string | null;
  /** The model's friendly name, when the listing has one. */
  modelName?: string | null;
}

/**
 * The composer chip's text ("OpenCode · kimi-k3", "Claude · Opus 5.5") and its
 * tooltip ("My OpenCode account · OpenCode · kimi-k3"). The same model id can
 * exist on several providers, so the provider always leads. A model name that
 * already starts with the provider's short name drops it ("Claude Opus 5.5" on
 * a Claude key reads "Claude · Opus 5.5").
 */
export function modelChipLabel({ provider, keyName, modelId, modelName }: ModelChipInput): { label: string; title: string } {
  const name = modelName || (modelId ? MODEL_DISPLAY_FALLBACK[modelId] : undefined) || modelId || "default";
  const labels = provider ? PROVIDER_LABELS[provider] : undefined;
  const short = labels?.short ?? null;
  let model = name;
  if (short && model.toLowerCase().startsWith(`${short.toLowerCase()} `)) model = model.slice(short.length + 1);
  const label = short ? `${short} · ${model}` : model;
  const full = name !== modelId && modelId ? `${name} (${modelId})` : name;
  const title = [keyName, labels?.full ?? provider, full].filter(Boolean).join(" · ");
  return { label, title };
}
