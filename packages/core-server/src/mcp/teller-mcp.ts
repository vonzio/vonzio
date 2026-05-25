import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { IntegrationService, TellerConfig } from "../services/integration-service.js";
import {
  TellerClient,
  TellerApiError,
  TellerNotConfiguredError,
} from "../services/teller-client.js";

interface TellerMcpSession {
  userId: string;
  profileId: string;
}

export interface TellerMcpOptions {
  integrationService: IntegrationService;
  tellerClient: TellerClient;
  resolveSession: (token: string) => TellerMcpSession | null;
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

export const TOOL_DEFINITIONS = [
  {
    name: "teller_list_enrollments",
    description:
      "List the user's connected bank enrollments (one per institution). Returns enrollment_id, institution name, and when each was linked. Call this first to discover which banks are available; later calls take an enrollment_id.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "teller_list_accounts",
    description:
      "List bank/credit-card accounts for a specific enrollment. Returns account_id, name, type, subtype, currency, last four digits, and institution. Use the account_id with teller_get_balance / teller_list_transactions / teller_get_account_details.",
    inputSchema: {
      type: "object",
      properties: {
        enrollment_id: {
          type: "string",
          description: "Enrollment to read from (from teller_list_enrollments).",
        },
      },
      required: ["enrollment_id"],
    },
  },
  {
    name: "teller_get_balance",
    description:
      "Read the current available and ledger balances for one account. " +
      "COST-SENSITIVE: $0.10 per call on Teller's Production tier. " +
      "Call only when the user explicitly asks about current funds (e.g. " +
      "\"how much do I have\", \"can I afford X\", \"do I have enough for the " +
      "Amex bill\"). For routine spend tracking, monthly budgets, or " +
      "category summaries, use teller_list_transactions instead — it's a " +
      "$0.30/enrollment/month flat subscription, not per-call.",
    inputSchema: {
      type: "object",
      properties: {
        enrollment_id: { type: "string", description: "Owning enrollment id." },
        account_id: { type: "string", description: "Account id from teller_list_accounts." },
      },
      required: ["enrollment_id", "account_id"],
    },
  },
  {
    name: "teller_list_transactions",
    description:
      "List recent transactions for one account, newest first. Use 'count' " +
      "to cap the result (default 50, Teller's max is ~250). Use 'from_id' " +
      "to paginate older. " +
      "PREFERRED for: monthly spend, category breakdowns, recurring " +
      "charges, merchant lookups, budget tracking. Cheaper than balance " +
      "calls on Production (subscription, not per-call).",
    inputSchema: {
      type: "object",
      properties: {
        enrollment_id: { type: "string", description: "Owning enrollment id." },
        account_id: { type: "string", description: "Account id from teller_list_accounts." },
        count: { type: "number", description: "Max transactions to return (default 50)." },
        from_id: { type: "string", description: "Paginate from this transaction id (optional)." },
      },
      required: ["enrollment_id", "account_id"],
    },
  },
  {
    name: "teller_get_account_details",
    description:
      "Read account number + routing numbers for one account. " +
      "Only call when explicitly relevant (bill payment, ACH setup) — " +
      "this surface is sensitive AND the most expensive Teller endpoint " +
      "($1.75 per call on Production's Identity tier). Never call " +
      "speculatively for budgeting or spend tracking.",
    inputSchema: {
      type: "object",
      properties: {
        enrollment_id: { type: "string", description: "Owning enrollment id." },
        account_id: { type: "string", description: "Account id from teller_list_accounts." },
      },
      required: ["enrollment_id", "account_id"],
    },
  },
];

/**
 * Pull teller integrations scoped to this user+profile; return a
 * Map<enrollment_id, TellerConfig>. Scope filter lives in the
 * IntegrationService so the same gate that decides MCP-injection also
 * decides which enrollments the agent can see inside the MCP.
 */
async function loadEnrollments(
  integrationService: IntegrationService,
  userId: string,
  profileId: string,
): Promise<Map<string, TellerConfig>> {
  const rows = await integrationService.listForProfile(userId, "teller", profileId);
  const map = new Map<string, TellerConfig>();
  for (const row of rows) {
    const cfg = row.config as unknown as TellerConfig;
    if (cfg.enrollment_id && cfg.access_token) {
      map.set(cfg.enrollment_id, cfg);
    }
  }
  return map;
}

/**
 * Token-scoped enrollments cache. Each MCP token corresponds to one agent
 * task lifetime (minted by the orchestrator, cleared on task finally). A
 * chatty agent makes many `tools/call` requests with the same token; this
 * cache avoids re-decrypting every teller row on each call. Eviction is
 * driven by the orchestrator clearing the token from its in-memory map —
 * we mirror that by clearing on a short TTL so a stale cache can't outlive
 * a token deletion the MCP isn't aware of.
 */
const ENROLLMENTS_CACHE_TTL_MS = 30_000;
interface CacheEntry {
  enrollments: Map<string, TellerConfig>;
  expiresAt: number;
}
const enrollmentsCache = new Map<string, CacheEntry>();

async function loadEnrollmentsCached(
  integrationService: IntegrationService,
  token: string,
  userId: string,
  profileId: string,
): Promise<Map<string, TellerConfig>> {
  const now = Date.now();
  const hit = enrollmentsCache.get(token);
  if (hit && hit.expiresAt > now) return hit.enrollments;
  const enrollments = await loadEnrollments(integrationService, userId, profileId);
  enrollmentsCache.set(token, { enrollments, expiresAt: now + ENROLLMENTS_CACHE_TTL_MS });
  return enrollments;
}

/** Test hook — drop all cached entries. */
export function _clearEnrollmentsCacheForTests(): void {
  enrollmentsCache.clear();
}

function summarizeError(err: unknown): string {
  if (err instanceof TellerNotConfiguredError) {
    return "Teller is not configured on this server. The administrator needs to set TELLER_CERT_PATH and TELLER_KEY_PATH.";
  }
  if (err instanceof TellerApiError) {
    return `Teller API error (HTTP ${err.status}): ${err.body.slice(0, 300)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function handleToolCall(
  integrationService: IntegrationService,
  tellerClient: TellerClient,
  token: string,
  userId: string,
  profileId: string,
  toolName: string,
  args: Record<string, unknown>,
) {
  const enrollments = await loadEnrollmentsCached(integrationService, token, userId, profileId);
  if (enrollments.size === 0) {
    return toolResult(
      "No Teller bank connections found. Ask the user to connect a bank in Settings > Integrations.",
      true,
    );
  }

  if (toolName === "teller_list_enrollments") {
    const lines = Array.from(enrollments.values()).map((c) =>
      `- enrollment_id: ${c.enrollment_id} | institution: ${c.institution_name ?? c.institution_id ?? "unknown"}${c.enrolled_at ? ` | linked: ${c.enrolled_at}` : ""}`,
    );
    return toolResult(`Enrollments (${lines.length}):\n${lines.join("\n")}`);
  }

  const enrollmentId = args.enrollment_id as string | undefined;
  if (!enrollmentId) return toolResult("Missing required parameter: enrollment_id", true);

  const cfg = enrollments.get(enrollmentId);
  if (!cfg) {
    return toolResult(
      `No enrollment found with id '${enrollmentId}' for this user. Use teller_list_enrollments to see available enrollments.`,
      true,
    );
  }

  try {
    switch (toolName) {
      case "teller_list_accounts": {
        const accounts = await tellerClient.listAccounts(cfg.access_token);
        if (accounts.length === 0) return toolResult("No accounts in this enrollment.");
        const formatted = accounts.map((a) =>
          [
            `account_id: ${a.id}`,
            `name: ${a.name}`,
            `type: ${a.type} (${a.subtype})`,
            `currency: ${a.currency}`,
            a.last_four ? `last_four: ${a.last_four}` : null,
            `institution: ${a.institution.name}`,
            `status: ${a.status}`,
          ].filter(Boolean).join("\n"),
        );
        return toolResult(`Accounts (${accounts.length}):\n\n${formatted.join("\n---\n")}`);
      }

      case "teller_get_balance": {
        const accountId = args.account_id as string | undefined;
        if (!accountId) return toolResult("Missing required parameter: account_id", true);
        const b = await tellerClient.getBalance(cfg.access_token, accountId);
        return toolResult(
          `Balance for ${accountId}:\n  available: ${b.available}\n  ledger:    ${b.ledger}`,
        );
      }

      case "teller_list_transactions": {
        const accountId = args.account_id as string | undefined;
        if (!accountId) return toolResult("Missing required parameter: account_id", true);
        const count = typeof args.count === "number" ? Math.min(Math.max(args.count, 1), 250) : 50;
        const fromId = typeof args.from_id === "string" ? args.from_id : undefined;
        const txs = await tellerClient.listTransactions(cfg.access_token, accountId, { count, fromId });
        if (txs.length === 0) return toolResult("No transactions found.");
        const lines = txs.map((t) => {
          const cat = t.details?.category ? ` [${t.details.category}]` : "";
          const cp = t.details?.counterparty?.name ? ` ← ${t.details.counterparty.name}` : "";
          return `${t.date} | ${t.amount.padStart(10)} | ${t.status.padEnd(7)} | ${t.description}${cat}${cp} | id=${t.id}`;
        });
        return toolResult(`Transactions (${txs.length}):\n${lines.join("\n")}`);
      }

      case "teller_get_account_details": {
        const accountId = args.account_id as string | undefined;
        if (!accountId) return toolResult("Missing required parameter: account_id", true);
        const d = await tellerClient.getAccountDetails(cfg.access_token, accountId);
        const lines: string[] = [`account_id: ${d.account_id}`];
        if (d.account_number) lines.push(`account_number: ${d.account_number}`);
        if (d.routing_numbers?.ach) lines.push(`routing (ACH):  ${d.routing_numbers.ach}`);
        if (d.routing_numbers?.wire) lines.push(`routing (wire): ${d.routing_numbers.wire}`);
        return toolResult(lines.join("\n"));
      }

      default:
        return toolResult(`Unknown tool: ${toolName}`, true);
    }
  } catch (err) {
    return toolResult(summarizeError(err), true);
  }
}

export const tellerMcpPlugin = fp(
  async (server: FastifyInstance, opts: TellerMcpOptions) => {
    const { integrationService, tellerClient, resolveSession } = opts;

    server.post("/mcp/teller", async (request, reply) => {
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

      const { userId, profileId } = session;

      switch (body.method) {
        case "initialize":
          return reply.send(
            rpcResult(id, {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "vonzio-teller", version: "1.0.0" },
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
            const result = await handleToolCall(
              integrationService,
              tellerClient,
              token,
              userId,
              profileId,
              params.name,
              params.arguments ?? {},
            );
            return reply.send(rpcResult(id, result));
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            server.log.error({ err, tool: params.name }, "Teller MCP tool call failed");
            return reply.send(rpcResult(id, toolResult(message, true)));
          }
        }
        default:
          return reply.send(rpcError(id, -32601, `Method not found: ${body.method}`));
      }
    });
  },
  { name: "teller-mcp" },
);
