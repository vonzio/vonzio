import { describe, it, expect, vi, afterEach } from "vitest";
import { validateAnthropicKey } from "./key-validator.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateAnthropicKey — claude_subscription", () => {
  it("authenticates with a Bearer header (not x-api-key)", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const res = await validateAnthropicKey("sk-ant-oat01-tok", "claude_subscription");
    expect(res.valid).toBe(true);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-ant-oat01-tok");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("maps 401 to a re-run-setup-token message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    const res = await validateAnthropicKey("sk-ant-oat01-expired", "claude_subscription");
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/setup-token/);
  });

  it("maps 429 to a subscription-limit message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", { status: 429 })));
    const res = await validateAnthropicKey("sk-ant-oat01-tok", "claude_subscription");
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/subscription limit/i);
  });
});

describe("validateAnthropicKey — api_key", () => {
  it("authenticates with x-api-key and keeps the generic 401 message", async () => {
    const fetchSpy = vi.fn(async () => new Response("no", { status: 401 }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await validateAnthropicKey("sk-ant-api03-bad", "api_key");
    expect(res.valid).toBe(false);
    expect(res.error).toBe("Invalid API key");
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-api03-bad");
    expect(headers["Authorization"]).toBeUndefined();
  });
});
