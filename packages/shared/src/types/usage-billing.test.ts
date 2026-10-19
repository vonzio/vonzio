import { describe, expect, it } from "vitest";
import { usageBillingFor } from "./task.js";

describe("usageBillingFor", () => {
  it("meters Anthropic API keys and OpenAI / OpenAI-compatible keys", () => {
    expect(usageBillingFor("api_key")).toBe("metered");
    expect(usageBillingFor("openai")).toBe("metered");
    expect(usageBillingFor(undefined)).toBe("metered");
    expect(usageBillingFor(null)).toBe("metered");
  });

  it("treats subscriptions, Ollama Cloud and unknown kinds as flat-rate", () => {
    for (const p of ["claude_subscription", "openai_subscription", "ollama", "opencode"]) {
      expect(usageBillingFor(p)).toBe("flat");
    }
  });
});
