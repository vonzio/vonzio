import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

// Local-fs MCP (CLI `--local-exec`). The agent's file/shell tools run on the
// USER'S machine, not the container. Each tool call here is fanned out over the
// session's WebSocket to the CLI (which executes it against the local project,
// gated by the user) and the result is returned as the MCP tool result. The
// handlers hold no filesystem logic themselves — they're a thin proxy. The
// blocking round-trip lives in the orchestrator's LocalFsBridge (callLocalTool).
// See docs/LOCAL_EXEC.md.

type LocalTool = "local_bash" | "local_read" | "local_write" | "local_edit";

interface LocalFsSession {
  userId: string;
  sessionId: string;
}

export interface LocalFsMcpOptions {
  resolveSession: (token: string) => LocalFsSession | null;
  /** Fan a tool call out to the session's CLI and block for its reply. */
  callLocalTool: (
    sessionId: string,
    tool: LocalTool,
    input: Record<string, unknown>,
  ) => Promise<{ output: string; exit_code?: number }>;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: number | string, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function rpcError(id: number | string, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function toolResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError && { isError: true }) };
}

const LOCAL_FS_INSTRUCTIONS =
  "These tools operate on the USER'S local machine (their current project directory), not this " +
  "container. Use local_bash to run shell commands, local_read to read a file, local_write to " +
  "create/overwrite a file, and local_edit to replace an exact string in a file. All paths are " +
  "relative to the user's project root and confined to it. The user reviews and may reject any " +
  "call, so explain destructive actions first.";

const TOOL_DEFINITIONS = [
  {
    name: "local_bash",
    description:
      "Run a shell command in the user's local project directory. Returns combined stdout/stderr " +
      "and the exit code. Long-running or interactive commands may be killed by the user.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
      },
      required: ["command"],
    },
  },
  {
    name: "local_read",
    description: "Read a file from the user's local project. Returns its contents.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, relative to the project root." },
      },
      required: ["path"],
    },
  },
  {
    name: "local_write",
    description: "Create or overwrite a file in the user's local project with the given contents.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, relative to the project root." },
        content: { type: "string", description: "The full new contents of the file." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "local_edit",
    description:
      "Replace an exact string in a file in the user's local project. old_string must match " +
      "exactly and be unique within the file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, relative to the project root." },
        old_string: { type: "string", description: "The exact text to replace." },
        new_string: { type: "string", description: "The replacement text." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
] as const;

const TOOL_NAMES = new Set<string>(TOOL_DEFINITIONS.map((t) => t.name));

async function localFsMcp(server: FastifyInstance, opts: LocalFsMcpOptions): Promise<void> {
  const { resolveSession, callLocalTool } = opts;

  server.post("/mcp/localfs", async (request, reply) => {
    const body = request.body as JsonRpcRequest;
    const id = body.id ?? 0;

    if (body.jsonrpc !== "2.0" || !body.method) {
      return reply.send(rpcError(id, -32600, "Invalid JSON-RPC request"));
    }

    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) return reply.send(rpcError(id, -32000, "Missing Authorization header"));

    const session = resolveSession(token);
    if (!session) return reply.send(rpcError(id, -32000, "Invalid or expired session token"));

    switch (body.method) {
      case "initialize":
        return reply.send(
          rpcResult(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "vonzio-local-fs", version: "1.0.0" },
            instructions: LOCAL_FS_INSTRUCTIONS,
          }),
        );

      case "notifications/initialized":
        return reply.send(rpcResult(id, {}));

      case "tools/list":
        return reply.send(rpcResult(id, { tools: TOOL_DEFINITIONS }));

      case "tools/call": {
        const params = body.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
        if (!params?.name) return reply.send(rpcError(id, -32602, "Missing tool name in params"));
        if (!TOOL_NAMES.has(params.name)) {
          return reply.send(rpcResult(id, toolResult(`Unknown tool: ${params.name}`, true)));
        }
        try {
          const res = await callLocalTool(
            session.sessionId,
            params.name as LocalTool,
            params.arguments ?? {},
          );
          const suffix = res.exit_code != null && res.exit_code !== 0 ? `\n[exit ${res.exit_code}]` : "";
          return reply.send(rpcResult(id, toolResult(res.output + suffix, res.exit_code != null && res.exit_code !== 0)));
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          server.log.error({ err, tool: params.name }, "Local-fs MCP tool call failed");
          return reply.send(rpcResult(id, toolResult(message, true)));
        }
      }

      default:
        return reply.send(rpcError(id, -32601, `Method not found: ${body.method}`));
    }
  });
}

export const localFsMcpPlugin = fp(localFsMcp, { name: "local-fs-mcp" });
