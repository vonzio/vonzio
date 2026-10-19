import { describe, it, expect, vi, afterEach } from "vitest";
import { connectionFor, describeFailure, completeText } from "./byok-connection.js";

afterEach(() => vi.unstubAllGlobals());

describe("connectionFor", () => {
  it("maps each stored provider to a byok connection", () => {
    expect(connectionFor({ provider: "api_key", api_key: "k" })?.conn).toMatchObject({ kind: "anthropic", auth: "key" });
    expect(connectionFor({ provider: "claude_subscription", api_key: "sk-ant-oat01-x" })?.conn).toMatchObject({ kind: "anthropic", auth: "setup-token" });
    expect(connectionFor({ provider: "claude_subscription", api_key: "access-token" })?.conn).toMatchObject({ kind: "anthropic", auth: "oauth" });
    expect(connectionFor({ provider: "ollama", api_key: "k" })?.conn).toEqual({ kind: "openai-compatible", baseUrl: "https://ollama.com/v1" });
    expect(connectionFor({ provider: "openai", api_key: "k" })?.conn).toEqual({ kind: "openai-compatible", baseUrl: "https://api.openai.com/v1" });
    expect(connectionFor({ provider: "openai", api_key: "k", base_url: "https://openrouter.ai/api/v1/" })?.conn.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(connectionFor({ provider: "openai_subscription", api_key: "a.b.c" })?.conn).toMatchObject({ kind: "chatgpt" });
  });

  it("maps an OpenCode sign-in to OpenCode's API with the issuer and org", () => {
    expect(connectionFor({ provider: "opencode", api_key: "tok", account_id: "org_1" })).toEqual({
      family: "openai",
      credential: "tok",
      conn: { kind: "openai-compatible", baseUrl: "https://opencode.ai/inference/v1", auth: "oauth", issuer: "opencode", orgId: "org_1" },
    });
    expect(connectionFor({ provider: "opencode", api_key: "tok" })?.conn).not.toHaveProperty("orgId");
  });

  it("returns null without a secret", () => {
    expect(connectionFor({ provider: "ollama", api_key: null })).toBeNull();
  });
});

describe("describeFailure", () => {
  it("keeps the subscription guidance on 401/429", () => {
    expect(describeFailure("claude_subscription", new Error("HTTP 401: nope"))).toMatch(/setup-token/);
    expect(describeFailure("claude_subscription", new Error("HTTP 429: slow"))).toMatch(/subscription limit/i);
    expect(describeFailure("api_key", new Error("HTTP 401: nope"))).toBe("Invalid API key");
    expect(describeFailure("api_key", new Error("HTTP 403: nope"))).toMatch(/disabled/);
    expect(describeFailure("openai", new Error("HTTP 401: Incorrect API key"))).toBe("HTTP 401: Incorrect API key");
    expect(describeFailure("openai", new Error("EHOSTUNREACH"))).toBe("EHOSTUNREACH");
  });

  it("words OpenCode's free-tier 403 and an expired session", () => {
    expect(describeFailure("opencode", new Error("HTTP 403: Forbidden"))).toMatch(/free tier only works in OpenCode's own apps; a paid plan is needed/);
    expect(describeFailure("opencode", new Error("HTTP 401: Unauthorized"))).toMatch(/sign in with OpenCode again/);
  });
});

describe("completeText", () => {
  it("runs one Chat Completions turn and returns the text", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Blue "}}]}',
      'data: {"choices":[{"delta":{"content":"mug"},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const fetchSpy = vi.fn(async () => new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const text = await completeText(
      { provider: "ollama", api_key: "k" },
      "qwen3",
      { system: "Be brief.", messages: [{ role: "user", content: "Title?" }], maxTokens: 64 },
    );
    expect(text).toBe("Blue mug");
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [URL | string, RequestInit];
    expect(String(url)).toBe("https://ollama.com/v1/chat/completions");
    const body = JSON.parse(String(init.body)) as { model: string; stream: boolean };
    expect(body.model).toBe("qwen3");
    expect(body.stream).toBe(true);
  });

  it("throws byok's error wording on a failed turn", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })));
    await expect(
      completeText({ provider: "api_key", api_key: "k" }, "claude-haiku-4-5", { system: "", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/401/);
  });
});
