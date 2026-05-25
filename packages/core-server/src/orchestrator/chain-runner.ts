import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Playbook, PlaybookRun, ActivityLogEntry, DecisionResult } from "@vonzio/shared";
import type { NotificationService } from "../services/notification-service.js";
import type { TaskResult } from "@vonzio/shared";
import type { PlaybookService } from "../services/playbook-service.js";
import type { SubmitTaskInput } from "../services/task-service.js";
import type { Orchestrator, Logger } from "./orchestrator.js";
import type { DrizzleDB } from "../db/index.js";
import * as schema from "../db/schema.js";

interface ChainRunnerDeps {
  playbookService: PlaybookService;
  orchestrator: Orchestrator;
  db: DrizzleDB;
  submitTask: (input: SubmitTaskInput) => Promise<{ task_id: string }>;
  notificationService?: NotificationService;
  log?: Logger;
}

const CHAIN_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["CONTINUE", "DONE"] },
    summary: { type: "string", description: "Brief summary of what was accomplished in this step" },
  },
  required: ["status", "summary"],
};

/**
 * Appended to every playbook prompt (first chain AND continuations) so the
 * agent reliably emits a summary via StructuredOutput. Without this, runs
 * frequently ended with no summary at all — the notification renderer then
 * had to fall back to whatever the agent's last tool happened to return,
 * which was often noise (e.g. `[]` from a no-rows psql query).
 *
 * The contract is explicit about what to do when there's nothing to report
 * — most playbooks have a "no work needed today" path, and without the
 * explicit instruction the agent would just trail off.
 */
const CHAIN_OUTPUT_CONTRACT = `

---
**Output contract — required**

Before you finish, call \`StructuredOutput\` with:
\`\`\`
{
  "status": "DONE",                          // or "CONTINUE" if you need another chain
  "summary": "<one or two plain-English sentences describing what you actually did and what you found>"
}
\`\`\`

- If there was no work to do (a daily query returned no rows, nothing to nudge, etc.), still call \`StructuredOutput\` with \`status: "DONE"\` and a summary like \`"No <thing> today — nothing to act on."\`. **Don't** end the run silently.
- The \`summary\` is the only thing the user sees in their notification. Be specific and concrete. Avoid filler like "completed successfully" or "no errors".`;

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

export class ChainRunner {
  private log: Logger;
  private activeRuns = new Map<string, { cancelled: boolean }>();

  constructor(private deps: ChainRunnerDeps) {
    this.log = deps.log?.child({ component: "chain-runner" }) ?? noopLogger;
  }

