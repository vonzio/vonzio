import { describe, it, expect } from "vitest";
import { anthropicToChatRequest, systemToText } from "../src/translate.js";

describe("anthropicToChatRequest", () => {
  it("flattens system blocks and keeps a plain user turn as a string", () => {
    const req = anthropicToChatRequest({
      system: [{ type: "text", text: "You are Claude Code." }, { type: "text", text: "Be brief." }],
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      max_tokens: 4096,
    });
    expect(req.system).toBe("You are Claude Code.\n\nBe brief.");
    expect(req.messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(req.maxTokens).toBe(4096);
    expect(req.parallelToolCalls).toBe(true);
    expect(req.tools).toBeUndefined();
  });

  it("maps tool_use to toolCalls and tool_result to a named tool message, results first", () => {
    const req = anthropicToChatRequest({
      messages: [
        { role: "user", content: "Read it" },
        { role: "assistant", content: [{ type: "text", text: "Reading." }, { type: "tool_use", id: "tu_1", name: "Read", input: { path: "a.txt" } }] },
        { role: "user", content: [
          { type: "text", text: "and then?" },
          { type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "hello" }], is_error: true },
        ] },
      ],
      tools: [
        { name: "Read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
        { type: "web_search_20250305", name: "web_search" },
      ],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    });
    expect(req.messages).toEqual([
      { role: "user", content: "Read it" },
      { role: "assistant", content: "Reading.", toolCalls: [{ id: "tu_1", name: "Read", args: { path: "a.txt" } }] },
      { role: "tool", toolCallId: "tu_1", name: "Read", content: "hello", isError: true },
      { role: "user", content: "and then?" },
    ]);
    expect(req.tools).toEqual([{ name: "Read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }]);
    expect(req.parallelToolCalls).toBe(false);
  });

  it("carries images and PDFs as parts and drops thinking blocks", () => {
    const req = anthropicToChatRequest({
      messages: [
        { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "x" }, { type: "text", text: "ok" }] },
        { role: "user", content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: "BBBB" }, title: "spec.pdf" },
          { type: "text", text: "see" },
        ] },
      ],
    });
    expect(req.messages[0]).toEqual({ role: "assistant", content: "ok" });
    expect(req.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "image", mediaType: "image/png", data: "AAAA" },
        { type: "document", mediaType: "application/pdf", data: "BBBB", name: "spec.pdf" },
        { type: "text", text: "see" },
      ],
    });
  });

  it("systemToText tolerates every shape", () => {
    expect(systemToText(undefined)).toBe("");
    expect(systemToText("s")).toBe("s");
    expect(systemToText([{ type: "text", text: "a" }, { type: "other" }])).toBe("a");
  });
});
