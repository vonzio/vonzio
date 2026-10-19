import type { GoalVerdict } from "./agent-comms.js";
import { completeText } from "../services/byok-connection.js";

/** Hard cap on the fallback judge's HTTP call. A verdict is a small, fast
 * request; 60s is generous and still bounds a dead/hung provider. */
const JUDGE_HTTP_TIMEOUT_MS = 60_000;

/**
 * Server-side completion judge — the resilience fallback for the in-container
 * judge (agent-comms.judge). It runs as a direct model API call from
 * core-server, so it has NO dependency on the workspace container being alive
 * (the failure mode that produced "completion check unavailable" when the
 * container was torn down mid-goal-loop).
 *
 * Trade-off vs the in-container judge: this one cannot inspect the workspace
 * filesystem, so it judges from the agent's result text + acceptance criteria
 * only. It's deliberately conservative (defaults to "not done" when it can't
 * confirm) and its verdicts are flagged `inspected: false` so callers/UX can
 * tell it apart. Use it ONLY when the file-inspecting judge is unavailable.
 */

export interface ServerJudgePayload {
  goal: string;
  acceptance_criteria?: string[];
  agent_result: string;
  prior_missing?: string[];
}

export interface ServerJudgeCreds {
  apiKey?: string;
  /** ResolvedProfile.resolved_provider: "api_key" (Anthropic) | "claude_subscription" (Anthropic via OAuth) | "openai" | "ollama" */
  provider?: string;
  baseUrl?: string;
  /** opencode: the organization stored with the token. */
  accountId?: string;
  model: string;
}

type Logger = {
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  info: (obj: Record<string, unknown>, msg?: string) => void;
};

function buildPrompt(p: ServerJudgePayload): string {
  const criteria =
    p.acceptance_criteria && p.acceptance_criteria.length > 0
      ? p.acceptance_criteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n")
      : "  (none stated — judge against the goal itself)";
  const prior =
    p.prior_missing && p.prior_missing.length > 0
      ? `\nPreviously outstanding:\n${p.prior_missing.map((m) => `  - ${m}`).join("\n")}\n`
      : "";
  return [
    "You are an impartial completion judge. You do NOT have access to the",
    "workspace files — judge ONLY from the agent's reported result against the",
    "goal and acceptance criteria below. Be conservative: if the result does not",
    "clearly demonstrate a criterion is met, treat it as NOT met (the agent may",
    "have over-claimed). Reply with ONLY a JSON object, no prose, matching:",
    `{"done": boolean, "missing": string[], "progress_made": boolean, "rationale": string}`,
    "  - done: true only if every criterion is clearly satisfied by the result.",
    "  - missing: concrete outstanding items (empty when done).",
    "  - progress_made: true if this round moved the goal meaningfully closer.",
    "  - rationale: one line citing what you based the verdict on.",
    "",
    `GOAL:\n  ${p.goal}`,
    "",
    `ACCEPTANCE CRITERIA:\n${criteria}`,
    prior,
    `AGENT RESULT:\n${p.agent_result || "(the agent produced no textual result)"}`,
  ].join("\n");
}

/** Pull the first JSON object out of a model reply and validate the shape. */
function parseVerdict(text: string): GoalVerdict | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let obj: unknown;
  try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!obj || typeof obj !== "object") return null;
  const v = obj as Record<string, unknown>;
  if (typeof v.done !== "boolean" || typeof v.progress_made !== "boolean") return null;
  return {
    done: v.done,
    missing: Array.isArray(v.missing) ? v.missing.filter((m): m is string => typeof m === "string") : [],
    progress_made: v.progress_made,
    rationale: typeof v.rationale === "string" ? v.rationale : "",
  };
}

/**
 * Run the fallback judge. Returns a verdict or throws (caller degrades to a
 * soft stop). Every provider the profile can resolve to goes through byok
 * (Anthropic, Claude subscription, OpenAI-compatible, Ollama, ChatGPT).
 */
export async function judgeServerSide(
  payload: ServerJudgePayload,
  creds: ServerJudgeCreds,
  log?: Logger,
): Promise<GoalVerdict> {
  if (!creds.apiKey) throw new Error("server-side judge: no API key");
  const prompt = buildPrompt(payload);

  let raw: string;
  try {
    raw = await completeText(
      { provider: creds.provider, api_key: creds.apiKey, base_url: creds.baseUrl, account_id: creds.accountId },
      creds.model,
      // No JSON mode: some OpenAI-compatible providers reject it with a 400.
      // The prompt demands a bare JSON object and parseVerdict() is lenient.
      { system: "", messages: [{ role: "user", content: prompt }], maxTokens: 1024 },
      // Bound the call: this runs on the server thread, so a hung response
      // would freeze the goal loop — the per-task watchdog only aborts the
      // in-container agent exec, not a stuck call here.
      { timeoutMs: JUDGE_HTTP_TIMEOUT_MS },
    );
  } catch (err) {
    throw new Error(`server-side judge: ${err instanceof Error ? err.message : String(err)}`);
  }

  const verdict = parseVerdict(raw);
  if (!verdict) throw new Error("server-side judge: unparseable verdict");
  log?.info({ done: verdict.done }, "goal judge: server-side fallback verdict");
  return verdict;
}