  async execute(playbook: Playbook, userId: string): Promise<PlaybookRun> {
    const sessionId = `pb-${nanoid()}`;
    const run = await this.deps.playbookService.createRun(playbook.id, userId, sessionId);
    const runState = { cancelled: false };
    this.activeRuns.set(run.id, runState);

    this.log.info({ playbookId: playbook.id, runId: run.id, sessionId }, "Chain run started");

    const { max_chains, budget_cap_usd, chain_delay_ms, max_turns_per_chain } = playbook.chain_config;
    let chainCount = 0;
    let totalTurns = 0;
    let totalCost = 0;
    const taskIds: string[] = [];
    const activityLog: ActivityLogEntry[] = [];
    let lastSummary: string | undefined;
    let lastError: string | undefined;
    let finalStatus: "completed" | "failed" | "cancelled" = "completed";
    // Why the run ended. Notification renderer surfaces this as a clean
    // status tag instead of jamming it inline into result_summary (which
    // turned every notification into "[…] [Budget cap reached]" soup).
    //   - "agent_done"               agent self-signaled DONE
    //   - "agent_finished_in_limit"  agent stopped before max_turns w/o DONE
    //   - "budget_cap"               total cost ≥ playbook budget cap
    //   - "chain_limit"              max_chains reached
    //   - undefined                  failed/cancelled (see status + error)
    let terminationReason: "agent_done" | "agent_finished_in_limit" | "budget_cap" | "chain_limit" | undefined;

    try {
      while (chainCount < max_chains) {
        if (runState.cancelled) {
          finalStatus = "cancelled";
          break;
        }

        chainCount++;
        this.log.info({ runId: run.id, chain: chainCount, maxChains: max_chains }, "Submitting chain task");

        const isFirstChain = chainCount === 1;
        const basePrompt = isFirstChain
          ? playbook.prompt
          : "Continue working on the task. Review your previous progress and continue where you left off.";
        const prompt = `${basePrompt}${CHAIN_OUTPUT_CONTRACT}`;

        const taskInput: SubmitTaskInput = {
          mode: "session",
          prompt,
          profile_id: playbook.profile_id,
          session_id: sessionId,
          output_schema: CHAIN_OUTPUT_SCHEMA,
          max_turns: max_turns_per_chain,
          allowed_tools: playbook.chain_config.allowed_tools,
        };

        const { task_id } = await this.deps.submitTask(taskInput);
        taskIds.push(task_id);

        // Name the workspace after first task submission
        if (isFirstChain) {
          await this.deps.db
            .update(schema.workspaces)
            .set({ name: `[Playbook] ${playbook.name}` })
            .where(eq(schema.workspaces.session_id, sessionId))
            .catch(() => {}); // workspace may not exist yet if task hasn't dispatched
        }

        // Wait for task completion, capturing activity along the way
        const effectiveMaxTurns = max_turns_per_chain ?? 200;
        const chainTimeoutMs = (playbook.chain_config.timeout_per_chain_seconds ?? 3600) * 1000;
        const { result, activity } = await this.waitForTask(task_id, effectiveMaxTurns, chainTimeoutMs);
        activityLog.push(...activity);

        totalTurns += result.turns;
        totalCost += result.cost_usd;

        // Update run progress
        await this.deps.playbookService.updateRun(run.id, {
          chain_count: chainCount,
          total_turns: totalTurns,
          total_cost_usd: totalCost,
          task_ids: taskIds,
          activity_log: activityLog,
        });

        // Evaluate result
        const agentSignal = this.parseAgentSignal(result);
        lastSummary = agentSignal?.summary || this.extractSummary(result);

        // Priority 1: Agent self-signal DONE
        if (agentSignal?.status === "DONE") {
          this.log.info({ runId: run.id, chain: chainCount }, "Agent signaled DONE");
          terminationReason = "agent_done";
          break;
        }

        // Priority 2: Budget cap
        if (totalCost >= budget_cap_usd) {
          this.log.warn({ runId: run.id, cost: totalCost, cap: budget_cap_usd }, "Budget cap reached");
          terminationReason = "budget_cap";
          break;
        }

        // Priority 3: This was the last allowed chain
        if (chainCount >= max_chains) {
          this.log.warn({ runId: run.id, chains: chainCount, max: max_chains }, "Chain limit reached");
          terminationReason = "chain_limit";
          break;
        }

        // Priority 4: turns < max_turns means agent finished on its own without DONE signal
        // Treat as done (agent completed within turn limit)
        if (result.turns < effectiveMaxTurns) {
          this.log.info({ runId: run.id, turns: result.turns, maxTurns: effectiveMaxTurns }, "Agent finished within turn limit");
          terminationReason = "agent_finished_in_limit";
          break;
        }

        // Agent hit max_turns — continue after delay
        this.log.info({ runId: run.id, delayMs: chain_delay_ms }, "Continuing after delay");
        await this.sleep(chain_delay_ms);
      }
    } catch (err) {
      finalStatus = "failed";
      lastError = err instanceof Error ? err.message : "Unknown error";
      this.log.error({ runId: run.id, error: lastError }, "Chain run failed");
    } finally {
      this.activeRuns.delete(run.id);
    }

    // Evaluate decision criteria
    const decisionResult = finalStatus === "completed"
      ? this.evaluateDecision(playbook, { total_cost_usd: totalCost, total_turns: totalTurns, chain_count: chainCount, result_summary: lastSummary })
      : "skipped" as DecisionResult;

    // Finalize run
    const now = new Date().toISOString();
    await this.deps.playbookService.updateRun(run.id, {
      status: finalStatus,
      chain_count: chainCount,
      total_turns: totalTurns,
      total_cost_usd: totalCost,
      task_ids: taskIds,
      result_summary: lastSummary,
      activity_log: activityLog,
      decision_result: decisionResult,
      termination_reason: terminationReason,
      error: lastError,
      finished_at: now,
    });
    await this.deps.playbookService.setLastRunAt(playbook.id, now);

    this.log.info(
      { runId: run.id, status: finalStatus, chains: chainCount, turns: totalTurns, cost: totalCost, decision: decisionResult },
      "Chain run finished",
    );

    const finalRun = await this.deps.playbookService.getRun(run.id);

    // Send notifications (fire-and-forget). `terminationReason` is now
    // persisted on the run row (migration #17) so the notification reads it
    // off `finalRun` directly — no more in-memory pass-through. Analytics
    // ("what % of runs hit the budget cap this week?") can also query the
    // column without grepping logs.
    if (this.deps.notificationService && finalRun) {
      this.deps.notificationService.notifyRunComplete(playbook, finalRun).catch((err) => {
        this.log.error({ runId: run.id, error: String(err) }, "Notification failed");
      });
    }

    return finalRun!;
  }

