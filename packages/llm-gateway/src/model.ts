import { readFileSync } from "node:fs";

/**
 * The session's actual model. The Claude Agent SDK resolves subagent model
 * aliases ("haiku"/"sonnet"/"opus") to claude-* ids; the orchestrator remaps
 * those aliases per turn, but any claude-* id that still reaches a
 * non-Anthropic upstream would be rejected. Substitute the session model
 * instead of failing the whole subagent.
 *
 * Read per request: this daemon outlives the exec that started it, so its
 * process env is frozen. A mid-session model switch only reaches us through
 * the per-turn file the orchestrator writes.
 */
export const MODEL_FILE = "/tmp/llm-gateway.model";

export function currentDefaultModel(): string {
  try {
    const m = readFileSync(MODEL_FILE, "utf8").trim();
    if (m) return m;
  } catch {
    /* no file yet: boot env below */
  }
  return process.env.LLM_GATEWAY_DEFAULT_MODEL || "";
}

/** The model to send upstream: the request's, unless it is a claude-* id and a session model is known. */
export function substituteClaudeModel(model: string | undefined, fallback = currentDefaultModel()): string {
  const requested = model || "";
  if (fallback && fallback !== requested && /^claude-/i.test(requested)) {
    console.log(`[llm-gateway] rewrote unsupported model '${requested}' -> '${fallback}'`);
    return fallback;
  }
  return requested;
}
