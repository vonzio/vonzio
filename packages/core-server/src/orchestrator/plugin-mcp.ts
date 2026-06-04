// Builds the agent-container injection for plugin-contributed MCP servers
// (ctx.mcpRegistry). Pure + side-effect-free so the URL composition + token
// minting are unit-testable without the full task path; the orchestrator wires
// the returned tokens into its per-task token map. See PLUGIN_LOADER_SPEC §10.

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

/**
 * Inject every registered http MCP server unconditionally (the plugin's route
 * does its own per-user filtering). A `url` beginning with `/` is a path under
 * the internal server URL; an absolute url passes through. Each server gets a
 * freshly-minted bearer token; the plugin resolves it via ctx.mcpSessions.
 * stdio specs are skipped (not reachable as a shared http endpoint).
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

  for (const spec of registry.list()) {
    if (spec.transport.type !== "http") continue;
    const token = mintToken();
    tokens.push({ token, identity });
    const url = spec.transport.url.startsWith("/")
      ? `${internalServerUrl}${spec.transport.url}`
      : spec.transport.url;
    servers.push({ name: spec.name, type: "http", url, headers: { Authorization: `Bearer ${token}` } });
  }
  return { servers, tokens };
}