  cancelRun(runId: string): boolean {
    const state = this.activeRuns.get(runId);
    if (!state) return false;
    state.cancelled = true;
    return true;
  }

  private waitForTask(taskId: string, _maxTurns = 200, timeoutMs = 3_600_000): Promise<{ result: TaskResult; activity: ActivityLogEntry[] }> {
    return new Promise((resolve, reject) => {
      const activity: ActivityLogEntry[] = [];
      let textBuffer = "";
      let timer: ReturnType<typeof setTimeout>;

      // Capture streamed tokens into text blocks
      const onToken = (id: string, _sessionId: string, text: string) => {
        if (id !== taskId) return;
        textBuffer += text;
      };

      // Capture tool usage
      const onToolUse = (id: string, _sessionId: string, tool: string, input: unknown) => {
        if (id !== taskId) return;
        // Flush any accumulated text before the tool call
        if (textBuffer.trim()) {
          activity.push({ type: "text", text: textBuffer.trim(), ts: new Date().toISOString() });
          textBuffer = "";
        }
        activity.push({ type: "tool_use", tool, input: this.sanitizeInput(tool, input), ts: new Date().toISOString() });
      };

      // Capture tool results
      const onToolResult = (id: string, _sessionId: string, tool: string, output: string) => {
        if (id !== taskId) return;
        activity.push({ type: "tool_result", tool, output: output?.slice(0, 2000), ts: new Date().toISOString() });
      };

      const onDone = (id: string, _sessionId: string, result: TaskResult) => {
        if (id !== taskId) return;
        // Flush remaining text
        if (textBuffer.trim()) {
          activity.push({ type: "text", text: textBuffer.trim(), ts: new Date().toISOString() });
        }
        cleanup();
        resolve({ result, activity });
      };

      const onFailed = (id: string, error: string) => {
        if (id !== taskId) return;
        cleanup();
        reject(new Error(error));
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.deps.orchestrator.removeListener("task:token", onToken);
        this.deps.orchestrator.removeListener("task:tool_use", onToolUse);
        this.deps.orchestrator.removeListener("task:tool_result", onToolResult);
        this.deps.orchestrator.removeListener("task:done", onDone);
        this.deps.orchestrator.removeListener("task:failed", onFailed);
      };

      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Task ${taskId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.deps.orchestrator.on("task:token", onToken);
      this.deps.orchestrator.on("task:tool_use", onToolUse);
      this.deps.orchestrator.on("task:tool_result", onToolResult);
      this.deps.orchestrator.on("task:done", onDone);
      this.deps.orchestrator.on("task:failed", onFailed);
    });
  }

  /** Trim large tool inputs (e.g. file contents) to keep activity log manageable */
  private sanitizeInput(tool: string, input: unknown): unknown {
    if (!input || typeof input !== "object") return input;
    const obj = input as Record<string, unknown>;
    const sanitized = { ...obj };
    // Truncate large string values (file content, code blocks)
    for (const [key, val] of Object.entries(sanitized)) {
      if (typeof val === "string" && val.length > 500) {
        sanitized[key] = val.slice(0, 500) + `... (${val.length} chars)`;
      }
    }
    return sanitized;
  }

  private parseAgentSignal(result: TaskResult): { status: string; summary: string } | null {
    // Try result.structured_output first
    try {
      const output = result.structured_output as { status?: string; summary?: string } | undefined;
      if (output && typeof output.status === "string") {
        return { status: output.status, summary: output.summary ?? "" };
      }
    } catch { /* ignore */ }

    // Agent SDK uses a StructuredOutput tool call — check tool_calls
    const structuredCall = result.tool_calls?.find((tc) => tc.tool === "StructuredOutput");
    if (structuredCall) {
      // Try output first (some SDK versions put the JSON here)
      for (const field of [structuredCall.output, structuredCall.input]) {
        try {
          const raw = typeof field === "string" ? field : JSON.stringify(field);
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.status === "string") {
            return { status: parsed.status, summary: parsed.summary ?? "" };
          }
        } catch { /* not valid JSON */ }
      }
    }

    return null;
  }

