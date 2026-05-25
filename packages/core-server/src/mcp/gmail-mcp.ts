import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Config } from "../config.js";
import type { IntegrationService, GmailConfig } from "../services/integration-service.js";
import { resolveGoogleCredentials } from "../routes/gmail-oauth.js";

interface GmailMcpSession {
  userId: string;
}

export interface GmailMcpOptions {
  config: Config;
  integrationService: IntegrationService;
  resolveSession: (token: string) => GmailMcpSession | null;
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

function toolResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError && { isError: true }) };
}

const TOOL_DEFINITIONS = [
  {
    name: "gmail_search",
    description:
      "Search the user's Gmail inbox. Uses the same query syntax as Gmail search (e.g. 'from:alice subject:meeting', 'is:unread', 'after:2024/01/01'). Returns message summaries with IDs that can be used with gmail_read_message.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Gmail search query (same syntax as Gmail search bar)",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (default: 10, max: 50)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "gmail_read_message",
    description:
      "Read the full content of a specific email message by its ID. Returns subject, from, to, date, and body text.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "The Gmail message ID (from gmail_search results)",
        },
      },
      required: ["message_id"],
    },
  },
  {
    name: "gmail_read_thread",
    description:
      "Read an entire email thread/conversation by thread ID. Returns all messages in the thread in chronological order.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description: "The Gmail thread ID (from gmail_search results)",
        },
      },
      required: ["thread_id"],
    },
  },
  {
    name: "gmail_list_labels",
    description: "List all Gmail labels (folders/categories) in the user's account.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "gmail_send_message",
    description:
      "Send an email from the user's Gmail account. Supports plain text and reply-to-thread.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient email address (comma-separated for multiple)",
        },
        subject: {
          type: "string",
          description: "Email subject line",
        },
        body: {
          type: "string",
          description: "Email body text (plain text)",
        },
        cc: {
          type: "string",
          description: "CC recipients (comma-separated, optional)",
        },
        bcc: {
          type: "string",
          description: "BCC recipients (comma-separated, optional)",
        },
        thread_id: {
          type: "string",
          description: "Thread ID to reply to (optional — makes this a reply in an existing thread)",
        },
        in_reply_to: {
          type: "string",
          description: "Message-ID header of the message being replied to (optional, used with thread_id)",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "gmail_create_draft",
    description:
      "Create a draft email in the user's Gmail account without sending it.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient email address (comma-separated for multiple)",
        },
        subject: {
          type: "string",
          description: "Email subject line",
        },
        body: {
          type: "string",
          description: "Email body text (plain text)",
        },
        cc: {
          type: "string",
          description: "CC recipients (comma-separated, optional)",
        },
        bcc: {
          type: "string",
          description: "BCC recipients (comma-separated, optional)",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
];

/** Refresh the access token using the stored refresh token. */
async function refreshAccessToken(
  config: Config,
  gmailConfig: GmailConfig,
  integrationService: IntegrationService,
  integrationId: string,
): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (gmailConfig.access_token && gmailConfig.token_expiry && Date.now() < gmailConfig.token_expiry - 60_000) {
    return gmailConfig.access_token;
  }

  const creds = resolveGoogleCredentials(config);
  if (!creds) {
    throw new Error("Google OAuth credentials not configured (GMAIL_CLIENT_ID or AUTH_GOOGLE_CLIENT_ID required)");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: gmailConfig.refresh_token,
      grant_type: "refresh_token",
    }).toString(),
  });

  const data = (await res.json()) as Record<string, unknown>;
  if (data.error) {
    throw new Error(`Token refresh failed: ${data.error_description ?? data.error}`);
  }

  const accessToken = data.access_token as string;
  const expiresIn = (data.expires_in as number) ?? 3600;

  // Persist the new access token
  await integrationService.update(integrationId, {
    config: {
      ...gmailConfig,
      access_token: accessToken,
      token_expiry: Date.now() + expiresIn * 1000,
    },
  });

  return accessToken;
}

/** Make an authenticated GET request to the Gmail API. */
async function gmailApi(accessToken: string, path: string, params?: Record<string, string>): Promise<unknown> {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API error (${res.status}): ${body}`);
  }

  return res.json();
}

/** Make an authenticated POST request to the Gmail API. */
async function gmailApiPost(accessToken: string, path: string, body: unknown): Promise<unknown> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/${path}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gmail API error (${res.status}): ${text}`);
  }

  return res.json();
}

