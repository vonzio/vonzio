import { describe, it, expect } from "vitest";
import { resolveTaskModel, resolveWorkspaceModel } from "./model-resolution.js";

describe("resolveTaskModel", () => {
  const profile = { model: "gpt-5.5", resolved_api_key_id: "key-chatgpt" };

  it("task model wins", () => {
    expect(resolveTaskModel({ model: "x" }, { model_override: "y" }, profile)).toBe("x");
  });

  it("uses the workspace override when its key is the one that resolved", () => {
    const ws = { model_override: "kimi-k2.7-code", api_key_id_override: "key-ollama" };
    expect(resolveTaskModel(null, ws, { ...profile, resolved_api_key_id: "key-ollama" })).toBe("kimi-k2.7-code");
  });

  it("drops the override model when its key fell back to the profile's key", () => {
    const ws = { model_override: "kimi-k2.7-code", api_key_id_override: "key-ollama" };
    expect(resolveTaskModel(null, ws, profile)).toBe("gpt-5.5");
  });

  it("keeps a key-less override (legacy rows) and falls back to the profile model", () => {
    expect(resolveTaskModel(null, { model_override: "gpt-5.4" }, profile)).toBe("gpt-5.4");
    expect(resolveTaskModel(null, { model_override: null }, profile)).toBe("gpt-5.5");
    expect(resolveWorkspaceModel(null, { model: null })).toBeNull();
  });
});
