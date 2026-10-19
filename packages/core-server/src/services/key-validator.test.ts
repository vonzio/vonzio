import { describe, it, expect, vi, afterEach } from "vitest";
import { validateAnthropicKey } from "./key-validator.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const headerOf = (init: RequestInit | undefined, name: string) =>
  new Headers(init?.headers as HeadersInit | undefined).get(name);

describe("validateAnthropicKey — claude_subscription", () => {
  it("authenticates with a Bearer header (not x-api-key)", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const res = await validateAnthropicKey("sk-ant-oat01-tok", "claude_subscription");
    expect(res.valid).toBe(true);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(headerOf(init, "authorization")).toBe("Bearer sk-ant-oat01-tok");
    expect(headerOf(init, "x-api-key")).toBeNull();
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
    expect(headerOf(init, "x-api-key")).toBe("sk-ant-api03-bad");
    expect(headerOf(init, "authorization")).toBeNull();
  });
});

describe("validateAnthropicKey — ollama / openai", () => {
  it("validates an Ollama key against an endpoint that requires it", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ purchased: { balance_usd: 1 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await validateAnthropicKey("ok", "ollama")).toEqual({ valid: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://ollama.com/api/balance");
    expect(headerOf(init, "authorization")).toBe("Bearer ok");
  });

  it("rejects a bad Ollama key even though the model list is public", async () => {
    // ollama.com answers /v1/models with 200 for anyone; only the balance call checks the key.
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) =>
      String(url).endsWith("/api/balance")
        ? new Response(JSON.stringify({ error: "invalid credentials" }), { status: 401 })
        : new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 })));
    expect(await validateAnthropicKey("junkjunkjunkjunkjunk-real", "ollama")).toEqual({ valid: false, error: "Invalid API key" });
  });

  it("falls back to listing models when the root has no balance endpoint", async () => {
    const fetchSpy = vi.fn(async (url: string | URL) =>
      String(url).endsWith("/api/balance")
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await validateAnthropicKey("ok", "ollama")).toEqual({ valid: true });
    expect(String((fetchSpy.mock.calls[1] as unknown as [URL | string])[0])).toBe("https://ollama.com/v1/models");
  });

  it("reports an Ollama outage in words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    expect(await validateAnthropicKey("ok", "ollama")).toEqual({ valid: false, error: "HTTP 503: down" });
  });

  it("reports the provider's own 401 wording for an OpenAI-compatible key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 })));
    const res = await validateAnthropicKey("bad", "openai");
    expect(res.valid).toBe(false);
    expect(res.error).toBe("HTTP 401: Incorrect API key");
  });

  it("reports a timeout instead of hanging", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    vi.useFakeTimers();
    try {
      const pending = validateAnthropicKey("k", "api_key");
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await pending).toEqual({ valid: false, error: "Provider unreachable (timeout)" });
    } finally {
      vi.useRealTimers();
    }
  });
});
