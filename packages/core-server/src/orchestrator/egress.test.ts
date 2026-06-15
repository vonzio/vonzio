import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { modelHostsFromEnv, planEgress, buildProxyEnv, signToken, routeModelThroughGateway } from "./egress.js";

const require = createRequire(import.meta.url);
const proxy = require("../../../../docker/egress-proxy.cjs") as {
  verifyToken: (t: string | null, s: string) => { domains: string[] } | null;
};

describe("modelHostsFromEnv", () => {
  it("extracts external model hosts and skips localhost gateways", () => {
    const env = {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:11434", // local gateway → skip
      LLM_GATEWAY_TARGET_URL: "https://api.openai.com/v1", // real upstream
      OLLAMA_TARGET_URL: "https://ollama.example.com",
    };
    expect(modelHostsFromEnv(env).sort()).toEqual(["api.openai.com", "ollama.example.com"]);
  });

  it("returns the native Anthropic host when ANTHROPIC_BASE_URL is external", () => {
    expect(modelHostsFromEnv({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" })).toEqual(["api.anthropic.com"]);
  });

  it("is empty when no model URLs are set", () => {
    expect(modelHostsFromEnv({})).toEqual([]);
  });

  it("ignores non-URL values", () => {
    expect(modelHostsFromEnv({ LLM_GATEWAY_TARGET_URL: "not a url" })).toEqual([]);
  });
});

describe("planEgress", () => {
  it("bypasses when the allowlist contains '*'", () => {
    expect(planEgress(["*"], ["api.anthropic.com"])).toEqual({ mode: "bypass", domains: ["*"] });
  });

  it("enforces model-only for an empty allowlist", () => {
    expect(planEgress(undefined, ["api.anthropic.com"])).toEqual({
      mode: "enforce",
      domains: ["api.anthropic.com"],
    });
  });

  it("unions model hosts with the task/profile allowlist (deduped)", () => {
    const plan = planEgress(["api.github.com", "api.anthropic.com"], ["api.anthropic.com"]);
    expect(plan.mode).toBe("enforce");
    expect(plan.domains.sort()).toEqual(["api.anthropic.com", "api.github.com"]);
  });
});

describe("routeModelThroughGateway", () => {
  it("redirects a native-Anthropic agent through the gateway (raw passthrough)", () => {
    const env: Record<string, string> = { ANTHROPIC_API_KEY: "sk-..." };
    routeModelThroughGateway(env);
    expect(env.LLM_GATEWAY_MODE).toBe("passthrough");
    expect(env.LLM_GATEWAY_PASSTHROUGH_RAW).toBe("1");
    expect(env.LLM_GATEWAY_TARGET_URL).toBe("https://api.anthropic.com");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:11434");
    // and the model host is now derivable for the allowlist
    expect(modelHostsFromEnv(env)).toEqual(["api.anthropic.com"]);
  });

  it("preserves a custom external ANTHROPIC_BASE_URL as the gateway target", () => {
    const env: Record<string, string> = { ANTHROPIC_BASE_URL: "https://anthropic.example.com" };
    routeModelThroughGateway(env);
    expect(env.LLM_GATEWAY_TARGET_URL).toBe("https://anthropic.example.com");
    expect(modelHostsFromEnv(env)).toEqual(["anthropic.example.com"]);
  });

  it("leaves an OpenAI-compatible agent untouched (already gatewayed)", () => {
    const env: Record<string, string> = {
      LLM_GATEWAY_MODE: "openai",
      LLM_GATEWAY_TARGET_URL: "https://api.openai.com",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:11434",
    };
    const before = { ...env };
    routeModelThroughGateway(env);
    expect(env).toEqual(before);
  });

  it("leaves an Ollama agent untouched (ollama-proxy is itself proxy-aware)", () => {
    const env: Record<string, string> = {
      OLLAMA_TARGET_URL: "https://ollama.com",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:11434",
    };
    const before = { ...env };
    routeModelThroughGateway(env);
    // must NOT set LLM_GATEWAY_MODE (would race a 2nd gateway on :11434) and must
    // NOT pollute the allowlist with api.anthropic.com
    expect(env).toEqual(before);
    expect(modelHostsFromEnv(env)).toEqual(["ollama.com"]);
  });
});

describe("buildProxyEnv", () => {
  it("emits a signed-token proxy URL and keeps localhost direct", () => {
    const env = buildProxyEnv({
      domains: ["api.anthropic.com"],
      secret: "s3cret",
      proxyAlias: "egress-proxy",
      proxyPort: 8080,
      ttlSeconds: 3600,
    });
    expect(env.HTTP_PROXY).toBe(env.HTTPS_PROXY);
    expect(env.NO_PROXY).toContain("localhost");
    // userinfo (the token) must verify against the same secret + carry the allowlist
    const url = new URL(env.HTTPS_PROXY);
    expect(url.hostname).toBe("egress-proxy");
    expect(url.port).toBe("8080");
    const token = decodeURIComponent(url.username);
    // round-trips through the proxy's own verifier (same impl)
    expect(proxy.verifyToken(token, "s3cret")?.domains).toEqual(["api.anthropic.com"]);
    expect(proxy.verifyToken(token, "wrong")).toBeNull();
  });

  it("re-exports the proxy's signer (single token implementation)", () => {
    const t = signToken(["x.com"], "k");
    expect(proxy.verifyToken(t, "k")?.domains).toEqual(["x.com"]);
  });
});
