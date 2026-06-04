// Builds the agent-container injection for plugin-contributed MCP servers
// (ctx.mcpRegistry). Pure + side-effect-free so the URL composition + token
// minting are unit-testable without the full task path; the orchestrator wires
// the returned tokens into its per-task token map.

import type { McpServerSpec } from "@vonzio/plugin-api";

export interface McpSessionIdentity {
  userId: string;
  profileId: string;
  orgId: string | null;
}

export interface InjectedMcpServer {
  name: string;
  type: "http";
  url: string;
  headers: { Authorization: string };
}

export interface PluginMcpInjection {
  /** Server entries to hand the agent runner. */
  servers: InjectedMcpServer[];
  /** Per-task tokens to register + clean up (token -> session identity). */
  tokens: Array<{ token: string; identity: McpSessionIdentity }>;
}

/** A plugin MCP http url must be an absolute PATH under the internal server —
 *  not an external host. Core attaches a per-task bearer token, so a non-path
 *  (absolute, protocol-relative, or traversing) url would exfiltrate that token
 *  and bypass the http.outbound allowlist. `registerServer` rejects these at
 *  registration; this is the defense-in-depth check at injection time. */
export function isSafeMcpPath(url: string): boolean {
  return (
    typeof url === "string" &&
    url.startsWith("/") &&
    !url.startsWith("//") && // protocol-relative → external host
    !url.includes("..") // path traversal out of the plugin namespace
  );
}

/**
 * Inject every registered http MCP server unconditionally (the plugin's route
 * does its own per-user filtering). The spec `url` is a PATH resolved under the
 * internal server URL (see {@link isSafeMcpPath}); anything else is skipped
 * rather than handed a token. Each server gets a freshly-minted bearer token;
 * the plugin resolves it via ctx.mcpSessions. stdio specs are not injected this
 * way (not reachable as a shared http endpoint).
 */
export function buildPluginMcpInjection(
  registry: { list(): McpServerSpec[] } | undefined,
  internalServerUrl: string | undefined,
  identity: McpSessionIdentity,
  mintToken: () => string,
): PluginMcpInjection {
  const servers: InjectedMcpServer[] = [];
  const tokens: PluginMcpInjection["tokens"] = [];
  if (!registry || !internalServerUrl) return { servers, tokens };
  const base = internalServerUrl.replace(/\/+$/, ""); // avoid base// + /path

  for (const spec of registry.list()) {
    if (spec.transport.type !== "http") continue;
    if (!isSafeMcpPath(spec.transport.url)) continue; // never hand the agent a token-bearing external URL
    const token = mintToken();
    tokens.push({ token, identity });
    servers.push({ name: spec.name, type: "http", url: `${base}${spec.transport.url}`, headers: { Authorization: `Bearer ${token}` } });
  }
  return { servers, tokens };
}
