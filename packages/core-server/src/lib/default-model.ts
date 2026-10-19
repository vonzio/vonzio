/**
 * The model a turn runs on when nothing chose one.
 *
 * An agent can end up with no model: skip the onboarding wizard, add a key in
 * Settings → Keys, and the default agent is bound to that key with
 * `model = NULL`. On a gateway provider (Ollama, OpenAI-compatible, ChatGPT)
 * the SDK's Claude default would be forwarded upstream and rejected, and on
 * Anthropic the SDK can invent an id of its own. This module is the one place
 * that decides the default for each provider kind: every caller that needs a
 * default (agent creation, the turn-time fallback, the goal judge, the model
 * list's `default_model`) goes through `pickDefaultModel`.
 */
import type { ProfileProvider } from "@vonzio/shared";

/** Preferred default models per provider kind, most preferred first. */
const CLAUDE_PREFERENCES = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5", "claude-fable-5-1"] as const;
const OPENAI_PREFERENCES = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6.1-sol", "gpt-6-astra"] as const;
const OLLAMA_PREFERENCES = ["kimi-k3", "glm-5.3-flash"] as const;

export const DEFAULT_MODEL_PREFERENCES: Readonly<Record<string, readonly string[]>> = {
  api_key: CLAUDE_PREFERENCES,
  claude_subscription: CLAUDE_PREFERENCES,
  openai: OPENAI_PREFERENCES,
  openai_subscription: OPENAI_PREFERENCES,
  ollama: OLLAMA_PREFERENCES,
};

/** The Claude model used where a concrete id is required on an Anthropic
 *  provider and no catalog is at hand. */
export const CLAUDE_DEFAULT_MODEL: string = CLAUDE_PREFERENCES[0];

/** User-facing copy when no model can be determined for a non-Anthropic key. */
export const NO_MODEL_MESSAGE =
  "No model is selected for this agent and none could be found for its provider. " +
  "Pick a model for this agent in Settings → Agents (or from the model picker in the chat).";

export class NoModelError extends Error {
  constructor() {
    super(NO_MODEL_MESSAGE);
    this.name = "NoModelError";
  }
}

/** Anthropic kinds speak the SDK's native protocol and accept Claude ids. An
 *  unset provider is the legacy "api_key" default. */
export function isAnthropicProvider(provider: string | null | undefined): boolean {
  return !provider || provider === "api_key" || provider === "claude_subscription";
}

/** The preference list for a provider kind (empty for a kind without one). */
export function modelPreferences(provider: ProfileProvider | string | null | undefined): readonly string[] {
  return DEFAULT_MODEL_PREFERENCES[provider || "api_key"] ?? [];
}

/**
 * The default model for a provider kind given its live catalog.
 *
 * - `listed` null/empty (catalog unavailable) → the first preference, or null
 *   for a kind without preferences.
 * - Otherwise the first preference present in the catalog (ids compared
 *   case-insensitively; the catalog's spelling is returned).
 * - None present → on Anthropic the first listed claude-* model, else the
 *   first listed model.
 */
export function pickDefaultModel(
  provider: ProfileProvider | string | null | undefined,
  listed: readonly string[] | null | undefined,
): string | null {
  const prefs = modelPreferences(provider);
  if (!listed || listed.length === 0) return prefs[0] ?? null;
  const byLower = new Map<string, string>();
  for (const id of listed) {
    const k = id.toLowerCase();
    if (!byLower.has(k)) byLower.set(k, id);
  }
  for (const p of prefs) {
    const hit = byLower.get(p.toLowerCase());
    if (hit) return hit;
  }
  if (isAnthropicProvider(provider)) {
    const claude = listed.find((id) => id.toLowerCase().startsWith("claude-"));
    if (claude) return claude;
  }
  return listed[0];
}

/**
 * Async wrapper over `pickDefaultModel` that lists the catalog itself
 * (`listModels`, usually ModelListService). A throwing or absent lister is
 * treated as "catalog unavailable".
 */
export async function defaultModelForProvider(
  provider: ProfileProvider | string | null | undefined,
  listModels?: () => Promise<readonly string[] | null>,
): Promise<string | null> {
  let listed: readonly string[] | null = null;
  if (listModels) {
    try {
      listed = await listModels();
    } catch {
      listed = null;
    }
  }
  return pickDefaultModel(provider, listed);
}
