import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import {
  modelHostsFromEnv, modelEndpointsFromEnv, planEgress, buildProxyEnv, signToken, routeModelThroughGateway,
  internalServerHost, DEFAULT_EGRESS_ALLOWLIST, egressBaseline, parseHostList,
} from "./egress.js";

const require = createRequire(import.meta.url);
const proxy = require("../../../../docker/egress-proxy.cjs") as {
  verifyToken: (t: string | null, s: string) => { domains: string[]; models: string[] } | null;
  hostMatches: (host: string, domains: string[]) => boolean;
};

describe("modelHostsFromEnv", () => {
  it("extracts external model hosts and skips localhost gateways", () => {
    const env = {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:11434", // local gateway → skip
      LLM_GATEWAY_TARGET_URL: "https://api.openai.com/v1", // real upstream
    };
    expect(modelHostsFromEnv(env).sort()).toEqual(["api.openai.com"]);
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

  it("adds the ChatGPT backend for codex mode (implicit upstream, no target URL)", () => {
    expect(modelHostsFromEnv({ LLM_GATEWAY_MODE: "codex", ANTHROPIC_BASE_URL: "http://127.0.0.1:11434" })).toEqual(["chatgpt.com"]);
  });

  it("honors an explicit codex target URL host when set", () => {
    expect(modelHostsFromEnv({ LLM_GATEWAY_MODE: "codex", LLM_GATEWAY_TARGET_URL: "https://proxy.example.com/backend-api" }).sort())
      .toEqual(["proxy.example.com"]);
  });

  it("allows opencode.ai for opencode mode, with or without a target URL", () => {
    expect(modelHostsFromEnv({ LLM_GATEWAY_MODE: "opencode", ANTHROPIC_BASE_URL: "http://127.0.0.1:11434" })).toEqual(["opencode.ai"]);
    expect(modelHostsFromEnv({ LLM_GATEWAY_MODE: "opencode", LLM_GATEWAY_TARGET_URL: "https://opencode.ai/inference/v1" })).toEqual(["opencode.ai"]);
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

describe("planEgress with the server baseline", () => {
  it("merges model hosts, baseline and per-agent hosts", () => {
    const plan = planEgress(["internal.example.com"], ["api.openai.com"], ["registry.npmjs.org", "api.openai.com"]);
    expect(plan.mode).toBe("enforce");
    expect(plan.domains.sort()).toEqual(["api.openai.com", "internal.example.com", "registry.npmjs.org"]);
  });

  it("a per-agent '*' still bypasses regardless of the baseline", () => {
    expect(planEgress(["*"], ["api.anthropic.com"], ["github.com"])).toEqual({ mode: "bypass", domains: ["*"] });
  });
});

describe("DEFAULT_EGRESS_ALLOWLIST", () => {
  const allows = (host: string) => proxy.hostMatches(host, [...DEFAULT_EGRESS_ALLOWLIST]);

  it.each([
    // every supported model provider
    "api.anthropic.com", "api.openai.com", "chatgpt.com", "ollama.com", "opencode.ai",
    // git hosts (incl. the subdomains clones / API / raw downloads use)
    "github.com", "api.github.com", "codeload.github.com", "raw.githubusercontent.com",
    "objects.githubusercontent.com", "gitlab.com", "bitbucket.org",
    // package registries
    "registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org",
    "index.crates.io", "static.crates.io", "proxy.golang.org", "sum.golang.org",
    "repo.maven.apache.org", "repo1.maven.org", "plugins.gradle.org", "rubygems.org",
  ])("allows %s", (host) => {
    expect(allows(host)).toBe(true);
  });

  it.each(["example.com", "evil-github.com", "githubusercontent.com.evil.net", "pastebin.com", "169.254.169.254"])(
    "does not allow %s",
    (host) => expect(allows(host)).toBe(false),
  );

  it("never contains a bare '*'", () => {
    expect(DEFAULT_EGRESS_ALLOWLIST).not.toContain("*");
  });
});

describe("egressBaseline", () => {
  it("is the built-in list by default", () => {
    expect(egressBaseline({ builtin: true })).toEqual([...DEFAULT_EGRESS_ALLOWLIST]);
  });

  it("adds operator hosts (normalized, deduped) and drops a bare '*'", () => {
    const b = egressBaseline({ builtin: true, extra: [" Docs.Python.org ", "*", "github.com", ""] });
    expect(b).toContain("docs.python.org");
    expect(b).not.toContain("*");
    expect(b.filter((h) => h === "github.com")).toHaveLength(1);
  });

  it("is only the operator hosts when the built-in list is disabled", () => {
    expect(egressBaseline({ builtin: false, extra: ["a.example.com"] })).toEqual(["a.example.com"]);
    expect(egressBaseline({ builtin: false })).toEqual([]);
  });
});

describe("parseHostList", () => {
  it("splits on commas and whitespace", () => {
    expect(parseHostList("a.com, b.com\nc.com  d.com")).toEqual(["a.com", "b.com", "c.com", "d.com"]);
    expect(parseHostList(undefined)).toEqual([]);
    expect(parseHostList("")).toEqual([]);
  });
});

describe("modelEndpointsFromEnv", () => {
  it("returns exact host:port pairs with the scheme's default port", () => {
    expect(modelEndpointsFromEnv({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:11434",
      LLM_GATEWAY_TARGET_URL: "https://api.openai.com/v1",
    })).toEqual(["api.openai.com:443"]);
    expect(modelEndpointsFromEnv({ LLM_GATEWAY_TARGET_URL: "http://mock-llm:8080" })).toEqual(["mock-llm:8080"]);
    expect(modelEndpointsFromEnv({ LLM_GATEWAY_TARGET_URL: "http://192.168.1.20" })).toEqual(["192.168.1.20:80"]);
  });

  it("covers the implicit codex upstream", () => {
    expect(modelEndpointsFromEnv({ LLM_GATEWAY_MODE: "codex" })).toEqual(["chatgpt.com:443"]);
  });

  it("skips localhost and non-http URLs", () => {
    expect(modelEndpointsFromEnv({ LLM_GATEWAY_TARGET_URL: "http://localhost:1234" })).toEqual([]);
    expect(modelEndpointsFromEnv({ LLM_GATEWAY_TARGET_URL: "ftp://x.example.com" })).toEqual([]);
    expect(modelEndpointsFromEnv({})).toEqual([]);
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

  it("leaves an Ollama agent untouched (its gateway mode is itself proxy-aware)", () => {
    const env: Record<string, string> = {
      LLM_GATEWAY_MODE: "ollama",
      LLM_GATEWAY_TARGET_URL: "https://ollama.com",
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

  it("carries the model endpoints in the token for the proxy", () => {
    const env = buildProxyEnv({
      domains: ["mock-llm"],
      secret: "s3cret",
      proxyAlias: "egress-proxy",
      proxyPort: 8080,
      modelEndpoints: ["mock-llm:8080"],
    });
    const token = decodeURIComponent(new URL(env.HTTPS_PROXY).username);
    expect(proxy.verifyToken(token, "s3cret")?.models).toEqual(["mock-llm:8080"]);
  });

  it("excludes extra noProxyHosts so internal MCP calls bypass the proxy", () => {
    const env = buildProxyEnv({
      domains: ["api.anthropic.com"],
      secret: "s3cret",
      proxyAlias: "egress-proxy",
      proxyPort: 8080,
      noProxyHosts: ["server"],
    });
    expect(env.NO_PROXY.split(",")).toContain("server");
    expect(env.NO_PROXY).toBe(env.no_proxy);
  });
});

describe("internalServerHost", () => {
  it("extracts the hostname from the internal server URL", () => {
    expect(internalServerHost("http://server:3000")).toEqual(["server"]);
  });
  it("returns [] when unset or unparseable", () => {
    expect(internalServerHost(undefined)).toEqual([]);
    expect(internalServerHost("not a url")).toEqual([]);
  });
});
