import { describe, it, expect } from "vitest";
import { extractTaskSummary } from "./chain-runner.js";
import type { TaskResult } from "@vonzio/shared";

/**
 * Locks in the fallback order for `extractTaskSummary`. The most important
 * case here is the regression guard for the VZFinance CC-payment playbook
 * incident — see comments inline.
 */
function mockResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    task_id: "task_test",
    status: "completed",
    text: undefined,
    turns: 0,
    cost_usd: 0,
    structured_output: undefined,
    tool_calls: [],
    ...overrides,
  } as TaskResult;
}

describe("extractTaskSummary", () => {
  it("prefers structured_output.summary when present", () => {
    const r = mockResult({
      structured_output: { status: "DONE", summary: "Logged 3 receipts." },
      text: "should not be used",
    });
    expect(extractTaskSummary(r)).toBe("Logged 3 receipts.");
  });

  it("falls back to result.text when no structured_output", () => {
    const r = mockResult({ text: "Final assistant message." });
    expect(extractTaskSummary(r)).toBe("Final assistant message.");
  });

  it("extracts text from SDK-wrapped { content: [{type:'text', text:...}] } shape", () => {
    const r = mockResult({
      text: JSON.stringify({ content: [{ type: "text", text: "Done." }, { type: "tool_use" }] }),
    });
    expect(extractTaskSummary(r)).toBe("Done.");
  });

  it("falls back to StructuredOutput tool-call input.summary", () => {
    const r = mockResult({
      tool_calls: [
        { tool: "Bash", input: { cmd: "ls" }, output: "file1\nfile2", timestamp: "2026-05-23T00:00:00Z" },
        { tool: "StructuredOutput", input: { status: "DONE", summary: "Listed files." }, output: "", timestamp: "2026-05-23T00:00:01Z" },
      ],
    });
    expect(extractTaskSummary(r)).toBe("Listed files.");
  });

  it("REGRESSION: does NOT surface the last tool call's raw output as the summary", () => {
    // The exact failure mode from VZFinance — CC payment guidance run.
    // The agent ran 9 psql queries, never called StructuredOutput, never
    // produced a final assistant text. Pre-fix we surfaced the last
    // tool's raw JSON output as if it were a summary, producing a 1KB
    // dump in the Telegram notification.
    const psqlDump = JSON.stringify([
      { id: "d214cd4f-…", kind: "daily_log", channel: "telegram", payload: { text: "…" } },
      { id: "031a03cc-…", kind: "bill_due", channel: "telegram", payload: { type: "cc_payment" } },
    ]);
    const r = mockResult({
      turns: 9,
      tool_calls: [
        { tool: "Bash", input: { cmd: "psql -c ..." }, output: psqlDump, timestamp: "2026-05-23T00:00:00Z" },
      ],
    });
    const out = extractTaskSummary(r);
    expect(out).not.toContain("daily_log");
    expect(out).not.toContain("cc_payment");
    expect(out).toContain("didn't write a summary");
    expect(out).toContain("9 turns");
  });

  it("falls through to explicit 'no summary' sentinel when nothing usable", () => {
    const r = mockResult({ turns: 3 });
    const out = extractTaskSummary(r);
    expect(out).toContain("3 turns");
    expect(out).toContain("didn't write a summary");
  });

  it("ignores empty structured_output.summary", () => {
    const r = mockResult({
      structured_output: { status: "DONE", summary: "" },
      text: "the real summary",
    });
    expect(extractTaskSummary(r)).toBe("the real summary");
  });
});
