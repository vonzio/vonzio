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

export function signToken(domains: string[], secret: string, ttlSeconds?: number): string {
  const claims: { d: string[]; exp?: number } = { d: domains };
  if (ttlSeconds && ttlSeconds > 0) {
    claims.exp = Math.floor(Date.now() / 1000) + Math.floor(ttlSeconds);
  }
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = b64url(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

/** Env keys whose values are model-endpoint URLs the agent must always reach. */
const MODEL_URL_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "LLM_GATEWAY_TARGET_URL",
  "OLLAMA_TARGET_URL",
] as const;

/** Hosts that live inside the container (the in-container gateway) — never an
 *  external egress destination, so they're not added to the allowlist. */
function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
}

/**
 * Extract the external model hostnames implied by an agent's env. Localhost
 * gateway endpoints are skipped (their upstream — LLM_GATEWAY_TARGET_URL /
 * OLLAMA_TARGET_URL — is the real external host and is itself in the list).
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
  return [...hosts];
}

/**
 * Native-Anthropic agents talk to api.anthropic.com directly from the SDK, which
 * ignores proxy env — so under enforcement they'd have no route. Redirect them
 * through the in-container llm-gateway (raw passthrough, preserving x-api-key) so
 * the single proxy-aware component carries the model traffic. Mutates `env`.
 *
 * No-op when the model already goes through an in-container, proxy-aware gateway:
 *  - OpenAI(-compatible): sets LLM_GATEWAY_MODE.
 *  - Ollama: sets OLLAMA_TARGET_URL (ollama-proxy.cjs is itself proxy-aware).
 * Forcing those would race a second gateway on :11434 and pollute the allowlist.
 */
export function routeModelThroughGateway(env: Record<string, string>): void {
  if (env.LLM_GATEWAY_MODE || env.OLLAMA_TARGET_URL) return;
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
 * reach the model endpoint(s) plus whatever the profile/task allowlisted — and
 * NOTHING else (fail-closed; an empty allowlist ⇒ model only).
 */
export function planEgress(
  taskEgress: string[] | undefined,
  modelHosts: string[],
): EgressPlan {
  const egress = taskEgress ?? [];
  if (egress.includes("*")) return { mode: "bypass", domains: ["*"] };
  return { mode: "enforce", domains: [...new Set([...modelHosts, ...egress])] };
}

/**
 * Build the env that points an agent at the egress proxy. The signed token
 * carries the allowlist; localhost is excluded so the SDK→gateway hop stays
 * direct. `ttlSeconds` bounds token replay if it leaks.
 */
export function buildProxyEnv(opts: {
  domains: string[];
  secret: string;
  proxyAlias: string;
  proxyPort: number;
  ttlSeconds?: number;
}): Record<string, string> {
  const token = signToken(opts.domains, opts.secret, opts.ttlSeconds);
  const url = `http://${token}:@${opts.proxyAlias}:${opts.proxyPort}`;
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
  };
}
