import type { GoalVerdict, GoalStopReason } from "./agent-comms.js";

export interface GoalLoopState {
  /** Continuation rounds already performed (0 on the first judge). */
  iteration: number;
  /** Cumulative cost across all rounds so far, USD. */
  totalCost: number;
  /** Whether the PREVIOUS round made progress (true before the first round). */
  prevProgress: boolean;
}

export interface GoalLimits {
  maxIterations: number;
  /** USD ceiling; use Infinity for none. */
  budgetCap: number;
}

export type GoalDecision =
  | { action: "stop"; reason: GoalStopReason }
  | { action: "continue" };

/**
 * Pure decision for the goal loop given a fresh verdict + the loop state.
 * Kept side-effect-free so the stop conditions are unit-testable without the
 * orchestrator's container/DB machinery. Evaluation order matters: completion
 * wins over limits, and limits win over the no-progress bail.
 */
export function decideGoalNext(
  verdict: GoalVerdict,
  state: GoalLoopState,
  limits: GoalLimits,
): GoalDecision {
  if (verdict.done) return { action: "stop", reason: "done" };
  if (state.iteration >= limits.maxIterations) return { action: "stop", reason: "max_iterations" };
  if (state.totalCost >= limits.budgetCap) return { action: "stop", reason: "budget" };
  // Two consecutive rounds without progress → bail (avoid spinning).
  if (!verdict.progress_made && !state.prevProgress) return { action: "stop", reason: "no_progress" };
  return { action: "continue" };
}
