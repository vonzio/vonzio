// Mail MCP channel (feature 0035) — the agent-facing surface of the
// universal IMAP/SMTP connector. Same shape as the other token-auth MCP
// channels (memory/notify/platform): agents hold a per-session bearer
// token minted by the orchestrator; credentials never leave the server.
//
// mail_send is the prompt-injection-dangerous tool: a hijacked agent
// with send access is a spam/impersonation cannon. Brakes:
//   - per-integration `allow_send` kill switch (owner-controlled),
//   - per-integration rate limits (5/min, 50/day, process-local — same
//     TTL-state idiom as the telegram webhook throttles),
//   - every send is logged with user/session/recipient for audit.

import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { IntegrationService } from "../services/integration-service.js";
import { MailService, type MailConfig } from "../services/mail-service.js";

interface MailMcpSession {
  userId: string;
  sessionId: string;
  profileId: string;
}

export interface MailMcpOptions {
  integrationService: IntegrationService;
  resolveSession: (token: string) => MailMcpSession | null;
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

const TOOL_DEFINITIONS = [
  {
    name: "mail_list_folders",
    description: "List the folders/mailboxes in the user's mail account (INBOX, Sent, Drafts, …).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mail_search",
    description:
      "Search the user's mailbox. Returns message summaries with UIDs usable with mail_read_message. Filters combine with AND. Results are newest-first, capped at 50.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder to search (default: INBOX)" },
        text: { type: "string", description: "Free-text match over subject and body" },
        from: { type: "string", description: "Match sender address/name" },
        subject: { type: "string", description: "Match subject" },
        unseen: { type: "boolean", description: "Only unread messages" },
        since: { type: "string", description: "Only messages on/after this date (YYYY-MM-DD)" },
        limit: { type: "number", description: "Max results (default 10, max 50)" },
      },
    },
  },
  {
    name: "mail_read_message",
    description: "Read a message's full text body by folder + UID (from mail_search results).",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Folder the message lives in (default: INBOX)" },
        uid: { type: "number", description: "Message UID from mail_search" },
      },
      required: ["uid"],
    },
  },
  {
    name: "mail_create_draft",
    description: "Create a draft in the user's mailbox WITHOUT sending it. Prefer this over mail_send when the user hasn't explicitly asked to send.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient(s), comma-separated" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text body" },
        cc: { type: "string" },
        bcc: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "mail_send",
    description:
      "Send an email from the user's account. Only use when the user explicitly asked to send; otherwise use mail_create_draft. Rate-limited.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient(s), comma-separated" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text body" },
        cc: { type: "string" },
        bcc: { type: "string" },
        in_reply_to: { type: "string", description: "Message-ID being replied to (optional)" },
      },
      required: ["to", "subject", "body"],
    },
  },
];

// Send throttle, keyed by integration id. Process-local: a restart
// resets the day counter, which errs permissive — acceptable next to
// the owner-facing kill switch and the audit log.
const MAX_RECIPIENTS_PER_SEND = 20;
const SEND_MINUTE_MAX = 5;
const SEND_DAY_MAX = 50;
const sendCounters = new Map<string, { minuteStart: number; minuteCount: number; dayStart: number; dayCount: number }>();

export function allowSend(integrationId: string, now: number = Date.now()): boolean {
  let c = sendCounters.get(integrationId);
  if (!c) {
    c = { minuteStart: now, minuteCount: 0, dayStart: now, dayCount: 0 };
    sendCounters.set(integrationId, c);
  }
  if (now - c.minuteStart >= 60_000) {
    c.minuteStart = now;
    c.minuteCount = 0;
  }
  if (now - c.dayStart >= 24 * 60 * 60 * 1000) {
    c.dayStart = now;
    c.dayCount = 0;
  }
  if (c.minuteCount >= SEND_MINUTE_MAX || c.dayCount >= SEND_DAY_MAX) return false;
  c.minuteCount++;
  c.dayCount++;
  return true;
}