/** Build a RFC 2822 email message and return it as base64url-encoded string. */
function buildRawEmail(opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const lines: string[] = [];
  lines.push(`From: ${opts.from}`);
  lines.push(`To: ${opts.to}`);
  if (opts.cc) lines.push(`Cc: ${opts.cc}`);
  if (opts.bcc) lines.push(`Bcc: ${opts.bcc}`);
  // RFC 2047: encode non-ASCII subject as base64 UTF-8
  const hasNonAscii = /[^\x00-\x7F]/.test(opts.subject);
  const encodedSubject = hasNonAscii
    ? `=?UTF-8?B?${Buffer.from(opts.subject).toString("base64")}?=`
    : opts.subject;
  lines.push(`Subject: ${encodedSubject}`);
  if (opts.inReplyTo) {
    lines.push(`In-Reply-To: ${opts.inReplyTo}`);
    lines.push(`References: ${opts.references ?? opts.inReplyTo}`);
  }
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("");
  lines.push(opts.body);

  const raw = lines.join("\r\n");
  return Buffer.from(raw).toString("base64url");
}

/** Extract plain text body from a Gmail message payload. */
function extractBody(payload: Record<string, unknown>): string {
  // Simple message with body data
  const body = payload.body as Record<string, unknown> | undefined;
  if (body?.data) {
    return Buffer.from(body.data as string, "base64url").toString("utf-8");
  }

  // Multipart message — look for text/plain first, then text/html
  const parts = payload.parts as Array<Record<string, unknown>> | undefined;
  if (!parts) return "";

  for (const mimeType of ["text/plain", "text/html"]) {
    for (const part of parts) {
      if (part.mimeType === mimeType) {
        const partBody = part.body as Record<string, unknown> | undefined;
        if (partBody?.data) {
          let text = Buffer.from(partBody.data as string, "base64url").toString("utf-8");
          if (mimeType === "text/html") {
            // Strip HTML tags for readability
            text = text.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
          }
          return text;
        }
      }
      // Check nested parts (e.g. multipart/alternative inside multipart/mixed)
      if (part.parts) {
        const nested = extractBody(part as Record<string, unknown>);
        if (nested) return nested;
      }
    }
  }

  return "";
}

/** Get header value from a Gmail message. */
function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** Format a message for display. */
function formatMessage(msg: Record<string, unknown>): string {
  const payload = msg.payload as Record<string, unknown>;
  const headers = (payload.headers ?? []) as Array<{ name: string; value: string }>;
  const body = extractBody(payload);

  const lines = [
    `ID: ${msg.id}`,
    `Thread: ${msg.threadId}`,
    `From: ${getHeader(headers, "From")}`,
    `To: ${getHeader(headers, "To")}`,
    `Date: ${getHeader(headers, "Date")}`,
    `Subject: ${getHeader(headers, "Subject")}`,
    "",
    body.slice(0, 4000),
  ];

  if (body.length > 4000) {
    lines.push("\n[Message truncated — body exceeds 4000 characters]");
  }

  return lines.join("\n");
}

