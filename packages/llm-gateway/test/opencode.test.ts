/**
 * opencode mode: the byok connection carries the OpenCode issuer and org, byok
 * routes each model to its own protocol, and the free tier's 403 is worded.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import http from "node:http";
import { createServer, configFromEnv } from "../src/server.js";
import { connectionFor, turnError, OPENCODE_FREE_TIER } from "../src/byok-handler.js";

describe("connectionFor (opencode)", () => {
  it("builds an OpenCode-issued openai-compatible connection with the org", () => {
    expect(connectionFor({ mode: "opencode", target: "https://opencode.ai/inference/v1", opencodeOrgId: "org_1" }, "tok")).toEqual({
      kind: "openai-compatible",
      baseUrl: "https://opencode.ai/inference/v1",
      auth: "oauth",
      issuer: "opencode",
      orgId: "org_1",
    });
  });

  it("falls back to OpenCode's API root and omits an unknown org", () => {
    const conn = connectionFor({ mode: "opencode", target: "" }, "tok");
    expect(conn.baseUrl).toBe("https://opencode.ai/inference/v1");
    expect(conn).not.toHaveProperty("orgId");
  });

  it("leaves the openai and codex connections alone", () => {
    expect(connectionFor({ mode: "openai", target: "https://llm.example/v1" }, "k")).toEqual({ kind: "openai-compatible", baseUrl: "https://llm.example/v1" });
    expect(connectionFor({ mode: "codex", target: "" }, "k").kind).toBe("chatgpt");
  });
});

describe("configFromEnv (opencode)", () => {
  it("reads the mode, the default API root and the org id", () => {
    expect(configFromEnv({ LLM_GATEWAY_MODE: "opencode", OPENCODE_ORG_ID: "org_9" })).toMatchObject({
      mode: "opencode",
      target: "https://opencode.ai/inference/v1",
      opencodeOrgId: "org_9",
    });
  });
});

describe("turnError", () => {
  it("words OpenCode's free-tier 403 and keeps the status prefix", () => {
    expect(turnError({ mode: "opencode" }, "HTTP 403: Forbidden")).toBe(`HTTP 403: ${OPENCODE_FREE_TIER}`);
    expect(turnError({ mode: "openai" }, "HTTP 403: Forbidden")).toBe("HTTP 403: Forbidden");
    expect(turnError({ mode: "opencode" }, "HTTP 429: slow down")).toBe("HTTP 429: slow down");
    expect(turnError({ mode: "opencode" }, undefined)).toBe("model call failed");
  });
});

describe("opencode mode over HTTP", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    server = createServer({ mode: "opencode", target: "https://opencode.ai/inference/v1", raw: false, port: 0, opencodeOrgId: "org_1" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((r) => server.close(() => r()));
  });

  function post(body: unknown) {
    return new Promise<{ status: number; text: string }>((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request({ host: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json", "x-api-key": "oc-token", "content-length": Buffer.byteLength(data) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end(data);
    });
  }

  const request = (model: string) => ({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 64, stream: false });

  it.each([
    ["claude-sonnet-4-6", "/messages"],
    ["gpt-5.5", "/responses"],
    ["kimi-k2", "/chat/completions"],
  ])("sends %s on its own protocol with the OpenCode headers", async (model, path) => {
    const fetchSpy = vi.fn(async () => new Response("Forbidden", { status: 403 }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await post(request(model));
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [URL | string, RequestInit];
    expect(String(url)).toBe(`https://opencode.ai/inference/v1${path}`);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer oc-token");
    expect(headers.get("x-opencode-org-id")).toBe("org_1");
    // The free tier's 403 reaches the SDK as a permission error in words.
    expect(res.status).toBe(403);
    const body = JSON.parse(res.text) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("permission_error");
    expect(body.error.message).toContain(OPENCODE_FREE_TIER);
  });

  it("runs a Chat Completions model to completion", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const res = await post(request("kimi-k2"));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as { content: Array<{ type: string; text?: string }>; model: string };
    expect(body.model).toBe("kimi-k2");
    expect(body.content[0]).toMatchObject({ type: "text", text: "Hello" });
  });
});
