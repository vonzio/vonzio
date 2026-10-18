import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_DEFAULT_MODEL, NO_MODEL_MESSAGE, NoModelError, defaultModelForProvider, isAnthropicProvider } from "./default-model.js";
import { CODEX_MODELS } from "../services/codex-oauth-service.js";

describe("isAnthropicProvider", () => {
  it("treats api_key, claude_subscription and an unset provider as Anthropic", () => {
    expect(isAnthropicProvider("api_key")).toBe(true);
    expect(isAnthropicProvider("claude_subscription")).toBe(true);
    expect(isAnthropicProvider(undefined)).toBe(true);
    expect(isAnthropicProvider(null)).toBe(true);
  });

  it("treats the gateway providers as non-Anthropic", () => {
    for (const p of ["ollama", "openai", "openai_subscription"]) expect(isAnthropicProvider(p)).toBe(false);
  });
});

describe("defaultModelForProvider", () => {
  afterEach(() => {
    delete process.env.CODEX_MODELS;
  });

  it("returns the Claude default for Anthropic kinds without listing", async () => {
    const lister = vi.fn(async () => "something-else");
    expect(await defaultModelForProvider("api_key", lister)).toBe(CLAUDE_DEFAULT_MODEL);
    expect(await defaultModelForProvider("claude_subscription", lister)).toBe(CLAUDE_DEFAULT_MODEL);
    expect(lister).not.toHaveBeenCalled();
  });

  it("returns the first catalog model for other providers", async () => {
    expect(await defaultModelForProvider("ollama", async () => "kimi-k2")).toBe("kimi-k2");
    expect(await defaultModelForProvider("openai", async () => "gpt-4.1")).toBe("gpt-4.1");
    expect(await defaultModelForProvider("openai_subscription", async () => "gpt-5.5")).toBe("gpt-5.5");
  });

  it("falls back to the Codex list for a ChatGPT subscription when the catalog is empty or fails", async () => {
    expect(await defaultModelForProvider("openai_subscription", async () => null)).toBe(CODEX_MODELS[0]);
    expect(await defaultModelForProvider("openai_subscription", async () => { throw new Error("down"); })).toBe(CODEX_MODELS[0]);
    process.env.CODEX_MODELS = "gpt-pinned";
    expect(await defaultModelForProvider("openai_subscription")).toBe("gpt-pinned");
  });

  it("returns null (never a Claude id) when nothing can be determined", async () => {
    expect(await defaultModelForProvider("ollama", async () => null)).toBeNull();
    expect(await defaultModelForProvider("openai", async () => { throw new Error("401"); })).toBeNull();
    expect(await defaultModelForProvider("openai")).toBeNull();
  });
});

describe("NoModelError", () => {
  it("carries the user-facing message", () => {
    const e = new NoModelError();
    expect(e.message).toBe(NO_MODEL_MESSAGE);
    expect(e.message).toMatch(/Pick a model for this agent in Settings/);
  });
});
