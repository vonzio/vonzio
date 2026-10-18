/**
 * The model a turn runs on when nothing chose one.
 *
 * An agent can end up with no model: skip the onboarding wizard, add a key in
 * Settings → Keys, and the default agent is bound to that key with
 * `model = NULL`. On Anthropic that is fine (the SDK picks a Claude default),
 * but on every gateway provider (Ollama, OpenAI-compatible, ChatGPT) the SDK's
 * Claude default would be forwarded upstream and rejected. This module is the
 * one place that decides the fallback for each provider kind.
 */
import type { ProfileProvider } from "@vonzio/shared";
import { codexModels } from "../services/codex-oauth-service.js";

/** The Claude model used where a concrete id is required on an Anthropic
 *  provider (e.g. the server-side goal judge) and none was configured. */
export const CLAUDE_DEFAULT_MODEL = "claude-opus-4-8";

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

/**
 * A default model id for a key's provider, or null when none can be found.
 *
 * - Anthropic kinds → CLAUDE_DEFAULT_MODEL.
 * - Everything else → the first model of the live catalog (`firstListed`,
 *   usually ModelListService), and for a ChatGPT subscription the baked Codex
 *   list when the catalog yields nothing.
 */
export async function defaultModelForProvider(
  provider: ProfileProvider | string | null | undefined,
  firstListed?: () => Promise<string | null>,
): Promise<string | null> {
  if (isAnthropicProvider(provider)) return CLAUDE_DEFAULT_MODEL;
  let listed: string | null = null;
  if (firstListed) {
    try {
      listed = await firstListed();
    } catch {
      listed = null;
    }
  }
  if (listed) return listed;
  if (provider === "openai_subscription") return codexModels()[0] ?? null;
  return null;
}
