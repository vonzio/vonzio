import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

/**
 * The gateway runs in-container as a standalone CommonJS file (no build step),
 * so we require it directly and exercise its pure translation functions. The
 * HTTP server only starts under `require.main === module`, so requiring it here
 * is side-effect-free.
 */
const require = createRequire(import.meta.url);
const gw = require("../../../../docker/llm-gateway.cjs") as {
  anthropicToOpenAIRequest: (b: unknown) => any;
  openAIToAnthropicResponse: (b: unknown, m: string) => any;
  makeStreamTranslator: (m: string) => { push: (c: unknown) => string[]; end: () => string[] };
  mapFinishReason: (r: string | null) => string;
};

/** Parse the gateway's Anthropic SSE strings into {event, data} objects. */
function parseSse(frames: string[]) {
  return frames.map((f) => {
    const ev = /event: (.*)/.exec(f)?.[1];
    const data = /data: (.*)/.exec(f)?.[1];
    return { event: ev, data: data ? JSON.parse(data) : null };
  });
}

describe("llm-gateway request translation (Anthropic -> OpenAI)", () => {
  it("flattens system and translates a simple user turn", () => {
    const oa = gw.anthropicToOpenAIRequest({
      model: "gpt-x",
      system: "You are helpful.",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(oa.model).toBe("gpt-x");
    expect(oa.max_tokens).toBe(100);
    expect(oa.messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(oa.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("translates tools and tool_choice", () => {
    const oa = gw.anthropicToOpenAIRequest({
      model: "gpt-x",
      max_tokens: 10,
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "any" },
    });
    expect(oa.tools[0]).toEqual({
      type: "function",
      function: { name: "get_weather", description: "w", parameters: { type: "object", properties: {} } },
    });
    expect(oa.tool_choice).toBe("required");
  });

  it("maps assistant tool_use blocks to tool_calls and user tool_result to role:tool", () => {
    const oa = gw.anthropicToOpenAIRequest({
      model: "gpt-x",
      max_tokens: 10,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: { a: 1 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result text" }] },
      ],
    });
    const assistant = oa.messages.find((m: any) => m.role === "assistant");
    expect(assistant.tool_calls[0]).toEqual({
      id: "t1",
      type: "function",
      function: { name: "f", arguments: JSON.stringify({ a: 1 }) },
    });
    const tool = oa.messages.find((m: any) => m.role === "tool");
    expect(tool).toEqual({ role: "tool", tool_call_id: "t1", content: "result text" });
  });
});

describe("llm-gateway response translation (OpenAI -> Anthropic)", () => {
  it("translates text + tool_calls and maps finish_reason/usage", () => {
    const anth = gw.openAIToAnthropicResponse(
      {
        id: "cmpl_1",
        model: "gpt-x",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "sure",
              tool_calls: [{ id: "t1", function: { name: "f", arguments: '{"a":1}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      },
      "fallback",
    );
    expect(anth.type).toBe("message");
    expect(anth.stop_reason).toBe("tool_use");
    expect(anth.content[0]).toEqual({ type: "text", text: "sure" });
    expect(anth.content[1]).toEqual({ type: "tool_use", id: "t1", name: "f", input: { a: 1 } });
    expect(anth.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
  });

  it("maps finish reasons", () => {
    expect(gw.mapFinishReason("stop")).toBe("end_turn");
    expect(gw.mapFinishReason("length")).toBe("max_tokens");
    expect(gw.mapFinishReason("tool_calls")).toBe("tool_use");
    expect(gw.mapFinishReason(null)).toBe("end_turn");
  });
});

describe("llm-gateway streaming translation (OpenAI SSE -> Anthropic SSE)", () => {
  it("emits a well-formed Anthropic event sequence for text", () => {
    const tr = gw.makeStreamTranslator("gpt-x");
    const frames = [
      ...tr.push({ choices: [{ delta: { content: "Hel" } }] }),
      ...tr.push({ choices: [{ delta: { content: "lo" } }] }),
      ...tr.push({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
      ...tr.end(),
    ];
    const events = parseSse(frames);
    const types = events.map((e) => e.event);
    expect(types[0]).toBe("message_start");
    expect(types).toContain("content_block_start");
    expect(types.filter((t) => t === "content_block_delta")).toHaveLength(2);
    expect(types).toContain("content_block_stop");
    const delta = events.find((e) => e.event === "message_delta");
    expect(delta?.data.delta.stop_reason).toBe("end_turn");
    expect(delta?.data.usage.output_tokens).toBe(2);
    expect(types[types.length - 1]).toBe("message_stop");
  });

  it("opens a tool_use block and streams input_json_delta for tool calls", () => {
    const tr = gw.makeStreamTranslator("gpt-x");
    const frames = [
      ...tr.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "f", arguments: "" } }] } }] }),
      ...tr.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] }),
      ...tr.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      ...tr.end(),
    ];
    const events = parseSse(frames);
    const start = events.find((e) => e.event === "content_block_start");
    expect(start?.data.content_block.type).toBe("tool_use");
    expect(start?.data.content_block.name).toBe("f");
    const jsonDelta = events.find(
      (e) => e.event === "content_block_delta" && e.data.delta.type === "input_json_delta",
    );
    expect(jsonDelta?.data.delta.partial_json).toBe('{"a":1}');
    const msgDelta = events.find((e) => e.event === "message_delta");
    expect(msgDelta?.data.delta.stop_reason).toBe("tool_use");
  });
});
