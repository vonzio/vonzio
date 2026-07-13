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
  parseContextLimit: (t: string) => number | null;
  trimOpenAIToolsToFit: (oa: any, limit: number) => { dropped: number; changed: boolean };
  estimateTokens: (s: string) => number;
  anthropicToCodexRequest: (b: unknown, o?: unknown) => any;
  makeCodexStreamTranslator: (m: string) => { push: (e: unknown) => string[]; end: () => string[] };
  codexResponsesUrl: (base: string) => string;
  translateMessageToResponses: (m: unknown, out: unknown[]) => void;
  foldAnthropicSSE: (events: string[], model: string) => any;
};

/** Parse an Anthropic SSE string array into typed event objects. */
function parseSSE(events: string[]): any[] {
  return events.map((e) => JSON.parse(/^data: (.*)$/m.exec(e)![1]));
}

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

  it("routes the token cap to max_completion_tokens for GPT-5 / o-series, max_tokens otherwise", () => {
    // gpt-4* and OpenAI-compatible servers: legacy max_tokens
    const legacy = gw.anthropicToOpenAIRequest({
      model: "gpt-4o",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(legacy.max_tokens).toBe(256);
    expect(legacy.max_completion_tokens).toBeUndefined();

    // GPT-5 family rejects max_tokens — must use max_completion_tokens
    const gpt5 = gw.anthropicToOpenAIRequest({
      model: "gpt-5.4",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(gpt5.max_completion_tokens).toBe(256);
    expect(gpt5.max_tokens).toBeUndefined();

    // o-series reasoning models likewise
    const o3 = gw.anthropicToOpenAIRequest({
      model: "o3-mini",
      max_tokens: 256,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(o3.max_completion_tokens).toBe(256);
    expect(o3.max_tokens).toBeUndefined();
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

describe("llm-gateway adaptive tool trimming", () => {
  it("parseContextLimit reads the model's limit (or null for non-context errors)", () => {
    expect(gw.parseContextLimit("This model's maximum context length is 8192 tokens. However...")).toBe(8192);
    expect(gw.parseContextLimit('{"code":"context_length_exceeded"}')).toBe(8192); // fallback
    expect(gw.parseContextLimit('{"error":"Incorrect API key provided"}')).toBeNull();
    expect(gw.parseContextLimit("")).toBeNull();
  });

  it("trimOpenAIToolsToFit keeps essential tools first and drops the long tail to fit", () => {
    // 30 fat tools (~ a few hundred tokens each via a long description).
    const desc = "x".repeat(800);
    const mk = (name: string) => ({ type: "function", function: { name, description: desc, parameters: { type: "object", properties: {} } } });
    const oa: any = {
      model: "small",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        ...["mcp__a", "mcp__b", "mcp__c"].map(mk), // unknown/MCP — dropped first
        mk("Bash"), mk("Read"), mk("Write"), mk("Edit"), mk("Grep"),
      ],
    };
    const before = oa.tools.length;
    const { dropped } = gw.trimOpenAIToolsToFit(oa, 1200); // tiny budget
    expect(dropped).toBeGreaterThan(0);
    const kept = (oa.tools ?? []).map((t: any) => t.function.name);
    // Core built-ins outrank the MCP tail under a tiny budget, so survivors are core.
    for (const name of kept) expect(name).not.toMatch(/^mcp__/);
    expect(before - kept.length).toBe(dropped);
  });

  it("trimOpenAIToolsToFit drops all tools (and tool_choice) when nothing fits", () => {
    const oa: any = {
      messages: [{ role: "user", content: "x".repeat(40000) }], // huge prompt
      tools: [{ type: "function", function: { name: "Bash", description: "y".repeat(2000), parameters: {} } }],
      tool_choice: "auto",
    };
    const { dropped } = gw.trimOpenAIToolsToFit(oa, 8192);
    expect(dropped).toBe(1);
    expect(oa.tools).toBeUndefined();
    expect(oa.tool_choice).toBeUndefined();
  });

  it("caps long descriptions before dropping tools (keeps all when capping fits)", () => {
    const mk = (name: string) => ({ type: "function", function: { name, description: "d".repeat(5000), parameters: {} } });
    const oa: any = {
      messages: [{ role: "user", content: "hi" }],
      tools: [mk("Bash"), mk("Read"), mk("mcp__x")],
    };
    // Too small for 3×5000-char descs, ample for 3 capped (≤600) ones.
    const r = gw.trimOpenAIToolsToFit(oa, 1024 + 10 + 700);
    expect(r.dropped).toBe(0);       // nothing dropped — capping alone fit
    expect(r.changed).toBe(true);    // but we did change (capped), so retry
    expect(oa.tools.length).toBe(3);
    for (const t of oa.tools) expect(t.function.description.length).toBeLessThanOrEqual(601);
  });

  it("priority: core built-ins > MCP/configured > generic long tail", () => {
    const mk = (name: string) => ({ type: "function", function: { name, description: "d".repeat(200), parameters: {} } });
    const web = mk("WebSearch"); // generic long tail — dropped first
    const mcp = mk("mcp__db__query"); // operator-configured — kept over long tail
    const bash = mk("Bash"); // core — kept first
    const oa: any = { messages: [{ role: "user", content: "hi" }], tools: [web, mcp, bash] };
    // Budget == exactly Bash + mcp, so the long-tail WebSearch can't fit.
    const cBash = gw.estimateTokens(JSON.stringify(bash));
    const cMcp = gw.estimateTokens(JSON.stringify(mcp));
    const msgTok = gw.estimateTokens(JSON.stringify(oa.messages));
    const r = gw.trimOpenAIToolsToFit(oa, cBash + cMcp + msgTok + 1024);
    expect(r.dropped).toBe(1);
    const kept = (oa.tools ?? []).map((t: any) => t.function.name);
    expect(kept).toContain("Bash");
    expect(kept).toContain("mcp__db__query");
    expect(kept).not.toContain("WebSearch");
  });

  it("resets a forced tool_choice to auto when that tool is trimmed away", () => {
    const oa: any = {
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "Bash", description: "run a command", parameters: {} } }, // small, kept
        { type: "function", function: { name: "mcp__rare", description: "z".repeat(4000), parameters: {} } }, // fat, dropped
      ],
      tool_choice: { type: "function", function: { name: "mcp__rare" } },
    };
    // Budget fits the small Bash tool but not the fat mcp__rare one.
    gw.trimOpenAIToolsToFit(oa, 1024 + 10 + 120);
    const names = (oa.tools ?? []).map((t: any) => t.function.name);
    expect(names).toContain("Bash");
    expect(names).not.toContain("mcp__rare");
    expect(oa.tool_choice).toBe("auto");
  });
});

// ─── Codex mode: Anthropic <-> OpenAI Responses API ──────────────────────

describe("codex request translation (Anthropic -> Responses API)", () => {
  it("maps system→instructions, messages→input, and forces store:false", () => {
    const cx = gw.anthropicToCodexRequest({
      model: "gpt-5.5",
      system: "be terse",
      stream: true,
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(cx.model).toBe("gpt-5.5");
    expect(cx.instructions).toBe("be terse");
    expect(cx.store).toBe(false);
    expect(cx.stream).toBe(true);
    // We deliberately do NOT request reasoning.encrypted_content (we can't carry
    // it back through the Anthropic wire format, and requesting-then-dropping it
    // breaks tool continuation on some backends).
    expect(cx.include).toBeUndefined();
    // Codex rejects max_output_tokens — the SDK's max_tokens must be dropped.
    expect(cx.max_output_tokens).toBeUndefined();
    expect(cx.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
  });

  it("emits function_call / function_call_output as top-level input items", () => {
    const input: any[] = [];
    gw.translateMessageToResponses(
      { role: "assistant", content: [{ type: "text", text: "let me check" }, { type: "tool_use", id: "call_1", name: "ls", input: { path: "/" } }] },
      input,
    );
    gw.translateMessageToResponses(
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file.txt" }] },
      input,
    );
    expect(input[0]).toEqual({ role: "assistant", content: [{ type: "output_text", text: "let me check" }] });
    expect(input[1]).toEqual({ type: "function_call", call_id: "call_1", name: "ls", arguments: JSON.stringify({ path: "/" }) });
    expect(input[2]).toEqual({ type: "function_call_output", call_id: "call_1", output: "file.txt" });
  });

  it("translates tools to the flat Responses shape", () => {
    const cx = gw.anthropicToCodexRequest({
      model: "gpt-5.5",
      messages: [],
      tools: [{ name: "ls", description: "list", input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "tool", name: "ls" },
    });
    expect(cx.tools[0]).toMatchObject({ type: "function", name: "ls", description: "list" });
    expect(cx.tool_choice).toEqual({ type: "function", name: "ls" });
  });
});

describe("codexResponsesUrl", () => {
  it("appends /codex/responses and tolerates partial bases", () => {
    expect(gw.codexResponsesUrl("https://chatgpt.com/backend-api")).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(gw.codexResponsesUrl("https://chatgpt.com/backend-api/codex")).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(gw.codexResponsesUrl("https://x/backend-api/codex/responses")).toBe("https://x/backend-api/codex/responses");
  });
});

describe("codex streaming translation (Responses SSE -> Anthropic SSE)", () => {
  // These are the REAL event shapes captured from chatgpt.com/backend-api/codex.
  const stream = [
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.output_item.added", item: { id: "rs_1", type: "reasoning", encrypted_content: "xxx" } },
    { type: "response.output_item.added", item: { id: "msg_1", type: "message" } },
    { type: "response.output_text.delta", item_id: "msg_1", content_index: 0, delta: "po" },
    { type: "response.output_text.delta", item_id: "msg_1", content_index: 0, delta: "ng" },
    { type: "response.output_text.done", item_id: "msg_1" },
    { type: "response.output_item.done", item: { id: "msg_1", type: "message" } },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 21, output_tokens: 17 } } },
  ];

  it("drops reasoning, streams text, and closes with usage + end_turn", () => {
    const tr = gw.makeCodexStreamTranslator("gpt-5.5");
    const out: string[] = [];
    for (const e of stream) out.push(...tr.push(e));
    out.push(...tr.end());
    const evts = parseSSE(out);
    const types = evts.map((e) => e.type);
    expect(types[0]).toBe("message_start");
    expect(types).toContain("content_block_start");
    // exactly one text block opened (reasoning dropped)
    expect(evts.filter((e) => e.type === "content_block_start").length).toBe(1);
    const text = evts.filter((e) => e.type === "content_block_delta").map((e) => e.delta.text).join("");
    expect(text).toBe("pong");
    const md = evts.find((e) => e.type === "message_delta");
    expect(md.delta.stop_reason).toBe("end_turn");
    expect(md.usage).toEqual({ input_tokens: 21, output_tokens: 17 });
    expect(types.at(-1)).toBe("message_stop");
  });

  it("maps a function call to a tool_use block with input_json_delta and tool_use stop", () => {
    const tr = gw.makeCodexStreamTranslator("gpt-5.5");
    const evseq = [
      { type: "response.created", response: { id: "r" } },
      { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "call_abc", name: "ls" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"/"}' },
      { type: "response.output_item.done", item: { id: "fc_1", type: "function_call" } },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3 } } },
    ];
    const out: string[] = [];
    for (const e of evseq) out.push(...tr.push(e));
    out.push(...tr.end());
    const evts = parseSSE(out);
    const start = evts.find((e) => e.type === "content_block_start");
    expect(start.content_block).toMatchObject({ type: "tool_use", id: "call_abc", name: "ls" });
    const json = evts.filter((e) => e.type === "content_block_delta").map((e) => e.delta.partial_json).join("");
    expect(JSON.parse(json)).toEqual({ path: "/" });
    expect(evts.find((e) => e.type === "message_delta").delta.stop_reason).toBe("tool_use");
  });

  it("falls back to the completed item's arguments when a tool call streams no deltas", () => {
    const tr = gw.makeCodexStreamTranslator("gpt-5.5");
    const out: string[] = [];
    for (const e of [
      { type: "response.created", response: { id: "r" } },
      { type: "response.output_item.added", item: { id: "fc_2", type: "function_call", call_id: "call_x", name: "ls" } },
      // no function_call_arguments.delta events — args only on the done item
      { type: "response.output_item.done", item: { id: "fc_2", type: "function_call", arguments: '{"path":"/tmp"}' } },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
    ]) out.push(...tr.push(e));
    out.push(...tr.end());
    const evts = parseSSE(out);
    const json = evts.filter((e) => e.type === "content_block_delta").map((e) => e.delta.partial_json).join("");
    expect(JSON.parse(json)).toEqual({ path: "/tmp" });
  });
});

describe("foldAnthropicSSE (non-streaming collapse)", () => {
  it("reassembles text + usage into a Messages response", () => {
    const tr = gw.makeCodexStreamTranslator("gpt-5.5");
    const out: string[] = [];
    for (const e of [
      { type: "response.output_item.added", item: { id: "m", type: "message" } },
      { type: "response.output_text.delta", item_id: "m", delta: "hello" },
      { type: "response.output_item.done", item: { id: "m" } },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 2, output_tokens: 1 } } },
    ]) out.push(...tr.push(e));
    out.push(...tr.end());
    const msg = gw.foldAnthropicSSE(out, "gpt-5.5");
    expect(msg.type).toBe("message");
    expect(msg.content).toEqual([{ type: "text", text: "hello" }]);
    expect(msg.stop_reason).toBe("end_turn");
    expect(msg.usage).toEqual({ input_tokens: 2, output_tokens: 1 });
  });
});
