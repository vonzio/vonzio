import { describe, it, expect } from "vitest";
import { decideGoalNext } from "./goal-loop.js";
import type { GoalVerdict } from "./agent-comms.js";

const verdict = (v: Partial<GoalVerdict>): GoalVerdict => ({
  done: false, missing: [], progress_made: true, rationale: "", ...v,
});
const limits = { maxIterations: 5, budgetCap: 1.0 };

describe("decideGoalNext", () => {
  it("continues when not done, within limits, and making progress", () => {
    expect(decideGoalNext(verdict({}), { iteration: 0, totalCost: 0, prevProgress: true }, limits))
      .toEqual({ action: "continue" });
  });

  it("stops 'done' regardless of other state", () => {
    expect(decideGoalNext(verdict({ done: true }), { iteration: 9, totalCost: 99, prevProgress: false }, limits))
      .toEqual({ action: "stop", reason: "done" });
  });

  it("stops 'max_iterations' at the cap", () => {
    expect(decideGoalNext(verdict({}), { iteration: 5, totalCost: 0, prevProgress: true }, limits))
      .toEqual({ action: "stop", reason: "max_iterations" });
  });

  it("stops 'budget' when cumulative cost meets the cap", () => {
    expect(decideGoalNext(verdict({}), { iteration: 1, totalCost: 1.0, prevProgress: true }, limits))
      .toEqual({ action: "stop", reason: "budget" });
  });

  it("stops 'no_progress' only after TWO consecutive no-progress rounds", () => {
    // First no-progress round (prev WAS progress) → still continue.
    expect(decideGoalNext(verdict({ progress_made: false }), { iteration: 1, totalCost: 0, prevProgress: true }, limits))
      .toEqual({ action: "continue" });
    // Second consecutive no-progress → bail.
    expect(decideGoalNext(verdict({ progress_made: false }), { iteration: 2, totalCost: 0, prevProgress: false }, limits))
      .toEqual({ action: "stop", reason: "no_progress" });
  });

  it("prioritises done over limits, and limits over no_progress", () => {
    // done beats max_iterations
    expect(decideGoalNext(verdict({ done: true, progress_made: false }), { iteration: 5, totalCost: 2, prevProgress: false }, limits).action).toBe("stop");
    expect(decideGoalNext(verdict({ done: true }), { iteration: 5, totalCost: 2, prevProgress: false }, limits))
      .toEqual({ action: "stop", reason: "done" });
    // max_iterations beats no_progress
    expect(decideGoalNext(verdict({ progress_made: false }), { iteration: 5, totalCost: 0, prevProgress: false }, limits))
      .toEqual({ action: "stop", reason: "max_iterations" });
  });
});
