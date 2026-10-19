import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Agent SDK before importing runner
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

import { runTask } from "./runner.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

const mockQuery = vi.mocked(query);

describe("runTask", () => {
  let output: string[];

  beforeEach(() => {
    output = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(chunk.toString());
      return true;
    });
  });

  function mockMessages(messages: Record<string, unknown>[]) {
    mockQuery.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        for (const msg of messages) {
          yield msg;
        }
      },
    } as ReturnType<typeof query>);
  }

  function parsedOutput(): Record<string, unknown>[] {
    return output
      .join("")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }

  it("emits init message with session_id", async () => {
    mockMessages([
      { type: "system", subtype: "init", session_id: "sess_abc" },
      { type: "result", subtype: "success", result: "done", session_id: "sess_abc", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01, num_turns: 1 },
    ]);

    await runTask({ prompt: "Hello" });
    const msgs = parsedOutput();

    expect(msgs[0]).toEqual({ type: "init", session_id: "sess_abc" });
  });

  it("emits token messages from stream events", async () => {
    mockMessages([
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello " },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "world" },
        },
      },
      { type: "result", subtype: "success", result: "Hello world", session_id: "s1", usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01, num_turns: 1 },
    ]);

    await runTask({ prompt: "test" });
    const msgs = parsedOutput();

    const tokens = msgs.filter((m) => m.type === "token");
    expect(tokens).toHaveLength(2);
    expect(tokens[0].text).toBe("Hello ");
    expect(tokens[1].text).toBe("world");
  });

  it("emits result on success", async () => {
    mockMessages([
      {
        type: "result",
        subtype: "success",
        result: "Analysis complete",
        session_id: "sess_1",
        usage: { input_tokens: 100, output_tokens: 50 },
        total_cost_usd: 0.05,
        num_turns: 3,
      },
    ]);

    await runTask({ prompt: "analyze" });
    const msgs = parsedOutput();

    const result = msgs.find((m) => m.type === "result") as Record<string, unknown>;
    expect(result.session_id).toBe("sess_1");
    expect(result.result).toEqual({
      text: "Analysis complete",
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.05,
      turns: 3,
    });
  });

  it("emits error on failure", async () => {
    mockMessages([
      { type: "result", subtype: "error" },
    ]);

    await runTask({ prompt: "fail" });
    const msgs = parsedOutput();

    const err = msgs.find((m) => m.type === "error");
    expect(err).toBeTruthy();
    expect((err as Record<string, unknown>).error).toContain("Agent failed");
  });

  it("reports a failed API call once, as an error without the SDK prefix", async () => {
    const text = "Failed to authenticate. API Error: 401 Unauthorized";
    mockQuery.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text }] } };
        yield { type: "result", subtype: "success", is_error: true, result: text, session_id: "s", usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0, num_turns: 1 };
        throw new Error(`Claude Code returned an error result: ${text}`);
      },
    } as unknown as ReturnType<typeof query>);

    await runTask({ prompt: "hi" });
    const msgs = parsedOutput();

    expect(msgs.filter((m) => m.type === "token")).toEqual([]);
    expect(msgs.filter((m) => m.type === "error")).toEqual([{ type: "error", error: text }]);
    expect((msgs.find((m) => m.type === "result") as { result: { text: string } }).result.text).toBe("");
  });

  it("aborts instead of retrying a rejected key", async () => {
    let pulledAfterRetry = false;
    mockQuery.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 401, error: "authentication_failed" };
        pulledAfterRetry = true;
        yield { type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 1000, error_status: 401, error: "authentication_failed" };
      },
    } as unknown as ReturnType<typeof query>);

    await runTask({ prompt: "hi" });
    const opts = (mockQuery.mock.calls.at(-1)?.[0] as { options: { abortController: AbortController } }).options;

    expect(pulledAfterRetry).toBe(false);
    expect(opts.abortController.signal.aborted).toBe(true);
    expect(parsedOutput().filter((m) => m.type === "error")).toEqual([{ type: "error", error: "API Error: 401 Unauthorized" }]);
  });

  it("keeps retrying transient failures", async () => {
    mockMessages([
      { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: "overloaded" },
      { type: "result", subtype: "success", result: "ok", session_id: "s", usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0, num_turns: 1 },
    ]);
    await runTask({ prompt: "hi" });
    const msgs = parsedOutput();
    expect(msgs.some((m) => m.type === "error")).toBe(false);
    expect((msgs.find((m) => m.type === "result") as { result: { text: string } }).result.text).toBe("ok");
  });

  it("strips the SDK prefix from a thrown failure", async () => {
    mockQuery.mockReturnValue({
      [Symbol.asyncIterator]: async function* () {
        throw new Error("Claude Code returned an error result: something broke");
      },
    } as unknown as ReturnType<typeof query>);
    await runTask({ prompt: "hi" });
    expect(parsedOutput()).toEqual([{ type: "error", error: "something broke" }]);
  });

  it("resumes session when resume flag is set", async () => {
    mockMessages([
      { type: "result", subtype: "success", result: "ok", session_id: "s", usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0, num_turns: 1 },
    ]);

    await runTask({
      prompt: "test prompt",
      allowed_tools: ["Read", "Grep"],
      max_turns: 10,
      max_budget_usd: 1.5,
      session_id: "resume_sess",
      resume: true,
    });

    expect(mockQuery).toHaveBeenCalledWith({
      prompt: "test prompt",
      options: expect.objectContaining({
        allowedTools: ["Read", "Grep"],
        maxTurns: 10,
        maxBudgetUsd: 1.5,
        resume: "resume_sess",
      }),
    });
    // sessionId should NOT be set when resuming
    expect(mockQuery.mock.calls[0][0].options.sessionId).toBeUndefined();
  });

  it("does not set resume on first turn (no resume flag)", async () => {
    mockMessages([
      { type: "result", subtype: "success", result: "ok", session_id: "s", usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0, num_turns: 1 },
    ]);

    await runTask({
      prompt: "first turn",
      session_id: "my-session-uuid",
      // resume not set = first turn → SDK generates its own session ID
    });

    // Should NOT have resume set on first turn
    expect(mockQuery.mock.calls[0][0].options.resume).toBeUndefined();
  });
});
