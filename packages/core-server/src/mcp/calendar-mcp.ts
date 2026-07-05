// Calendar MCP channel (feature 0037) — agent-facing surface of the CalDAV
// connector. Same token-auth pattern as mail-mcp: agents hold a per-session
// bearer token; credentials stay server-side. Resolves the mailbox — er,
// calendar — by the SAME per-profile grant the orchestrator used to inject
// this channel, so a profile-A session can't reach a profile-B calendar.

import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { IntegrationService } from "../services/integration-service.js";
import { CalendarService, type CalendarConfig } from "../services/calendar-service.js";

interface CalendarMcpSession {
  userId: string;
  sessionId: string;
  profileId: string;
}

export interface CalendarMcpOptions {
  integrationService: IntegrationService;
  resolveSession: (token: string) => CalendarMcpSession | null;
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
    name: "calendar_list",
    description: "List the user's calendars (name + url). Use a calendar url to scope other calendar tools.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "calendar_events",
    description: "List upcoming events across the user's calendars within a window (default next 7 days). Returns event UIDs + object urls usable with calendar_delete_event.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How many days ahead (default 7, max 90)" },
        limit: { type: "number", description: "Max events (default 25, max 100)" },
        calendar_url: { type: "string", description: "Restrict to one calendar (from calendar_list)" },
      },
    },
  },
  {
    name: "calendar_create_event",
    description: "Create a single timed event. start/end are ISO-8601 datetimes. Only use when the user explicitly asked to add something to their calendar.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title" },
        start: { type: "string", description: "ISO-8601 start datetime" },
        end: { type: "string", description: "ISO-8601 end datetime" },
        location: { type: "string" },
        description: { type: "string" },
        calendar_url: { type: "string", description: "Target calendar (default: first)" },
      },
      required: ["summary", "start", "end"],
    },
  },
  {
    name: "calendar_delete_event",
    description: "Delete an event by its object url (from calendar_events). Irreversible; only use when the user explicitly asked to cancel/remove an event.",
    inputSchema: {
      type: "object",
      properties: {
        object_url: { type: "string", description: "Event object url from calendar_events" },
      },
      required: ["object_url"],
    },
  },
];

export const calendarMcpPlugin = fp(
  async (server: FastifyInstance, opts: CalendarMcpOptions) => {
    const { integrationService, resolveSession } = opts;
    const calendarService = new CalendarService();

    async function handleToolCall(session: CalendarMcpSession, toolName: string, args: Record<string, unknown>) {
      const rows = await integrationService.listForProfile(session.userId, "calendar", session.profileId);
      const integration = rows.find((r) => r.enabled);
      if (!integration) {
        return toolResult("No calendar connected. Ask the user to connect one in Settings → Integrations → Calendar.", true);
      }
      const cfg = integration.config as unknown as CalendarConfig;

      switch (toolName) {
        case "calendar_list": {
          const cals = await calendarService.listCalendars(cfg);
          if (cals.length === 0) return toolResult("No calendars found.");
          return toolResult(`Calendars:\n${cals.map((c) => `${c.displayName} — ${c.url}`).join("\n")}`);
        }
        case "calendar_events": {
          const events = await calendarService.listEvents(cfg, {
            days: args.days as number | undefined,
            limit: args.limit as number | undefined,
            calendarUrl: args.calendar_url as string | undefined,
          });
          if (events.length === 0) return toolResult("No upcoming events in that window.");
          const lines = events.map((e) =>
            [
              `${e.start} → ${e.end}`,
              `Title: ${e.summary}`,
              ...(e.location ? [`Location: ${e.location}`] : []),
              `UID: ${e.uid} | object_url: ${e.objectUrl}`,
            ].join("\n"),
          );
          return toolResult(`${events.length} event(s):\n\n${lines.join("\n---\n")}`);
        }
        case "calendar_create_event": {
          const { summary, start, end } = args as { summary?: string; start?: string; end?: string };
          if (!summary || !start || !end) return toolResult("Missing required parameters: summary, start, end", true);
          if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
            return toolResult("start and end must be valid ISO-8601 datetimes", true);
          }
          const res = await calendarService.createEvent(cfg, {
            summary, start, end,
            location: args.location as string | undefined,
            description: args.description as string | undefined,
            calendarUrl: args.calendar_url as string | undefined,
          });
          server.log.info({ userId: session.userId, sessionId: session.sessionId, integrationId: integration.id, uid: res.uid }, "calendar event created");
          return toolResult(`Event created (uid ${res.uid}) on ${res.calendarUrl}.`);
        }
        case "calendar_delete_event": {
          const objectUrl = args.object_url as string;
          if (!objectUrl) return toolResult("Missing required parameter: object_url", true);
          await calendarService.deleteEvent(cfg, objectUrl);
          server.log.info({ userId: session.userId, sessionId: session.sessionId, integrationId: integration.id, objectUrl }, "calendar event deleted");
          return toolResult("Event deleted.");
        }
        default:
          return toolResult(`Unknown tool: ${toolName}`, true);
      }
    }

    server.post("/mcp/calendar", async (request, reply) => {
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
          return reply.send(rpcResult(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "vonzio-calendar", version: "1.0.0" } }));
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
            server.log.error({ err, tool: params.name }, "Calendar MCP tool call failed");
            return reply.send(rpcResult(id, toolResult(message, true)));
          }
        }
        default:
          return reply.send(rpcError(id, -32601, `Method not found: ${body.method}`));
      }
    });
  },
  { name: "calendar-mcp" },
);
