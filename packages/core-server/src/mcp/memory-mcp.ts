import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { MemoryService } from "../services/memory-service.js";
import type { Memory, MemoryType } from "@vonzio/shared";
import { MEMORY_TYPES } from "@vonzio/shared";

interface MemoryMcpSession {
  userId: string;
  profileId: string;
  /** SaaS tenant scope — null on OSS / when the workspace pre-dates the
   *  v9 backfill. Passed into every memoryService call so cross-tenant
   *  reads/writes are SQL-blocked even when the user_id collides. */
  orgId: string | null;
}

export interface MemoryMcpOptions {
  memoryService: MemoryService;
  resolveSession: (token: string) => MemoryMcpSession | null;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

function rpcResult(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: number | string, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const TOOL_DEFINITIONS = [
  {
    name: "memory_search",
    description: "Search memories for relevant context. Returns matching memories ranked by relevance.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        type: { type: "string", enum: MEMORY_TYPES, description: "Filter by memory type" },
        scope: {
          type: "string",
          enum: ["user", "profile"],
          description: "user = only user-scoped memories, profile = profile-scoped + user-scoped. Default: profile",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_write",
    description: "Save a new learning, observation, or piece of context as a memory.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short title for this memory" },
        type: { type: "string", enum: MEMORY_TYPES, description: "Memory type" },
        body: { type: "string", description: "The memory content" },
        description: { type: "string", description: "Optional longer description" },
        scope: {
          type: "string",
          enum: ["user", "profile"],
          description: "user = available to all profiles, profile = scoped to current profile. Default: profile",
        },
      },
      required: ["name", "type", "body"],
    },
  },
  {
    name: "memory_update",
    description: "Update an existing memory's content, name, or description.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory ID to update" },
        body: { type: "string", description: "New body content" },
        name: { type: "string", description: "New name" },
        description: { type: "string", description: "New description" },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_delete",
    description: "Delete a memory by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory ID to delete" },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_list",
    description: "Browse memories, optionally filtered by type and scope.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: MEMORY_TYPES, description: "Filter by memory type" },
        scope: {
          type: "string",
          enum: ["user", "profile"],
          description: "user = only user-scoped, profile = profile-scoped + user-scoped. Default: profile",
        },
        limit: { type: "number", description: "Max results to return. Default: 20" },
      },
    },
  },
  {
    name: "memory_read",
    description: "Read the full body of a memory by ID. Use this when memory_search or memory_list returns a truncated preview and you need the complete content.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory ID to read" },
      },
      required: ["id"],
    },
  },
];

// Per-item body cap when listing/searching. The previous 500-char cap was
// punitively short — typical memories run multi-paragraph and got chopped
// mid-sentence. 2000 is enough to convey context without ballooning a
// 20-item list past ~40 KB. When the agent needs the full body, it calls
// `memory_read(id="…")` which returns the entry verbatim, no truncation.
const MEMORY_PREVIEW_CHARS = 2000;

function formatMemoriesForAgent(memories: Memory[]): string {
  if (memories.length === 0) return "No memories found.";

  return memories
    .map((m) => {
      const header = `[${m.type}] ${m.name} (${m.id})`;
      const desc = m.description ? `  ${m.description}` : "";
      const truncated = m.body.length > MEMORY_PREVIEW_CHARS;
      const bodyText = m.body.slice(0, MEMORY_PREVIEW_CHARS);
      const trailer = truncated
        ? `\n  …truncated (${m.body.length - MEMORY_PREVIEW_CHARS} more chars) — call memory_read(id="${m.id}") for the full entry.`
        : "";
      const body = `  ${bodyText}${trailer}`;
      return [header, desc, body].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

/** Full-body read for a single memory. No truncation — that's the point. */
function formatMemoryFull(m: Memory): string {
  const header = `[${m.type}] ${m.name} (${m.id})`;
  const desc = m.description ? `\nDescription: ${m.description}` : "";
  return `${header}${desc}\n\n${m.body}`;
}

function toolResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError && { isError: true }) };
}