async function handleToolCall(
  config: Config,
  integrationService: IntegrationService,
  userId: string,
  toolName: string,
  args: Record<string, unknown>,
) {
  // Load the user's Gmail integration
  const integration = await integrationService.getByUserAndType(userId, "gmail");
  if (!integration) {
    return toolResult("Gmail is not connected. Ask the user to connect Gmail in Settings > Integrations.", true);
  }

  const gmailConfig = integration.config as unknown as GmailConfig;

  let accessToken: string;
  try {
    accessToken = await refreshAccessToken(config, gmailConfig, integrationService, integration.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Token refresh failed";
    return toolResult(`Gmail authentication error: ${msg}. The user may need to reconnect Gmail.`, true);
  }

  switch (toolName) {
    case "gmail_search": {
      const query = args.query as string;
      if (!query) return toolResult("Missing required parameter: query", true);

      const maxResults = Math.min(Math.max((args.max_results as number) || 10, 1), 50);

      const listData = (await gmailApi(accessToken, "messages", {
        q: query,
        maxResults: String(maxResults),
      })) as Record<string, unknown>;

      const messageIds = (listData.messages ?? []) as Array<{ id: string; threadId: string }>;
      if (messageIds.length === 0) {
        return toolResult("No messages found matching the query.");
      }

      // Fetch metadata for all messages in parallel
      const msgs = await Promise.all(
        messageIds.map(({ id }) =>
          gmailApi(accessToken, `messages/${id}`, {
            format: "metadata",
            metadataHeaders: "From,To,Subject,Date",
          }) as Promise<Record<string, unknown>>,
        ),
      );

      const summaries = msgs.map((msg) => {
        const payload = msg.payload as Record<string, unknown>;
        const headers = (payload.headers ?? []) as Array<{ name: string; value: string }>;
        const snippet = (msg.snippet as string) ?? "";

        return [
          `ID: ${msg.id} | Thread: ${msg.threadId}`,
          `From: ${getHeader(headers, "From")}`,
          `Subject: ${getHeader(headers, "Subject")}`,
          `Date: ${getHeader(headers, "Date")}`,
          `Preview: ${snippet.slice(0, 150)}`,
        ].join("\n");
      });

      const total = (listData.resultSizeEstimate as number) ?? messageIds.length;
      return toolResult(
        `Found ~${total} results (showing ${messageIds.length}):\n\n${summaries.join("\n---\n")}`,
      );
    }

    case "gmail_read_message": {
      const messageId = args.message_id as string;
      if (!messageId) return toolResult("Missing required parameter: message_id", true);

      const msg = (await gmailApi(accessToken, `messages/${messageId}`, {
        format: "full",
      })) as Record<string, unknown>;

      return toolResult(formatMessage(msg));
    }

    case "gmail_read_thread": {
      const threadId = args.thread_id as string;
      if (!threadId) return toolResult("Missing required parameter: thread_id", true);

      const thread = (await gmailApi(accessToken, `threads/${threadId}`, {
        format: "full",
      })) as Record<string, unknown>;

      const messages = (thread.messages ?? []) as Array<Record<string, unknown>>;
      if (messages.length === 0) {
        return toolResult("Thread is empty or not found.");
      }

      const formatted = messages.map((msg, i) => `--- Message ${i + 1} of ${messages.length} ---\n${formatMessage(msg)}`);
      return toolResult(formatted.join("\n\n"));
    }

    case "gmail_list_labels": {
      const data = (await gmailApi(accessToken, "labels")) as Record<string, unknown>;
      const labels = (data.labels ?? []) as Array<{ id: string; name: string; type: string }>;

      const formatted = labels
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((l) => `${l.name} (${l.type.toLowerCase()})`)
        .join("\n");

      return toolResult(`Labels:\n${formatted}`);
    }

    case "gmail_send_message": {
      const to = args.to as string;
      const subject = args.subject as string;
      const body = args.body as string;
      if (!to || !subject || !body) return toolResult("Missing required parameters: to, subject, body", true);

      const raw = buildRawEmail({
        from: gmailConfig.email,
        to,
        subject,
        body,
        cc: args.cc as string | undefined,
        bcc: args.bcc as string | undefined,
        inReplyTo: args.in_reply_to as string | undefined,
      });

      const payload: Record<string, unknown> = { raw };
      if (args.thread_id) payload.threadId = args.thread_id;

      const result = (await gmailApiPost(accessToken, "messages/send", payload)) as Record<string, unknown>;
      return toolResult(`Email sent successfully. Message ID: ${result.id}, Thread ID: ${result.threadId}`);
    }

    case "gmail_create_draft": {
      const to = args.to as string;
      const subject = args.subject as string;
      const body = args.body as string;
      if (!to || !subject || !body) return toolResult("Missing required parameters: to, subject, body", true);

      const raw = buildRawEmail({
        from: gmailConfig.email,
        to,
        subject,
        body,
        cc: args.cc as string | undefined,
        bcc: args.bcc as string | undefined,
      });

      const result = (await gmailApiPost(accessToken, "drafts", {
        message: { raw },
      })) as Record<string, unknown>;
      const draftMsg = result.message as Record<string, unknown> | undefined;
      return toolResult(`Draft created successfully. Draft ID: ${result.id}, Message ID: ${draftMsg?.id ?? "unknown"}`);
    }

    default:
      return toolResult(`Unknown tool: ${toolName}`, true);
  }
}

export const gmailMcpPlugin = fp(
  async (server: FastifyInstance, opts: GmailMcpOptions) => {
    const { config, integrationService, resolveSession } = opts;

    server.post("/mcp/gmail", async (request, reply) => {
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

      const { userId } = session;

      switch (body.method) {
        case "initialize":
          return reply.send(
            rpcResult(id, {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "vonzio-gmail", version: "1.0.0" },
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

          try {
            const result = await handleToolCall(config, integrationService, userId, params.name, params.arguments ?? {});
            return reply.send(rpcResult(id, result));
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            server.log.error({ err, tool: params.name }, "Gmail MCP tool call failed");
            return reply.send(rpcResult(id, toolResult(message, true)));
          }
        }

        default:
          return reply.send(rpcError(id, -32601, `Method not found: ${body.method}`));
      }
    });
  },
  { name: "gmail-mcp" },
);
