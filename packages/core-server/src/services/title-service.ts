/**
 * Workspace title generation — the SINGLE place the title LLM call lives.
 *
 * Both callers (the post-turn auto-title in ws/handler and the on-demand
 * POST /v1/workspaces/:id/generate-title route) go through `generateTitle`,
 * which uses the workspace's ACTIVE model + provider (from the resolved
 * profile) instead of a hardcoded Anthropic Haiku — so it works for Ollama /
 * OpenAI-compatible keys too, not just Anthropic.
 *
 * Provider routing is byok's (see byok-connection.ts), the same as the
 * goal-loop's server-side judge.
 */
import { completeText } from "./byok-connection.js";

/** A title is a tiny, fast request; bound it so a hung provider can't stall
 *  the post-turn hook or the route handler. */
const TITLE_HTTP_TIMEOUT_MS = 30_000;

export interface TitleCreds {
  apiKey?: string;
  /** ResolvedProfile.resolved_provider: "api_key" | "claude_subscription" | "openai" | "ollama" */
  provider?: string;
  baseUrl?: string;
  /** The workspace's active model (workspace.model_override ?? resolved.model).
   *  May be unset for Anthropic profiles that don't pin one — see the Haiku
   *  fallback in generateTitle. */
  model?: string;
}

/** Cheap default for Anthropic when a profile doesn't pin a model — keeps
 *  auto-titling working (it did before this was provider-aware). */
const ANTHROPIC_TITLE_MODEL = "claude-haiku-4-5-20251001";
const TITLE_SYSTEM =
  "You generate a single short chat title. Reply with ONLY the title — no preamble, no quotes, no reasoning.";

type Logger = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
};

function buildPrompt(prompt: string, response: string): string {
  return (
    "Generate a very short title (3-6 words, no quotes, no punctuation) " +
    "summarizing this conversation topic:\n\n" +
    `User: ${prompt.slice(0, 200)}\nAssistant: ${response.slice(0, 200)}`
  );
}

/** Normalize a model's reply into a usable title (exported for tests). */
export function clean(raw: string | undefined | null): string | null {
  if (!raw) return null;
  // Reasoning/instruct models often wrap the title: take the last non-empty
  // line (the answer usually comes after any preamble), drop a leading
  // "Title:" label, strip surrounding quotes + trailing punctuation.
  const lastLine = raw.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  const title = lastLine
    .replace(/^title\s*[:\-]\s*/i, "")
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/[.,;:?!]+$/, "")
    .trim();
  if (title && title.length > 0 && title.length <= 80) return title;
  return null;
}

/**
 * Generate a title via the workspace's active model/provider. Returns the
 * cleaned title, or null when no usable title could be produced (no key,
 * provider error, empty/oversized reply) — callers fall back (heuristic or
 * keep the existing name).
 */
export async function generateTitle(
  prompt: string,
  response: string,
  creds: TitleCreds,
  log?: Logger,
): Promise<string | null> {
  const isAnthropic = !creds.provider || creds.provider === "api_key" || creds.provider === "claude_subscription";
  // Anthropic profiles often don't pin a model (the CLI picks a default), so
  // fall back to Haiku rather than skip titling. Other providers have no safe
  // default model — skip if unset.
  const model = creds.model || (isAnthropic ? ANTHROPIC_TITLE_MODEL : undefined);
  if (!creds.apiKey || !model) {
    log?.info({ hasKey: !!creds.apiKey, hasModel: !!model, provider: creds.provider }, "title: skipped (no key/model)");
    return null;
  }
  try {
    const raw = await completeText(
      { provider: creds.provider, api_key: creds.apiKey, base_url: creds.baseUrl },
      model,
      {
        system: TITLE_SYSTEM,
        messages: [{ role: "user", content: buildPrompt(prompt, response) }],
        // Reasoning models spend tokens "thinking" before the answer; a tiny
        // budget leaves the text empty. Give room to finish, then clean() takes
        // the short title from the tail.
        maxTokens: 512,
      },
      { timeoutMs: TITLE_HTTP_TIMEOUT_MS },
    );
    const title = clean(raw);
    log?.info(
      { ok: !!title, rawLen: raw?.length ?? 0, provider: creds.provider, model: creds.model },
      "title: generated",
    );
    return title;
  } catch (err) {
    log?.error({ err, provider: creds.provider }, "title: generation failed");
    return null;
  }
}

/** Deterministic fallback when the LLM call returns null (no key, error, etc.). */
export function heuristicTitle(prompt: string): string {
  let title = prompt.trim();
  title = title.replace(/^(can you |please |i want to |i need to |help me |let's |let me |are you )/i, "");
  if (title.length > 40) title = title.slice(0, 40).replace(/\s+\S*$/, "");
  title = title.replace(/[.,;:?!]+$/, "");
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return title || "Untitled";
}
