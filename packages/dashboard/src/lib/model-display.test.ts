import { describe, expect, it } from "vitest";
import { modelChipLabel, providerLabel } from "./model-display.js";

describe("modelChipLabel", () => {
  it("leads with the provider so the same model id on two keys reads differently", () => {
    expect(modelChipLabel({ provider: "opencode", keyName: "My OpenCode account", modelId: "kimi-k3" })).toEqual({
      label: "OpenCode · kimi-k3",
      title: "My OpenCode account · OpenCode · kimi-k3",
    });
    expect(modelChipLabel({ provider: "ollama", keyName: "Ollama", modelId: "kimi-k3" }).label).toBe("Ollama Cloud · kimi-k3");
  });

  it("uses the friendly model name and drops a repeated provider word", () => {
    expect(modelChipLabel({ provider: "claude_subscription", keyName: "Max", modelId: "claude-opus-5-5" })).toEqual({
      label: "Claude · Opus 5.5",
      title: "Max · Claude subscription · Claude Opus 5.5 (claude-opus-5-5)",
    });
    expect(modelChipLabel({ provider: "api_key", modelId: "claude-opus-5-5" }).label).toBe("Anthropic · Claude Opus 5.5");
    expect(modelChipLabel({ provider: "openai_subscription", modelId: "gpt-6.1-sol", modelName: "GPT-6.1-Sol" }).label)
      .toBe("ChatGPT · GPT-6.1-Sol");
  });

  it("falls back to the model alone when the key is unknown", () => {
    expect(modelChipLabel({ modelId: "kimi-k3" })).toEqual({ label: "kimi-k3", title: "kimi-k3" });
    expect(modelChipLabel({ provider: "opencode", modelId: null }).label).toBe("OpenCode · default");
  });
});

describe("providerLabel", () => {
  it("names known kinds like the Keys page and passes unknown ones through", () => {
    expect(providerLabel("ollama")).toBe("Ollama Cloud");
    expect(providerLabel("openai_subscription")).toBe("ChatGPT subscription");
    expect(providerLabel("something_new")).toBe("something_new");
    expect(providerLabel(null)).toBeNull();
  });
});