export const mailMcpPlugin = fp(
  async (server: FastifyInstance, opts: MailMcpOptions) => {
    const { integrationService, resolveSession } = opts;
    const mailService = new MailService();

    async function handleToolCall(
      session: MailMcpSession,
      toolName: string,
      args: Record<string, unknown>,
    ) {
      // Resolve the mailbox by the SAME grant the orchestrator used to
      // inject this channel (listForProfile), so a session on profile A
      // can't reach a mailbox granted only to profile B.
      const rows = await integrationService.listForProfile(session.userId, "mail", session.profileId);
      const integration = rows.find((r) => r.enabled);
      if (!integration) {
        return toolResult("No mail account connected. Ask the user to connect one in Settings → Integrations → Mail.", true);
      }
      const cfg = integration.config as unknown as MailConfig;

      switch (toolName) {
        case "mail_list_folders": {
          const folders = await mailService.listFolders(cfg);
          return toolResult(
            `Folders:\n${folders.map((f) => (f.specialUse ? `${f.path} (${f.specialUse.replace(/\\/g, "")})` : f.path)).join("\n")}`,
          );
        }
        case "mail_search": {
          const results = await mailService.search(cfg, {
            folder: args.folder as string | undefined,
            text: args.text as string | undefined,
            from: args.from as string | undefined,
            subject: args.subject as string | undefined,
            unseen: args.unseen as boolean | undefined,
            since: args.since as string | undefined,
            limit: args.limit as number | undefined,
          });
          if (results.length === 0) return toolResult("No messages matched.");
          const lines = results.map((m) =>
            [
              `UID: ${m.uid} | Folder: ${m.folder}${m.seen ? "" : " | UNREAD"}`,
              `From: ${m.from}`,
              `Subject: ${m.subject}`,
              `Date: ${m.date}`,
            ].join("\n"),
          );
          return toolResult(`${results.length} message(s):\n\n${lines.join("\n---\n")}`);
        }
        case "mail_read_message": {
          const uid = args.uid as number;
          if (!uid) return toolResult("Missing required parameter: uid", true);
          const msg = await mailService.readMessage(cfg, (args.folder as string) || "INBOX", uid);
          return toolResult(
            [
              `From: ${msg.summary.from}`,
              `To: ${msg.summary.to}`,
              `Subject: ${msg.summary.subject}`,
              `Date: ${msg.summary.date}`,
              ...(msg.messageId ? [`Message-ID: ${msg.messageId}`] : []),
              "",
              msg.text,
            ].join("\n"),
          );
        }
        case "mail_create_draft": {
          const { to, subject, body } = args as { to?: string; subject?: string; body?: string };
          if (!to || !subject || !body) return toolResult("Missing required parameters: to, subject, body", true);
          const res = await mailService.createDraft(cfg, {
            to, subject, body,
            cc: args.cc as string | undefined,
            bcc: args.bcc as string | undefined,
          });
          return toolResult(`Draft saved to ${res.folder}. It has NOT been sent.`);
        }
        case "mail_send": {
          const { to, subject, body } = args as { to?: string; subject?: string; body?: string };
          if (!to || !subject || !body) return toolResult("Missing required parameters: to, subject, body", true);
          if (cfg.allow_send === false) {
            return toolResult("Sending is disabled for this mail account (owner setting). Use mail_create_draft instead.", true);
          }
          const recipientCount = [to, args.cc, args.bcc]
            .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
            .reduce((n, list) => n + list.split(",").filter((a) => a.trim()).length, 0);
          if (recipientCount > MAX_RECIPIENTS_PER_SEND) {
            return toolResult(`Too many recipients (${recipientCount}); max ${MAX_RECIPIENTS_PER_SEND} per message.`, true);
          }
          if (!allowSend(integration.id)) {
            return toolResult("Send rate limit reached for this mail account (5/min, 50/day). Use mail_create_draft instead.", true);
          }
          const res = await mailService.send(cfg, {
            to, subject, body,
            cc: args.cc as string | undefined,
            bcc: args.bcc as string | undefined,
            inReplyTo: args.in_reply_to as string | undefined,
          });
          // Audit trail: who sent what to whom from which session.
          server.log.info(
            { userId: session.userId, sessionId: session.sessionId, integrationId: integration.id, to, subject },
            "mail_send dispatched",
          );
          return toolResult(`Email sent. Message-ID: ${res.messageId}`);
        }
        default:
          return toolResult(`Unknown tool: ${toolName}`, true);
      }
    }

    server.post("/mcp/mail", async (request, reply) => {
      const body = request.body as JsonRpcRequest | null;
      const id = (body && typeof body === "object" ? body.id : undefined) ?? 0;
      if (!body || typeof body !== "object" || body.jsonrpc !== "2.0" || !body.method) {
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
              serverInfo: { name: "vonzio-mail", version: "1.0.0" },
            }),
          );
        case "notifications/initialized":
          return reply.send(rpcResult(id, {}));
        case "tools/list":
          return reply.send(rpcResult(id, { tools: TOOL_DEFINITIONS }));
        case "tools/call": {
          const params = body.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
          if (!params?.name) return reply.send(rpcError(id, -32602, "Missing tool name in params"));
          try {
            const result = await handleToolCall(session, params.name, params.arguments ?? {});
            return reply.send(rpcResult(id, result));
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            server.log.error({ err, tool: params.name }, "Mail MCP tool call failed");
            return reply.send(rpcResult(id, toolResult(message, true)));
          }
        }
        default:
          return reply.send(rpcError(id, -32601, `Method not found: ${body.method}`));
      }
    });
  },
  { name: "mail-mcp" },
);
