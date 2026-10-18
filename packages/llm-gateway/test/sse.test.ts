import { describe, it, expect } from "vitest";
import { AnthropicStream, errorStatus, foldResult } from "../src/sse.js";

function parse(frames: string[]) {
  return frames.map((f) => {
    const m = /^event: (\S+)\ndata: (.*)\n\n$/s.exec(f);
    if (!m) throw new Error(`bad frame: ${f}`);
    return { event: m[1], data: JSON.parse(m[2]) as Record<string, unknown> };
  });
}

describe("AnthropicStream", () => {
  it("emits a well-formed sequence for text, then tool calls, then the stop", () => {
    const out: string[] = [];
    const s = new AnthropicStream("gpt-x", (c) => out.push(c));
    s.push({ type: "text", delta: "Let me " });
    s.push({ type: "text", delta: "look." });
    s.push({ type: "tool_call_start", id: "call_1", name: "Read" });
    s.push({ type: "tool_call_delta", id: "call_1", argsDelta: '{"path":' });
    s.push({ type: "tool_call_delta", id: "call_1", argsDelta: '"a.txt"}' });
    s.push({ type: "tool_call_end", id: "call_1" });
    s.push({ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } });
    s.end({ ok: true, text: "Let me look.", toolCalls: [{ id: "call_1", name: "Read", args: { path: "a.txt" } }], stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } });

    const events = parse(out);
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
      "message_delta", "message_stop",
    ]);
    const start = events[0].data as { message: { model: string; role: string } };
    expect(start.message.model).toBe("gpt-x");
    const toolStart = events[5].data as { index: number; content_block: Record<string, unknown> };
    expect(toolStart.index).toBe(1);
    expect(toolStart.content_block).toEqual({ type: "tool_use", id: "call_1", name: "Read", input: {} });
    const json = events.slice(6, 8).map((e) => (e.data as { delta: { partial_json: string } }).delta.partial_json).join("");
    expect(JSON.parse(json)).toEqual({ path: "a.txt" });
    const delta = events[9].data as { delta: { stop_reason: string }; usage: { input_tokens: number; output_tokens: number } };
    expect(delta.delta.stop_reason).toBe("tool_use");
    expect(delta.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("emits a result's calls that never streamed, and {} for a call with no arguments", () => {
    const out: string[] = [];
    const s = new AnthropicStream("m", (c) => out.push(c));
    s.push({ type: "tool_call_start", id: "a", name: "Noop" });
    s.push({ type: "tool_call_end", id: "a" });
    s.end({ ok: true, toolCalls: [{ id: "a", name: "Noop", args: {} }, { id: "b", name: "Late", args: { x: 1 } }], stopReason: "tool_use" });
    const events = parse(out);
    const deltas = events.filter((e) => e.event === "content_block_delta").map((e) => (e.data as { delta: { partial_json: string } }).delta.partial_json);
    expect(deltas).toEqual(["{}", '{"x":1}']);
    expect(events.filter((e) => e.event === "content_block_stop")).toHaveLength(2);
  });

  it("writes the final text when nothing streamed and maps end → end_turn", () => {
    const out: string[] = [];
    const s = new AnthropicStream("m", (c) => out.push(c));
    s.end({ ok: true, text: "Done.", stopReason: "end" });
    const events = parse(out);
    expect(events.map((e) => e.event)).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    expect((events[4].data as { delta: { stop_reason: string } }).delta.stop_reason).toBe("end_turn");
  });

  it("fail() writes an error event after a started stream", () => {
    const out: string[] = [];
    const s = new AnthropicStream("m", (c) => out.push(c));
    s.push({ type: "text", delta: "par" });
    s.fail("HTTP 500: boom");
    const events = parse(out);
    expect(events.at(-1)).toEqual({ event: "error", data: { type: "error", error: { type: "api_error", message: "HTTP 500: boom" } } });
  });
});

describe("foldResult", () => {
  it("builds a Messages response with text + tool_use and max_tokens", () => {
    const r = foldResult({ ok: true, text: "t", toolCalls: [{ id: "c", name: "F", argsError: { raw: "{bad" } }], stopReason: "length", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 } }, "m");
    expect(r.content).toEqual([{ type: "text", text: "t" }, { type: "tool_use", id: "c", name: "F", input: {} }]);
    expect(r.stop_reason).toBe("max_tokens");
    expect(r.usage).toEqual({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 });
  });
});

describe("errorStatus", () => {
  it("keeps the provider's status and maps it to Anthropic's error types", () => {
    expect(errorStatus("HTTP 401: nope")).toEqual({ status: 401, type: "authentication_error" });
    expect(errorStatus("HTTP 429: slow")).toEqual({ status: 429, type: "rate_limit_error" });
    expect(errorStatus("HTTP 400: bad")).toEqual({ status: 400, type: "invalid_request_error" });
    expect(errorStatus("ChatGPT rejected this sign-in. Sign in again in Settings.")).toEqual({ status: 401, type: "authentication_error" });
    expect(errorStatus("Timed out waiting for the model.")).toEqual({ status: 504, type: "api_error" });
    expect(errorStatus("Network error")).toEqual({ status: 502, type: "api_error" });
  });

  it("maps a rejected model to 400 so the SDK does not retry it as a 5xx", () => {
    expect(errorStatus("That model is not available for this ChatGPT account. Pick another model in Settings."))
      .toEqual({ status: 400, type: "invalid_request_error" });
  });
});
