import { describe, it, expect } from "vitest";
import { anthropicAuthHeaders } from "./anthropic-auth.js";

describe("anthropicAuthHeaders", () => {
  it("uses x-api-key for a normal API key", () => {
    const h = anthropicAuthHeaders("api_key", "sk-ant-api03-abc");
    expect(h["x-api-key"]).toBe("sk-ant-api03-abc");
    expect(h["Authorization"]).toBeUndefined();
    expect(h["anthropic-version"]).toBe("2023-06-01");
  });

  it("uses Authorization: Bearer for a claude_subscription oat token", () => {
    const h = anthropicAuthHeaders("claude_subscription", "sk-ant-oat01-xyz");
    expect(h["Authorization"]).toBe("Bearer sk-ant-oat01-xyz");
    expect(h["x-api-key"]).toBeUndefined();
    expect(h["anthropic-version"]).toBe("2023-06-01");
  });

  it("defaults unknown/undefined providers to x-api-key (never silently Bearer)", () => {
    for (const p of [undefined, "openai", "ollama", "anything"]) {
      const h = anthropicAuthHeaders(p, "secret");
      expect(h["x-api-key"]).toBe("secret");
      expect(h["Authorization"]).toBeUndefined();
    }
  });
});
