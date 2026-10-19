/**
 * Upstream provider failures in words.
 *
 * When a model call is rejected, the Claude Agent SDK reports it as assistant
 * text and as the turn's result in the shape `API Error: <status> <body>`,
 * where the body is usually the provider's raw JSON. That blob is what the
 * user used to see in the chat ("API Error: 400 {"type":"error","error":…}").
 * `humanizeProviderError` turns it into one readable sentence with a hint —
 * most importantly for a rejected model, which the user fixes by picking a
 * different one.
 */

/** Hint appended to a model rejection. */
export const SWITCH_MODEL_HINT =
  "Pick a different model for this agent in Settings → Agents, or switch models from the model picker in the chat.";

const MAX_DETAIL = 400;

const MODEL_REJECTED =
  /\bmodel\b[\s\S]{0,200}?\b(not supported|unsupported|not available|unavailable|does not exist|not found|may not exist|not allowed|invalid)\b|\b(unknown|invalid|unsupported) model\b|^model:\s*\S+$/i;

// byok's own wording for a rejected Codex model already carries a hint; drop
// it so ours isn't doubled.
const BYOK_MODEL_HINT = /\s*Pick (?:another|a different) model in Settings\.?/i;

// The SDK's own wording for a 404 on the model (refers to its CLI /model command).
const SDK_SELECTED_MODEL = /^There's an issue with the selected model \(([^)]*)\)\.[\s\S]*$/;

// The SDK's wrapper around a failed turn's result ("<tool> returned an error
// result: <text>") — internal wording that must never reach the user.
const SDK_RESULT_PREFIX = /^\s*(?:Error:\s*)?Claude Code returned an error result:\s*/i;

// The SDK's lead-in before a rejected-credential `API Error: 401 …`.
const SDK_AUTH_LEAD = /^(?:Failed to authenticate|Authentication failed|Invalid API key)\s*[.·:]?\s*(?=API Error:)/i;

// The SDK's own copy for a rejected key, with no status attached
// ("Invalid API key · Please run /login"). Whole-message only, so model prose
// that merely starts with these words is left alone.
const SDK_INVALID_KEY = /^(?:Invalid API key|Invalid bearer token|OAuth token (?:has expired|revoked))(?:\s*[·.][^\n]{0,120})?$/i;

const AUTH_HINT = "Check the key, or sign in again, in Settings → Keys.";

/** OpenCode's free tier answers 403 to any client but OpenCode's own apps.
 *  The key is fine — the model is the problem. */
export const OPENCODE_FREE_TIER_MESSAGE =
  "This OpenCode model is free-tier, which only works in OpenCode's own apps. Pick a paid model from the model picker.";

