// Egress enforcement helpers (feature 0005). Pure functions, kept separate from
// the orchestrator so they're unit-testable without Docker. See
// docker/egress-proxy.cjs for the enforcement point and the token format.
import { createHmac } from "node:crypto";

// Mint the per-agent proxy token. MUST stay byte-compatible with the verifier in
// docker/egress-proxy.cjs (verifyToken) — egress.test.ts round-trips a token
// minted here through that verifier to guard the two against drift. (We can't
// import the .cjs at runtime: docker/ isn't shipped inside the server image.)
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function signToken(domains: string[], secret: string, ttlSeconds?: number, modelEndpoints?: string[]): string {
  const claims: { d: string[]; m?: string[]; exp?: number } = { d: domains };
  if (modelEndpoints?.length) claims.m = modelEndpoints;
  if (ttlSeconds && ttlSeconds > 0) {
    claims.exp = Math.floor(Date.now() / 1000) + Math.floor(ttlSeconds);
  }
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = b64url(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

/**
 * Hosts every enforced agent may reach out of the box (each entry also allows
 * its subdomains — see hostMatches in docker/egress-proxy.cjs). Covers every
 * supported model provider (so switching an agent's provider mid-session still
 * works with the token baked into its container) plus the package registries
 * and git hosts typical coding tasks need. Operators extend it with
 * EGRESS_ALLOWED_HOSTS or drop it with EGRESS_BUILTIN_ALLOWLIST=false.
 */
export const DEFAULT_EGRESS_ALLOWLIST: readonly string[] = [
  // Model providers
  "api.anthropic.com",
  "api.openai.com",
  "chatgpt.com", // ChatGPT subscription (Codex backend-api)
  "ollama.com", // Ollama Cloud
  "opencode.ai", // OpenCode Zen
  // Git hosts
  "github.com", // + api., codeload., uploads.
  "githubusercontent.com", // raw., objects., release assets
  "gitlab.com",
  "bitbucket.org",
  // JavaScript
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  // Python
  "pypi.org",
  "files.pythonhosted.org",
  // Rust
  "crates.io", // + index., static.
  // Go
  "proxy.golang.org",
  "sum.golang.org",
  // Java / JVM
  "repo.maven.apache.org",
  "repo1.maven.org",
  "plugins.gradle.org",
  // Ruby
  "rubygems.org",
];

/**
 * The server-wide baseline merged into every enforced agent's allowlist:
 * the built-in list (unless disabled) plus the operator's extra hosts. A bare
 * "*" is dropped — the opt-out for enforcement is EGRESS_ENFORCEMENT=0, and a
 * per-agent "*" is the per-agent bypass; a stray "*" here must not silently
 * open every agent.
 */
export function egressBaseline(opts: { builtin: boolean; extra?: string[] }): string[] {
  const extra = (opts.extra ?? [])
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h && h !== "*");
  return [...new Set([...(opts.builtin ? DEFAULT_EGRESS_ALLOWLIST : []), ...extra])];
}

/** Parse a comma/whitespace-separated host list (EGRESS_ALLOWED_HOSTS). */
export function parseHostList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);
}

/** Env keys whose values are model-endpoint URLs the agent must always reach. */
const MODEL_URL_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "LLM_GATEWAY_TARGET_URL",
] as const;

/** Hosts that live inside the container (the in-container gateway) — never an
 *  external egress destination, so they're not added to the allowlist. */
function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
}

/**
 * Extract the external model hostnames implied by an agent's env. Localhost
 * gateway endpoints are skipped (their upstream — LLM_GATEWAY_TARGET_URL — is
 * the real external host and is itself in the list).
 */
export function modelHostsFromEnv(env: Record<string, string>): string[] {
  const hosts = new Set<string>();
  for (const key of MODEL_URL_ENV_KEYS) {
    const val = env[key];
    if (!val) continue;
    try {
      const host = new URL(val).hostname;
      if (host && !isLocalHost(host)) hosts.add(host);
    } catch { /* not a URL — ignore */ }
  }
  // Codex mode's upstream is implicit (the gateway defaults to the ChatGPT
  // backend rather than reading LLM_GATEWAY_TARGET_URL), so it isn't captured
  // by the URL scan above — add it explicitly or enforcement would block it.
  if (env.LLM_GATEWAY_MODE === "codex") {
    const codexHost = env.LLM_GATEWAY_TARGET_URL ? safeHost(env.LLM_GATEWAY_TARGET_URL) : "chatgpt.com";
    if (codexHost) hosts.add(codexHost);
  }
  // OpenCode: the API root is in LLM_GATEWAY_TARGET_URL (captured above); the
  // gateway also defaults to opencode.ai when it is unset, so allow it either way.
  if (env.LLM_GATEWAY_MODE === "opencode") hosts.add("opencode.ai");
  return [...hosts];
}