  /** Evaluate success criteria against run data */
  private evaluateDecision(
    playbook: Playbook,
    runData: { total_cost_usd: number; total_turns: number; chain_count: number; result_summary?: string },
  ): DecisionResult {
    const criteria = playbook.success_criteria;
    if (!criteria?.length) return "skipped";

    for (const criterion of criteria) {
      switch (criterion.type) {
        case "contains":
          if (!runData.result_summary?.includes(criterion.value)) return "fail";
          break;
        case "not_contains":
          if (runData.result_summary?.includes(criterion.value)) return "fail";
          break;
        case "cost_under":
          if (runData.total_cost_usd >= criterion.value) return "fail";
          break;
        case "turns_under":
          if (runData.total_turns >= criterion.value) return "fail";
          break;
        case "chains_under":
          if (runData.chain_count >= criterion.value) return "fail";
          break;
      }
    }
    return "pass";
  }

  private extractSummary(result: TaskResult): string {
    return extractTaskSummary(result);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Build a "summary" string from a completed task result for notifications
 * and run history. Exported (not just a private method) so the test suite
 * can pin the fallback order against real failure cases — e.g. the
 * VZFinance CC-payment playbook that dumped 1 KB of psql query JSON into
 * the Telegram notification because the agent never called StructuredOutput.
 *
 * Order matters and is load-bearing:
 *   1. structured_output.summary  — explicit, preferred path
 *   2. result.text                — final assistant prose
 *   3. StructuredOutput tool call's `input.summary` — same thing in
 *      a slightly different SDK shape
 *   4. Sentinel telling the user the agent didn't summarize
 *
 * Notably absent: a fallback to the last tool call's raw output. That's
 * the agent's *data* (psql rows, file contents, etc.), not its summary,
 * and surfacing it produces nonsense notifications. If the agent failed
 * to summarize, say so.
 */
export function extractTaskSummary(result: TaskResult): string {
  // 1. Try structured_output summary
  if (result.structured_output) {
    const so = result.structured_output as Record<string, unknown>;
    if (typeof so.summary === "string" && so.summary) return so.summary.slice(0, 4000);
  }

  // 2. Use agent text if available
  if (result.text) {
    // If text looks like raw structured output JSON, try to extract useful content
    try {
      const parsed = JSON.parse(result.text);
      // Agent SDK wraps results in { content: [{ type: "text", text: "..." }] }
      if (Array.isArray(parsed?.content)) {
        const texts = parsed.content
          .filter((c: { type: string }) => c.type === "text")
          .map((c: { text: string }) => c.text);
        if (texts.length) return texts.join("\n").slice(0, 4000);
      }
      if (parsed?.summary) return parsed.summary.slice(0, 4000);
    } catch { /* not JSON, use as-is */ }
    return result.text.slice(0, 4000);
  }

  // 3. Try StructuredOutput tool call input (has the agent's actual response)
  const toolCalls = result.tool_calls ?? [];
  const structuredCall = toolCalls.find((tc) => tc.tool === "StructuredOutput");
  if (structuredCall?.input) {
    try {
      const input = typeof structuredCall.input === "string"
        ? JSON.parse(structuredCall.input)
        : structuredCall.input;
      if (typeof input?.summary === "string" && input.summary) return input.summary.slice(0, 4000);
    } catch { /* ignore */ }
  }

  // 4. No StructuredOutput, no agent prose. Don't fall back to the
  //    last tool's raw output — that's the agent's *data*, not its
  //    *summary*, and surfacing it produces nonsense like the
  //    VZFinance CC-payment playbook dumping a 9-turn psql query
  //    result into the Telegram notification. Be explicit instead:
  //    the user should know the agent finished without summarizing
  //    (which usually means the playbook prompt needs to tell the
  //    agent to call StructuredOutput before finishing).
  return `Completed in ${result.turns} turns — the agent didn't write a summary. Add a StructuredOutput contract to the playbook prompt to fix.`;
}
