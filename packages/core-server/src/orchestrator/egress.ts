// Egress enforcement helpers (feature 0005). Pure functions + a thin bridge to
// the proxy's token signer, kept separate from the orchestrator so they're unit-
// testable without Docker. See docker/egress-proxy.cjs for the enforcement point
// and the token format.
import { createRequire } from "node:module";

// The proxy runs as a standalone CJS file (no build step). Reuse its token
// signer here so there is exactly ONE token implementation across the proxy,
// its tests, and the orchestrator that mints tokens.
const require = createRequire(import.meta.url);
const { signToken } = require("../../../../docker/egress-proxy.cjs") as {
  signToken: (domains: string[], secret: string, ttlSeconds?: number) => string;
};

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

export { signToken };
