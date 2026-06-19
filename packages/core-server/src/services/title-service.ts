/**
 * Workspace title generation — the SINGLE place the title LLM call lives.
 *
 * Both callers (the post-turn auto-title in ws/handler and the on-demand
 * POST /v1/workspaces/:id/generate-title route) go through `generateTitle`,
 * which uses the workspace's ACTIVE model + provider (from the resolved
 * profile) instead of a hardcoded Anthropic Haiku — so it works for Ollama /
 * OpenAI-compatible keys too, not just Anthropic.
 *
 * Provider routing mirrors the goal-loop's server-side judge (judge-server.ts):
 *   - api_key / claude_subscription → Anthropic /v1/messages
 *   - openai / ollama              → {base_url}/chat/completions
 */
import { anthropicAuthHeaders } from "@vonzio/shared";
import { OLLAMA_BASE_URL } from "./ollama-service.js";

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
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

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
  const isOpenAICompatible = creds.provider === "openai" || creds.provider === "ollama";
  // Anthropic profiles often don't pin a model (the CLI picks a default), so
  // fall back to Haiku rather than skip titling. OpenAI/Ollama have no safe
  // default model — skip if unset.
  const model = creds.model || (isOpenAICompatible ? undefined : ANTHROPIC_TITLE_MODEL);
  if (!creds.apiKey || !model) {
    log?.info({ hasKey: !!creds.apiKey, hasModel: !!model, provider: creds.provider }, "title: skipped (no key/model)");
    return null;
  }
  const resolved: TitleCreds = { ...creds, model };
  try {
    const raw = isOpenAICompatible
      ? await callOpenAICompatible(prompt, response, resolved)
      : await callAnthropic(prompt, response, resolved);
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

async function callAnthropic(prompt: string, response: string, creds: TitleCreds): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(TITLE_HTTP_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      ...anthropicAuthHeaders(creds.provider, creds.apiKey!),
    },
    body: JSON.stringify({
      model: creds.model,
      max_tokens: 64,
      messages: [{ role: "user", content: buildPrompt(prompt, response) }],
    }),
  });
  if (!res.ok) throw new Error(`title: Anthropic ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content?: Array<{ text?: string }> };
  return data.content?.map((b) => b.text ?? "").join("") ?? "";
}

async function callOpenAICompatible(prompt: string, response: string, creds: TitleCreds): Promise<string> {
  // Ollama Cloud keys carry no base_url (the endpoint is the default
  // OLLAMA_BASE_URL, applied via the in-container proxy); OpenAI keys without a
  // custom base_url use the public API. Fall back so title gen works without an
  // explicit base_url, just like the model list does.
  const fallback =
    creds.provider === "ollama" ? `${OLLAMA_BASE_URL}/v1`
    : creds.provider === "openai" ? OPENAI_DEFAULT_BASE_URL
    : "";
  const base = (creds.baseUrl || fallback).replace(/\/+$/, "");
  if (!base) throw new Error("title: no base_url for OpenAI-compatible provider");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(TITLE_HTTP_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.apiKey}`,
    },
    body: JSON.stringify({
      model: creds.model,
      // Reasoning models (e.g. glm-5.2) spend tokens "thinking" before the
      // answer; a tiny budget leaves `content` empty. Give enough room to
      // finish, then take the (short) title from the tail.
      max_tokens: 512,
      messages: [
        { role: "system", content: "You generate a single short chat title. Reply with ONLY the title — no preamble, no quotes, no reasoning." },
        { role: "user", content: buildPrompt(prompt, response) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`title: OpenAI-compat ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string } }>;
  };
  const msg = data.choices?.[0]?.message;
  // Prefer the real answer; fall back to the reasoning field's tail when a
  // reasoning model leaves `content` empty.
  return msg?.content || msg?.reasoning_content || msg?.reasoning || "";
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
