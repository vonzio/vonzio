import type { McpRegistry, McpServerSpec } from "@vonzio/plugin-api";
import { isSafeMcpPath } from "../orchestrator/plugin-mcp.js";

/**
 * Process-local registry of plugin-contributed MCP servers. Plugins
 * call `registerServer(spec)` in their `init()`; core's MCP runtime
 * reads `list()` to know what to expose to agents.
 *
 * One spec per name -- a collision means two plugins are trying to
 * publish the same MCP server, which would confuse agents at tool-
 * selection time. Caught at boot via the throw below.
 */
export class McpRegistryImpl implements McpRegistry {
  private specs = new Map<string, McpServerSpec>();

  registerServer(spec: McpServerSpec): void {
    if (!spec.name || typeof spec.name !== "string") {
      throw new Error(`MCP server name must be a non-empty string, got ${JSON.stringify(spec.name)}`);
    }
    if (this.specs.has(spec.name)) {
      throw new Error(
        `MCP server "${spec.name}" already registered. Two plugins cannot publish the same name.`,
      );
    }
    // An http server is injected into agent containers WITH a per-task bearer
    // token core attaches. The url must therefore be an absolute PATH under the
    // internal server (the plugin's own route, e.g. "/plugins/<name>/mcp") — an
    // external/protocol-relative/traversing url would leak that token off-box
    // and bypass the http.outbound allowlist. Reject it at registration.
    if (spec.transport.type === "http" && !isSafeMcpPath(spec.transport.url)) {
      throw new Error(
        `MCP server "${spec.name}" http url must be an absolute path under the internal server ` +
          `(e.g. "/plugins/<name>/mcp"), not ${JSON.stringify(spec.transport.url)}. External URLs ` +
          `are refused: core attaches a per-task token that must never leave the deployment.`,
      );
    }
    this.specs.set(spec.name, spec);
  }

  /** Snapshot for core's MCP runtime to consume at agent-launch time. */
  list(): McpServerSpec[] {
    return [...this.specs.values()];
  }
}