export const memoryMcpPlugin = fp(
  async (server: FastifyInstance, opts: MemoryMcpOptions) => {
    const { memoryService, resolveSession } = opts;

    server.post("/mcp/memory", async (request, reply) => {
      const body = request.body as JsonRpcRequest;
      const id = body.id ?? 0;

      if (body.jsonrpc !== "2.0" || !body.method) {
        return reply.send(rpcError(id, -32600, "Invalid JSON-RPC request"));
      }

      const authHeader = request.headers.authorization;
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

      if (!token) {
        return reply.send(rpcError(id, -32000, "Missing Authorization header"));
      }

      const session = resolveSession(token);
      if (!session) {
        return reply.send(rpcError(id, -32000, "Invalid or expired session token"));
      }

      const { userId, profileId, orgId } = session;

      switch (body.method) {
        case "initialize":
          return reply.send(
            rpcResult(id, {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "vonzio-memory", version: "1.0.0" },
            }),
          );

        case "notifications/initialized":
          return reply.send(rpcResult(id, {}));

        case "tools/list":
          return reply.send(rpcResult(id, { tools: TOOL_DEFINITIONS }));

        case "tools/call": {
          const params = body.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
          if (!params?.name) {
            return reply.send(rpcError(id, -32602, "Missing tool name in params"));
          }

          const toolName = params.name;
          const args = params.arguments ?? {};

          try {
            const result = await handleToolCall(memoryService, userId, profileId, orgId, toolName, args);
            return reply.send(rpcResult(id, result));
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            return reply.send(rpcResult(id, toolResult(message, true)));
          }
        }

        default:
          return reply.send(rpcError(id, -32601, `Method not found: ${body.method}`));
      }
    });
  },
  { name: "memory-mcp" },
);

async function handleToolCall(
  memoryService: MemoryService,
  userId: string,
  profileId: string,
  orgId: string | null,
  toolName: string,
  args: Record<string, unknown>,
) {
  // Coalesce null to undefined when calling services that accept optional
  // orgId — they treat undefined as "no scoping" and null isn't a valid
  // value for the eq() filter we use server-side.
  const scopedOrgId = orgId ?? undefined;
  switch (toolName) {
    case "memory_search": {
      const query = args.query as string | undefined;
      if (!query) return toolResult("Missing required parameter: query", true);

      const scope = (args.scope as string) ?? "profile";
      const type = args.type as MemoryType | undefined;
      const searchProfileId = scope === "user" ? undefined : profileId;

      const memories = await memoryService.search(userId, {
        query,
        type,
        profile_id: searchProfileId,
        limit: 10,
      }, scopedOrgId);

      return toolResult(formatMemoriesForAgent(memories));
    }

    case "memory_write": {
      const name = args.name as string | undefined;
      const type = args.type as MemoryType | undefined;
      const body = args.body as string | undefined;

      if (!name || !type || !body) {
        return toolResult("Missing required parameters: name, type, body", true);
      }

      if (!MEMORY_TYPES.includes(type)) {
        return toolResult(`Invalid type: ${type}. Must be one of: ${MEMORY_TYPES.join(", ")}`, true);
      }

      const scope = (args.scope as string) ?? "profile";
      const writeProfileId = scope === "user" ? undefined : profileId;

      const memory = await memoryService.create(userId, {
        name,
        type,
        body,
        description: args.description as string | undefined,
        profile_id: writeProfileId,
      }, scopedOrgId);

      return toolResult(`Memory saved: ${memory.id} (${memory.type}) "${memory.name}"`);
    }

    case "memory_update": {
      const memId = args.id as string | undefined;
      if (!memId) return toolResult("Missing required parameter: id", true);

      const input: Record<string, string> = {};
      if (args.body !== undefined) input.body = args.body as string;
      if (args.name !== undefined) input.name = args.name as string;
      if (args.description !== undefined) input.description = args.description as string;

      const updated = await memoryService.update(memId, userId, input, scopedOrgId);
      if (!updated) return toolResult(`Memory not found: ${memId}`, true);

      return toolResult(`Memory updated: ${updated.id} "${updated.name}"`);
    }

    case "memory_delete": {
      const memId = args.id as string | undefined;
      if (!memId) return toolResult("Missing required parameter: id", true);

      const deleted = await memoryService.delete(memId, userId, scopedOrgId);
      if (!deleted) return toolResult(`Memory not found: ${memId}`, true);

      return toolResult(`Memory deleted: ${memId}`);
    }

    case "memory_list": {
      const scope = (args.scope as string) ?? "profile";
      const type = args.type as string | undefined;
      const limit = (args.limit as number) ?? 20;
      const listProfileId = scope === "user" ? undefined : profileId;

      const memories = await memoryService.list(userId, {
        type,
        profileId: listProfileId,
        limit,
        orgId: scopedOrgId,
      });

      return toolResult(formatMemoriesForAgent(memories));
    }

    case "memory_read": {
      const memId = args.id as string | undefined;
      if (!memId) return toolResult("Missing required parameter: id", true);

      const mem = await memoryService.get(memId, { userId, orgId: scopedOrgId });
      if (!mem) {
        return toolResult(`Memory not found: ${memId}`, true);
      }
      return toolResult(formatMemoryFull(mem));
    }

    default:
      return toolResult(`Unknown tool: ${toolName}`, true);
  }
}
