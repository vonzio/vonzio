/**
 * End to end through the HTTP server: an Anthropic Messages request in, byok's
 * upstream call stubbed at `fetch`, Anthropic SSE (or JSON) out.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import http from "node:http";
import { createServer, configFromEnv } from "../src/server.js";
import { relocateToolResultImages, rewriteMessagesBody } from "../src/passthrough.js";

let server: http.Server;
let port: number;

beforeEach(async () => {
  server = createServer({ mode: "openai", target: "https://llm.example/v1", raw: false, port: 0 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>((r) => server.close(() => r()));
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "x-api-key": "sk-test", "content-length": Buffer.byteLength(data), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

const sse = (lines: string[]) => lines.map((l) => `data: ${l}`).join("\n\n") + "\n\ndata: [DONE]\n\n";

const ANTHROPIC_REQ = {
  model: "claude-sonnet-4-6",
  system: "Be brief.",
  messages: [{ role: "user", content: "Price of the blue mug?" }],
  tools: [{ name: "get_price", description: "d", input_schema: { type: "object", properties: { product: { type: "string" } } } }],
  max_tokens: 1024,
  stream: true,
};

describe("openai mode", () => {
  it("streams a Chat Completions turn back as Anthropic SSE and substitutes the session model", async () => {
    process.env.LLM_GATEWAY_DEFAULT_MODEL = "gpt-x";
    const fetchSpy = vi.fn(async () => new Response(sse([
      '{"choices":[{"delta":{"content":"Checking"}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_price","arguments":""}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"product\\":\\"blue mug\\"}"}}]}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":7}}',
    ]), { status: 200, headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchSpy);

    const res = await post("/v1/messages", ANTHROPIC_REQ);
    delete process.env.LLM_GATEWAY_DEFAULT_MODEL;

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    const events = res.text.split("\n\n").filter(Boolean).map((f) => /^event: (\S+)/.exec(f)![1]);
    expect(events[0]).toBe("message_start");
    expect(events).toContain("content_block_delta");
    expect(events.at(-2)).toBe("message_delta");
    expect(events.at(-1)).toBe("message_stop");
    expect(res.text).toContain('"stop_reason":"tool_use"');
    expect(res.text).toContain('"name":"get_price"');
    expect(res.text).toContain('"input_tokens":12');

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [URL | string, RequestInit];
    expect(String(url)).toBe("https://llm.example/v1/chat/completions");
    const sent = JSON.parse(String(init.body)) as { model: string; messages: unknown[]; tools: unknown[]; max_tokens: number };
    expect(sent.model).toBe("gpt-x");
    expect(sent.max_tokens).toBe(1024);
    expect(sent.tools).toHaveLength(1);
    expect(new Headers(init.headers as HeadersInit).get("authorization")).toBe("Bearer sk-test");
  });

  it("answers a non-streaming call with one Messages response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse([
      '{"choices":[{"delta":{"content":"Four euros."},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
    ]), { status: 200 })));
    const res = await post("/v1/messages", { ...ANTHROPIC_REQ, model: "gpt-y", stream: false });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as { content: unknown[]; stop_reason: string; model: string };
    expect(body.content).toEqual([{ type: "text", text: "Four euros." }]);
    expect(body.stop_reason).toBe("end_turn");
    expect(body.model).toBe("gpt-y");
  });

  it("surfaces a provider 401 as an Anthropic authentication_error with the same status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 })));
    const res = await post("/v1/messages", ANTHROPIC_REQ);
    expect(res.status).toBe(401);
    expect(JSON.parse(res.text)).toMatchObject({ type: "error", error: { type: "authentication_error" } });
  });

  it("estimates count_tokens and 404s other routes", async () => {
    const count = await post("/v1/messages/count_tokens", { messages: [{ role: "user", content: "x".repeat(400) }] });
    expect(count.status).toBe(200);
    expect(JSON.parse(count.text).input_tokens).toBeGreaterThan(90);
    const other = await post("/v1/complete", {});
    expect(other.status).toBe(404);
  });
});

describe("config", () => {
  it("reads the mode, target and raw flag from env with per-mode defaults", () => {
    expect(configFromEnv({ LLM_GATEWAY_MODE: "ollama" })).toMatchObject({ mode: "ollama", target: "https://ollama.com", raw: false });
    expect(configFromEnv({ LLM_GATEWAY_MODE: "passthrough", LLM_GATEWAY_PASSTHROUGH_RAW: "1", LLM_GATEWAY_TARGET_URL: "https://api.anthropic.com" })).toMatchObject({ mode: "passthrough", raw: true });
    expect(configFromEnv({})).toMatchObject({ mode: "openai", target: "https://api.openai.com/v1", port: 11434 });
    expect(() => configFromEnv({ LLM_GATEWAY_MODE: "nope" })).toThrow(/LLM_GATEWAY_MODE/);
  });
});

describe("ollama passthrough body rewrites", () => {
  it("relocates images out of tool_result blocks", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "shot" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "A" } }] },
    ] }] };
    expect(relocateToolResultImages(body)).toBe(true);
    const content = body.messages[0].content as Array<Record<string, unknown>>;
    expect(content[0].content).toMatch(/shot\n\[1 image\(s\)/);
    expect(content).toHaveLength(3);
    expect(content[2].type).toBe("image");
  });

  it("substitutes a claude-* model and leaves other bodies untouched", () => {
    process.env.LLM_GATEWAY_DEFAULT_MODEL = "qwen3";
    const out = JSON.parse(rewriteMessagesBody(Buffer.from(JSON.stringify({ model: "claude-haiku-4-5", messages: [] }))).toString());
    expect(out.model).toBe("qwen3");
    const same = Buffer.from("not json");
    expect(rewriteMessagesBody(same)).toBe(same);
    delete process.env.LLM_GATEWAY_DEFAULT_MODEL;
  });
});
