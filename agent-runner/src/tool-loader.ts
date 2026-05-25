import * as vm from "node:vm";
import { createRequire } from "node:module";
import type { ToolFilePayload, McpServerConfig } from "./types.js";

const require = createRequire(import.meta.url);

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

/**
 * Load tool files (either from payload or from /tools/ directory) and return
 * an array of tool definitions ready to be wrapped in createSdkMcpServer.
 */
export function loadToolFiles(toolFiles?: ToolFilePayload[]): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  // Load from payload (uploaded tools sent by server)
  if (toolFiles?.length) {
    for (const tf of toolFiles) {
      try {
        const tool = evaluateToolCode(tf.code, tf.name);
        if (tool) tools.push(tool);
      } catch (err) {
        console.error(`Failed to load tool "${tf.name}":`, err);
      }
    }
  }

  return tools;
}

function evaluateToolCode(code: string, name: string): ToolDefinition | null {
  const exports: Record<string, unknown> = {};
  const moduleObj = { exports };

  try {
    // Create a script that wraps the code in a function, providing CommonJS globals
    const wrapped = `(function(exports, require, module, __filename, __dirname) {\n${code}\n})`;
    const script = new vm.Script(wrapped, { filename: name });
    const fn = script.runInThisContext();
    fn(exports, require, moduleObj, name, "/tools");
  } catch (err) {
    console.error(`Error evaluating tool "${name}":`, err);
    return null;
  }

  const toolExport = moduleObj.exports as Record<string, unknown>;

  // Validate required fields
  if (!toolExport.name || typeof toolExport.name !== "string") {
    console.error(`Tool "${name}" missing required "name" export`);
    return null;
  }
  if (!toolExport.handler || typeof toolExport.handler !== "function") {
    console.error(`Tool "${name}" missing required "handler" function export`);
    return null;
  }

  return {
    name: toolExport.name as string,
    description: (toolExport.description as string) ?? `Tool: ${toolExport.name}`,
    inputSchema: (toolExport.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    handler: toolExport.handler as ToolDefinition["handler"],
  };
}

/**
 * Build the mcpServers config object for the Claude Code SDK query() call.
 * Combines SDK tool files (wrapped via createSdkMcpServer) with stdio/http MCP servers.
 */
export async function buildMcpServers(
  toolFiles?: ToolFilePayload[],
  mcpServers?: McpServerConfig[],
): Promise<Record<string, unknown> | undefined> {
  const result: Record<string, unknown> = {};
  let hasServers = false;

  // Load tool files and wrap them as SDK MCP servers
  const tools = loadToolFiles(toolFiles);
  if (tools.length > 0) {
    try {
      const { createSdkMcpServer, tool: sdkTool } = await import("@anthropic-ai/claude-agent-sdk");

      // Wrap each tool using the SDK's tool() helper with an empty schema.
      // The handler receives the raw args from the model.
      const sdkTools = tools.map((t) =>
        sdkTool(
          t.name,
          t.description,
          {} as any,
          async (args: Record<string, unknown>) => t.handler(args),
        ),
      );

      result["custom-tools"] = createSdkMcpServer({
        name: "custom-tools",
        tools: sdkTools as any,
      });
      hasServers = true;
    } catch (err) {
      console.error("Failed to create SDK MCP server for tools:", err);
    }
  }

  // Add stdio and http MCP servers from config
  if (mcpServers?.length) {
    for (const server of mcpServers) {
      if (server.type === "stdio") {
        result[server.name] = {
          type: "stdio",
          command: server.command,
          args: server.args ?? [],
          env: { ...process.env, ...(server.env ?? {}) },
        };
        hasServers = true;
      } else if (server.type === "http") {
        result[server.name] = {
          type: "http",
          url: server.url,
          headers: server.headers ?? {},
        };
        hasServers = true;
      }
    }
  }

  return hasServers ? result : undefined;
}
