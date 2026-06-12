import type { GoalVerdict, JudgePayload } from "./types.js";

const VERDICT_TOOL = {
  name: "submit_verdict",
  description:
    "Record your verdict on whether the agent has fully achieved the goal against every acceptance criterion.",
  input_schema: {
    type: "object" as const,
    properties: {
      done: {
        type: "boolean",
        description:
          "True ONLY if every acceptance criterion is demonstrably met by the agent's reported result. If any criterion is unmet, partially done, or merely promised ('I will next…'), this is false.",
      },
      missing: {
        type: "array",
        items: { type: "string" },
        description: "Concrete outstanding items still required to meet the goal. Empty when done.",
      },
      progress_made: {
        type: "boolean",
        description:
          "True if this round moved the goal meaningfully closer vs. what was previously outstanding.",
      },
      rationale: { type: "string", description: "One-line justification for the verdict." },
    },
    required: ["done", "missing", "progress_made", "rationale"],
  },
};

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
    "You are an impartial completion judge. Be skeptical: assume the goal is NOT done",
    "unless the agent's reported result clearly demonstrates each acceptance criterion.",
    "You cannot inspect the workspace — judge only from the reported result. A result that",
    "describes intentions, next steps, or partial work is NOT done.",
    "",
    `GOAL:\n  ${p.goal}`,
    "",
    `ACCEPTANCE CRITERIA:\n${criteria}`,
    prior,
    "AGENT'S REPORTED RESULT:",
    "----",
    p.agent_result || "(empty — the agent produced no final result)",
    "----",
    "",
    "Call submit_verdict with your assessment.",
  ].join("\n");
}

/**
 * Independent completion judge — a single tool-forced Messages call with fresh
 * context (NOT the agent's session), run INSIDE the container so it uses the
 * same model access the agent does (ANTHROPIC_API_KEY / the in-container gateway
 * at ANTHROPIC_BASE_URL), i.e. provider-agnostic. Throws on API/parse failure.
 */
export async function judgeGoal(p: JudgePayload): Promise<GoalVerdict> {
  const mod = await import("@anthropic-ai/sdk");
  const Anthropic = (mod as { default?: unknown }).default ?? mod;
  // Env-based auth — same creds/base-url the agent SDK uses in this container.
  const client = new (Anthropic as new () => {
    messages: {
      create: (body: Record<string, unknown>) => Promise<{ content: Array<Record<string, unknown>> }>;
    };
  })();

  const body: Record<string, unknown> = {
    model: p.model,
    max_tokens: 1024,
    tools: [VERDICT_TOOL],
    tool_choice: { type: "tool", name: "submit_verdict" },
    messages: [{ role: "user", content: buildPrompt(p) }],
  };
  if (p.effort) body.output_config = { effort: p.effort };

  const resp = await client.messages.create(body);
  const block = resp.content.find((b) => b.type === "tool_use");
  if (!block || typeof block.input !== "object" || block.input === null) {
    throw new Error("judge returned no verdict tool call");
  }
  const v = block.input as Record<string, unknown>;
  return {
    done: Boolean(v.done),
    missing: Array.isArray(v.missing) ? (v.missing as string[]) : [],
    progress_made: Boolean(v.progress_made),
    rationale: typeof v.rationale === "string" ? v.rationale : "",
  };
}
