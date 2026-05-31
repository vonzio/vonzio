import type { McpRegistry, McpServerSpec } from "@vonzio/plugin-api";

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
    this.specs.set(spec.name, spec);
  }

  /** Snapshot for core's MCP runtime to consume at agent-launch time. */
  list(): McpServerSpec[] {
    return [...this.specs.values()];
  }
}