// The gateway's wording of that 403 (llm-gateway byok-handler OPENCODE_FREE_TIER,
// current and earlier copy).
const OPENCODE_FREE_TIER = /\bOpenCode(?:'s)?\b[\s\S]{0,40}?\bfree[- ]tier\b/i;

/**
 * Drop the SDK's internal "… returned an error result:" prefix from a failure
 * message, so the turn's own error text is all the user sees.
 */
export function stripSdkErrorPrefix(text: string): string {
  return text.replace(SDK_RESULT_PREFIX, "").trim();
}

/** True when a failure is the provider rejecting the credential (401/403) —
 *  not worth retrying, the key has to change first. */
export function isAuthFailure(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = stripSdkErrorPrefix(text).replace(SDK_AUTH_LEAD, "");
  return /^(?:API Error|HTTP):?\s*(?:401|403)\b/.test(t) || SDK_INVALID_KEY.test(t);
}

function tryParse(text: string): unknown {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** The human message inside a provider error body (Anthropic, OpenAI, Codex shapes). */
function pickMessage(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const o = json as Record<string, unknown>;
  const err = o.error;
  if (typeof err === "string" && err) return err;
  if (err && typeof err === "object") {
    const m = (err as Record<string, unknown>).message;
    if (typeof m === "string" && m) return m;
  }
  if (typeof o.detail === "string" && o.detail) return o.detail;
  if (o.detail && typeof o.detail === "object") {
    const m = (o.detail as Record<string, unknown>).message;
    if (typeof m === "string" && m) return m;
  }
  if (typeof o.message === "string" && o.message) return o.message;
  return undefined;
}

/** Unwrap a body to its innermost message: JSON → message, and a nested
 *  `HTTP 400: {…}` (byok's wording of an upstream body) once more. */
function extractDetail(body: string, depth = 0): { detail: string; parsed: boolean } {
  const text = body.trim();
  if (depth > 3) return { detail: text, parsed: false };
  const msg = pickMessage(tryParse(text));
  if (msg) return { detail: extractDetail(msg, depth + 1).detail, parsed: true };
  const nested = /^(?:[\s\S]*?\bHTTP \d{3}:?\s*)(\{[\s\S]*\})\s*$/.exec(text);
  if (nested) {
    const inner = pickMessage(tryParse(nested[1]));
    if (inner) return { detail: extractDetail(inner, depth + 1).detail, parsed: true };
  }
  return { detail: text, parsed: false };
}

function sentence(text: string): string {
  let t = text.replace(/\s+/g, " ").trim();
  if (t.length > MAX_DETAIL) t = `${t.slice(0, MAX_DETAIL - 1).trimEnd()}…`;
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

function statusHint(status: number): string {
  if (status === 401 || status === 403) return ` ${AUTH_HINT}`;
  if (status === 429) return " The provider's rate or plan limit was reached — wait a moment and try again.";
  return "";
}

/**
 * A readable version of an upstream provider error, or null when `text` is not
 * one (callers keep the original). Recognises:
 * - `API Error: <status> <json body>` (the SDK's wording of a rejected call),
 * - `HTTP <status>: <json body>` (byok's wording, e.g. in a failed task),
 * - the SDK's "There's an issue with the selected model (…)" 404 copy,
 * - the SDK's rejected-credential copy ("Failed to authenticate. API Error:
 *   401 Unauthorized", "Invalid API key · …"), with its internal
 *   "… returned an error result:" prefix stripped.
 *
 * `opts.httpForm: false` skips the bare `HTTP <status>` form — for model
 * output (assistant text), where only the SDK's own error wording is safe to
 * treat as an error.
 */
export function humanizeProviderError(
  text: string | null | undefined,
  opts: { httpForm?: boolean } = {},
): string | null {
  if (!text) return null;
  const trimmed = stripSdkErrorPrefix(text).replace(SDK_AUTH_LEAD, "");

  if (SDK_INVALID_KEY.test(trimmed)) {
    return `The model provider rejected the key. ${AUTH_HINT}`;
  }

  const selected = SDK_SELECTED_MODEL.exec(trimmed);
  if (selected) {
    return `The model "${selected[1]}" isn't available on this provider or account. ${SWITCH_MODEL_HINT}`;
  }

  let status: number | undefined;
  let body: string;
  const api = /^API Error:\s*(?:(\d{3})\b)?\s*([\s\S]*)$/.exec(trimmed);
  const http = api || opts.httpForm === false ? null : /^HTTP (\d{3}):?\s*([\s\S]*)$/.exec(trimmed);
  if (api) {
    status = api[1] ? Number(api[1]) : undefined;
    body = api[2];
  } else if (http) {
    status = Number(http[1]);
    body = http[2];
  } else {
    return null;
  }

  const extracted = extractDetail(body);
  const parsed = extracted.parsed;
  let detail = extracted.detail;
  // byok words an upstream failure "HTTP <status>: <message>"; the status is
  // already in our own copy, so don't repeat it ("(HTTP 403): HTTP 403: …").
  const inner = /^HTTP (\d{3}):?\s*([\s\S]*)$/.exec(detail);
  if (inner) {
    status ??= Number(inner[1]);
    detail = inner[2].trim();
  }
  if (detail && OPENCODE_FREE_TIER.test(detail)) return OPENCODE_FREE_TIER_MESSAGE;
  if (detail && MODEL_REJECTED.test(detail)) {
    const cleaned = detail.replace(BYOK_MODEL_HINT, "").trim() || "The provider rejected the model";
    return `${sentence(cleaned)} ${SWITCH_MODEL_HINT}`;
  }
  // A rejected credential always gets the key hint, even with a plain-text
  // body ("API Error: 401 Unauthorized").
  if (!parsed && (status === 401 || status === 403)) {
    const said = detail && !/^(?:Unauthorized|Forbidden)\.?$/i.test(detail) ? `: ${sentence(detail)}` : ".";
    return `The model provider rejected the key (HTTP ${status})${said} ${AUTH_HINT}`;
  }
  // Only reword a structured body; plain SDK copy ("API Error: Request was
  // aborted.") is already readable, and a bare HTTP line without JSON is left
  // to its caller.
  if (!parsed || !detail) return null;
  const code = status ? ` (HTTP ${status})` : "";
  const lead = status && status >= 500 ? "The model provider failed" : "The model provider rejected the request";
  return `${lead}${code}: ${sentence(detail)}${status ? statusHint(status) : ""}`;
}
