import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { NotificationService } from "../services/notification-service.js";
import { NOTIFICATION_CHANNELS, type NotificationChannel } from "@vonzio/shared";

interface NotifyMcpSession {
  userId: string;
  /** The agent's own session id — used for Telegram thread-claim (feature #18). */
  sessionId: string;
}

export interface NotifyMcpOptions {
  notificationService: NotificationService;
  resolveSession: (token: string) => NotifyMcpSession | null;
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

// Exported for the regression test in notify-mcp.test.ts. The
// notify_user enum must always equal NOTIFICATION_CHANNELS verbatim.
export const TOOL_DEFINITIONS = [
  {
    name: "notify_user",
    description: "Send a notification to the user via one of their configured channels (Slack, email, webhook, or Telegram). Use this to alert the user about important findings, completed work, errors, or any information that warrants their attention. Better than waiting for the playbook completion notification when you have something concrete to surface mid-run (a bill is due, a metric crossed a threshold, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The notification message. Plain text or markdown (the delivery channel renders it). Be concise but specific.",
        },
        channel: {
          type: "string",
          // Accept either a bare channel name (slack/email/webhook/telegram)
          // or the `telegram:<integration_id>` shorthand for a specific bot.
          // Enum is intentionally not enforced so playbook prompts can pass
          // "telegram:int_X" — the server validates and routes in
          // NotificationService.send().
          description: `Delivery channel. Bare name (${NOTIFICATION_CHANNELS.join(", ")}) uses the user's integration of that type. "telegram:<integration_id>" picks a specific bot (required when claim_thread=true). Omit to use the user's default.`,
        },
        urgency: {
          type: "string",
          enum: ["low", "normal", "high"],
          description: "Message urgency. Default: normal.",
        },
        claim_thread: {
          type: "boolean",
          description: "Telegram-only. When true, attach [Reply here] / [Keep my chat] inline buttons so the user's next Telegram message can be routed back to this session for context-aware handling. Use for notifications that expect a reply (statement requests, follow-up nudges). Skip for purely informational messages.",
        },
        claim_thread_label: {
          type: "string",
          description: "Telegram-only. Short label (e.g. 'monthly-statement', 'cc-payment') shown in the [Switched to <label> thread] disclaimer when the user replies. Only meaningful when claim_thread=true.",
        },
      },
      required: ["message"],
    },
  },
];

function toolResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError && { isError: true }) };
}

export const notifyMcpPlugin = fp(
  async (server: FastifyInstance, opts: NotifyMcpOptions) => {
    const { notificationService, resolveSession } = opts;

    server.post("/mcp/notify", async (request, reply) => {
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

      const { userId, sessionId } = session;

      switch (body.method) {
        case "initialize":
          return reply.send(
            rpcResult(id, {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "vonzio-notify", version: "1.0.0" },
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
            const result = await handleToolCall(notificationService, userId, sessionId, toolName, args);
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
  { name: "notify-mcp" },
);

async function handleToolCall(
  notificationService: NotificationService,
  userId: string,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
) {
  switch (toolName) {
    case "notify_user": {
      const message = args.message as string | undefined;
      if (!message) return toolResult("Missing required parameter: message", true);

      const claimThread = args.claim_thread === true;
      const result = await notificationService.send({
        userId,
        channel: args.channel as NotificationChannel | undefined,
        message: args.message as string,
        urgency: (args.urgency as "low" | "normal" | "high") ?? "normal",
        source: "agent",
        // Thread-claim params route only to Telegram delivery — other
        // channels ignore them. sessionId always comes from the MCP
        // token (server-side), never the agent's args, so an agent
        // can't forge a claim against a session it doesn't own.
        threadClaim: claimThread
          ? { sessionId, label: typeof args.claim_thread_label === "string" ? args.claim_thread_label : undefined }
          : undefined,
      });

      return toolResult(
        result.success
          ? `Notification sent via ${result.channel}`
          : `Notification failed: ${result.error ?? "unknown error"}`,
        !result.success,
      );
    }

    default:
      return toolResult(`Unknown tool: ${toolName}`, true);
  }
}