/**
 * The agent's model endpoints as exact "host:port" pairs. The proxy lets these
 * through on any port and to private addresses (a LAN / self-hosted
 * OpenAI-compatible or Ollama server the operator configured), never to
 * link-local/metadata or loopback. Same sources as modelHostsFromEnv.
 */
export function modelEndpointsFromEnv(env: Record<string, string>): string[] {
  const out = new Set<string>();
  const add = (val: string | undefined) => {
    if (!val) return;
    try {
      const u = new URL(val);
      if (!u.hostname || isLocalHost(u.hostname)) return;
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
      const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
      out.add(`${u.hostname.toLowerCase()}:${port}`);
    } catch { /* not a URL — ignore */ }
  };
  for (const key of MODEL_URL_ENV_KEYS) add(env[key]);
  if (env.LLM_GATEWAY_MODE === "codex" && !env.LLM_GATEWAY_TARGET_URL) out.add("chatgpt.com:443");
  return [...out];
}

function safeHost(url: string): string | null {
  try { return new URL(url).hostname; } catch { return null; }
}

/**
 * Native-Anthropic agents talk to api.anthropic.com directly from the SDK, which
 * ignores proxy env — so under enforcement they'd have no route. Redirect them
 * through the in-container llm-gateway (raw passthrough, preserving x-api-key) so
 * the single proxy-aware component carries the model traffic. Mutates `env`.
 *
 * No-op when the model already goes through the in-container, proxy-aware
 * gateway (every non-native provider sets LLM_GATEWAY_MODE: openai, codex,
 * opencode, ollama). Forcing those would restart the gateway in the wrong mode and
 * pollute the allowlist.
 */
export function routeModelThroughGateway(env: Record<string, string>): void {
  if (env.LLM_GATEWAY_MODE) return;
  const base = env.ANTHROPIC_BASE_URL;
  // Already pointed at a localhost gateway — leave it.
  if (base && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(base)) return;
  env.LLM_GATEWAY_MODE = "passthrough";
  env.LLM_GATEWAY_PASSTHROUGH_RAW = "1";
  env.LLM_GATEWAY_TARGET_URL = base || "https://api.anthropic.com";
  env.ANTHROPIC_BASE_URL = "http://127.0.0.1:11434";
}

export interface EgressPlan {
  /** "bypass" = profile opted into unrestricted egress (["*"]) → no proxy. */
  mode: "bypass" | "enforce";
  /** The hostnames the proxy will permit (model hosts ∪ task/profile egress). */
  domains: string[];
}

/**
 * Decide what the proxy should allow for a task. `["*"]` anywhere in the
 * resolved allowlist is an explicit opt-out (bypass). Otherwise the agent may
 * reach the model endpoint(s), the server baseline (DEFAULT_EGRESS_ALLOWLIST +
 * EGRESS_ALLOWED_HOSTS) and whatever the profile/task allowlisted — and
 * NOTHING else (fail-closed).
 */
export function planEgress(
  taskEgress: string[] | undefined,
  modelHosts: string[],
  baseline: string[] = [],
): EgressPlan {
  const egress = taskEgress ?? [];
  if (egress.includes("*")) return { mode: "bypass", domains: ["*"] };
  return { mode: "enforce", domains: [...new Set([...modelHosts, ...baseline, ...egress])] };
}

/**
 * Hostname(s) of the internal server URL, for exclusion from the egress proxy.
 * Returns [] when no URL is configured (OSS without the internal MCP wiring).
 */
export function internalServerHost(internalServerUrl?: string): string[] {
  if (!internalServerUrl) return [];
  try {
    return [new URL(internalServerUrl).hostname];
  } catch {
    return [];
  }
}

/**
 * Build the env that points an agent at the egress proxy. The signed token
 * carries the allowlist; localhost is excluded so the SDK→gateway hop stays
 * direct. `ttlSeconds` bounds token replay if it leaks.
 *
 * `noProxyHosts` are extra hosts excluded from the proxy — pass the internal
 * server host so the agent's calls to the in-cluster MCP endpoints
 * (`http://server:3000/mcp/*`) hit it DIRECTLY instead of being routed through
 * the egress proxy, whose deny-by-default allowlist would block the internal
 * host and leave every built-in MCP server stuck "connecting".
 */
export function buildProxyEnv(opts: {
  domains: string[];
  secret: string;
  proxyAlias: string;
  proxyPort: number;
  ttlSeconds?: number;
  noProxyHosts?: string[];
  /** Exact host:port model endpoints (see modelEndpointsFromEnv). */
  modelEndpoints?: string[];
}): Record<string, string> {
  const token = signToken(opts.domains, opts.secret, opts.ttlSeconds, opts.modelEndpoints);
  const url = `http://${token}:@${opts.proxyAlias}:${opts.proxyPort}`;
  const noProxy = ["localhost", "127.0.0.1", "::1", ...(opts.noProxyHosts ?? [])].join(",");
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}
