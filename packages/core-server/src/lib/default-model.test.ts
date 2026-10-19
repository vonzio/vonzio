import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_DEFAULT_MODEL,
  DEFAULT_MODEL_PREFERENCES,
  NO_MODEL_MESSAGE,
  NoModelError,
  defaultModelForProvider,
  isAnthropicProvider,
  isOpencodeFreeModel,
  modelPreferences,
  runnableModels,
  pickDefaultModel,
} from "./default-model.js";
import { CODEX_MODELS } from "../services/codex-oauth-service.js";

describe("isAnthropicProvider", () => {
  it("treats api_key, claude_subscription and an unset provider as Anthropic", () => {
    expect(isAnthropicProvider("api_key")).toBe(true);
    expect(isAnthropicProvider("claude_subscription")).toBe(true);
    expect(isAnthropicProvider(undefined)).toBe(true);
    expect(isAnthropicProvider(null)).toBe(true);
  });

  it("treats the gateway providers as non-Anthropic", () => {
    for (const p of ["ollama", "openai", "openai_subscription", "opencode"]) expect(isAnthropicProvider(p)).toBe(false);
  });
});

describe("preference lists", () => {
  it("match the decided order per provider kind", () => {
    const claude = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5", "claude-fable-5-1"];
    const gpt = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6.1-sol", "gpt-6-astra"];
    expect(modelPreferences("api_key")).toEqual(claude);
    expect(modelPreferences("claude_subscription")).toEqual(claude);
    expect(modelPreferences(null)).toEqual(claude);
    expect(modelPreferences("openai")).toEqual(gpt);
    expect(modelPreferences("openai_subscription")).toEqual(gpt);
    expect(modelPreferences("ollama")).toEqual(["kimi-k3", "glm-5.3-flash"]);
    expect(modelPreferences("some_new_kind")).toEqual([]);
    expect(CLAUDE_DEFAULT_MODEL).toBe("claude-opus-5-5");
  });

  it("keeps the static ChatGPT fallback list in sync with the preferences", () => {
    expect([...CODEX_MODELS]).toEqual([...DEFAULT_MODEL_PREFERENCES.openai_subscription]);
  });
});

describe("pickDefaultModel", () => {
  it("picks the first preference present in the catalog, not the first listed", () => {
    expect(pickDefaultModel("ollama", ["beam", "deepseek-v4", "glm-5.3-flash", "kimi-k3"])).toBe("kimi-k3");
    expect(pickDefaultModel("ollama", ["beam", "glm-5.3-flash"])).toBe("glm-5.3-flash");
    expect(pickDefaultModel("openai_subscription", ["gpt-5.5", "gpt-6-astra", "gpt-5.6-luna"])).toBe("gpt-5.6-luna");
    expect(pickDefaultModel("openai", ["gpt-4.1", "gpt-5.6-terra"])).toBe("gpt-5.6-terra");
    expect(pickDefaultModel("claude_subscription", ["claude-haiku-5-5", "claude-sonnet-5-5"])).toBe("claude-sonnet-5-5");
  });

  it("compares ids case-insensitively and returns the catalog's spelling", () => {
    expect(pickDefaultModel("ollama", ["Beam", "Kimi-K3"])).toBe("Kimi-K3");
  });

  it("falls back to the first preference when the catalog is unavailable or empty", () => {
    expect(pickDefaultModel("api_key", null)).toBe("claude-opus-5-5");
    expect(pickDefaultModel("claude_subscription", [])).toBe("claude-opus-5-5");
    expect(pickDefaultModel("openai_subscription", null)).toBe("gpt-5.6-sol");
    expect(pickDefaultModel("openai", undefined)).toBe("gpt-5.6-sol");
    expect(pickDefaultModel("ollama", null)).toBe("kimi-k3");
  });

  it("falls back to the first listed model when no preference is listed", () => {
    expect(pickDefaultModel("ollama", ["beam", "llama4"])).toBe("beam");
    expect(pickDefaultModel("openai", ["mistral-large", "gpt-4.1"])).toBe("mistral-large");
  });

  it("prefers a listed claude-* model on Anthropic kinds when no preference is listed", () => {
    expect(pickDefaultModel("api_key", ["other-model", "claude-haiku-5-5", "claude-opus-4-8"])).toBe("claude-haiku-5-5");
    expect(pickDefaultModel("api_key", ["other-model"])).toBe("other-model");
  });

  it("handles a provider kind without preferences", () => {
    expect(pickDefaultModel("some_new_kind", ["b-model", "a-model"])).toBe("b-model");
    expect(pickDefaultModel("some_new_kind", null)).toBeNull();
  });
});

describe("defaultModelForProvider", () => {
  it("resolves against the listed catalog", async () => {
    const lister = vi.fn(async () => ["beam", "kimi-k3"]);
    expect(await defaultModelForProvider("ollama", lister)).toBe("kimi-k3");
    expect(lister).toHaveBeenCalledOnce();
  });

  it("treats a failing or missing lister as an unavailable catalog", async () => {
    expect(await defaultModelForProvider("openai_subscription", async () => { throw new Error("down"); })).toBe("gpt-5.6-sol");
    expect(await defaultModelForProvider("api_key")).toBe("claude-opus-5-5");
    expect(await defaultModelForProvider("ollama", async () => null)).toBe("kimi-k3");
    expect(await defaultModelForProvider("some_new_kind", async () => null)).toBeNull();
  });
});

describe("NoModelError", () => {
  it("carries the user-facing message", () => {
    const e = new NoModelError();
    expect(e.message).toBe(NO_MODEL_MESSAGE);
    expect(e.message).toMatch(/Pick a model for this agent in Settings/);
  });
});

describe("OpenCode free tier", () => {
  const listed = ["big-pickle", "beam-free", "glm-5.3-flash-free", "test", "claude-opus-5-5", "kimi-k3", "glm-5.3-flash"];

  it("recognises free-tier ids", () => {
    for (const id of ["big-pickle", "beam-free", "Glm-5.3-Flash-FREE"]) expect(isOpencodeFreeModel(id)).toBe(true);
    for (const id of ["kimi-k3", "glm-5.3-flash", "freedom-1"]) expect(isOpencodeFreeModel(id)).toBe(false);
  });

  it("drops them from an OpenCode catalog only", () => {
    expect(runnableModels("opencode", listed, (id) => id)).toEqual(["test", "claude-opus-5-5", "kimi-k3", "glm-5.3-flash"]);
    expect(runnableModels("ollama", listed, (id) => id)).toEqual(listed);
  });

  it("never defaults to a free-tier model", () => {
    expect(pickDefaultModel("opencode", listed)).toBe("kimi-k3");
    expect(pickDefaultModel("opencode", ["big-pickle", "beam-free", "jev-1.13"])).toBe("jev-1.13");
    expect(pickDefaultModel("opencode", null)).toBe("kimi-k3");
    expect(pickDefaultModel("opencode", ["big-pickle"])).toBe("kimi-k3");
  });
});
