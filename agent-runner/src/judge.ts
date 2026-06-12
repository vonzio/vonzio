import type { GoalVerdict, JudgePayload } from "./types.js";

/** Structured verdict the judge must emit as its final output. */
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    done: {
      type: "boolean",
      description:
        "True ONLY if every acceptance criterion is verifiably met by what's actually in the workspace.",
    },
    missing: {
      type: "array",
      items: { type: "string" },
      description: "Concrete outstanding items still required. Empty when done.",
    },
    progress_made: {
      type: "boolean",
      description: "True if this round moved the goal meaningfully closer.",
    },
    rationale: { type: "string", description: "One-line justification, citing what you checked." },
  },
  required: ["done", "missing", "progress_made", "rationale"],
  additionalProperties: false,
} as const;

function buildPrompt(p: JudgePayload): string {
  const criteria =
    p.acceptance_criteria && p.acceptance_criteria.length > 0
      ? p.acceptance_criteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n")
      : "  (none stated — judge against the goal itself)";
  const prior =
    p.prior_missing && p.prior_missing.length > 0
      ? `\nPreviously outstanding:\n${p.prior_missing.map((m) => `  - ${m}`).join("\n")}\n`
      : "";
  return [
    "You are an impartial completion judge. The agent did its work in the",
    "workspace (current directory). VERIFY each acceptance criterion against what",
    "is ACTUALLY there — use Read/Grep/Glob to open the relevant files and confirm",
    "they exist and contain what's required. Do NOT rely on the agent's summary;",
    "the agent describing or claiming something is not proof — check the files.",
    "Keep it focused: inspect only what the criteria require.",
    "",
    `GOAL:\n  ${p.goal}`,
    "",
    `ACCEPTANCE CRITERIA:\n${criteria}`,
    prior,
    "The agent reported (for context only — verify it):",
    "----",
    p.agent_result || "(the agent produced no final summary)",
    "----",
    "",
    "After inspecting the workspace, output your verdict.",
  ].join("\n");
}

/**
 * Independent completion judge. Runs INSIDE the agent's container via the same
 * claude-agent-sdk path the agent uses (so it's provider-agnostic — Anthropic
 * key or the in-container gateway both work) and is given READ-ONLY tools so it
 * verifies the actual workspace artifacts rather than trusting the agent's
 * claims. Returns the structured verdict; throws on failure (caller degrades).
 */
export async function judgeGoal(p: JudgePayload): Promise<GoalVerdict> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const options: Record<string, unknown> = {
    // Read-only inspection only — the judge must never mutate the workspace.
    allowedTools: ["Read", "Grep", "Glob"],
    permissionMode: "bypassPermissions",
    maxTurns: 14,
    model: p.model,
    // Verification is bounded — default to low effort to keep judge cost down.
    effort: p.effort ?? "low",
    thinking: { type: "adaptive" },
    cwd: "/workspace",
    // Don't load the project's CLAUDE.md / hooks / skills into the judge —
    // it's a neutral verifier, not the agent.
    settingSources: [],
    outputFormat: { type: "json_schema", schema: VERDICT_SCHEMA },
  };

  const q = query({ prompt: buildPrompt(p), options });

  let raw: unknown;
  for await (const message of q as AsyncIterable<Record<string, unknown>>) {
    if (message.type === "result") {
      if (message.subtype === "success") {
        // json_schema output may surface as a parsed object or a JSON string.
        raw = (message as Record<string, unknown>).structured_output ?? (message as Record<string, unknown>).result;
      }
      break;
    }
  }

  const v = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!v || typeof v !== "object") {
    throw new Error("judge produced no verdict");
  }
  const r = v as Record<string, unknown>;
  return {
    done: Boolean(r.done),
    missing: Array.isArray(r.missing) ? (r.missing as string[]) : [],
    progress_made: Boolean(r.progress_made),
    rationale: typeof r.rationale === "string" ? r.rationale : "",
  };
}
