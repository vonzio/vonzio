/**
 * The byok modes: a /v1/messages request becomes one `chat()` turn against
 * the connection the env describes; the turn's events are written back as
 * Anthropic SSE as they arrive (or folded into one response for a
 * non-streaming call).
 */
import type http from "node:http";
import { chat, type Connection } from "@amenophis1er/byok/core";
import { accountIdFromJwt, OPENCODE_BASE } from "@amenophis1er/byok/core/auth";
import { anthropicToChatRequest, type AnthropicRequest } from "./translate.js";
import { AnthropicStream, errorStatus, foldResult, frame } from "./sse.js";
import { substituteClaudeModel } from "./model.js";

export interface ByokModeOptions {
  mode: "openai" | "codex" | "opencode";
  /** openai / opencode: the API root (`…/v1`). */
  target: string;
  /** codex: fallback chatgpt-account-id when the token carries none. */
  codexAccountId?: string;
  /** opencode: the organization the token was issued for (x-opencode-org-id). */
  opencodeOrgId?: string;
}

/** What a third-party client gets from OpenCode on its free tier. */
export const OPENCODE_FREE_TIER =
  "OpenCode's free tier only works in OpenCode's own apps; a paid plan is needed.";

/** The byok connection for a request's credential. */
export function connectionFor(opts: ByokModeOptions, credential: string): Connection {
  if (opts.mode === "opencode") {
    // byok picks each model's protocol from `issuer` (Claude on Messages, GPT
    // on Responses, Gemini on the Gemini API, the rest on Chat Completions),
    // retrying on the next one when OpenCode answers a protocol mismatch.
    return {
      kind: "openai-compatible",
      baseUrl: opts.target || OPENCODE_BASE,
      auth: "oauth",
      issuer: "opencode",
      ...(opts.opencodeOrgId ? { orgId: opts.opencodeOrgId } : {}),
    };
  }
  if (opts.mode === "codex") {
    return {
      kind: "chatgpt",
      baseUrl: "",
      // Decoded per request, not at boot: a reused container that switches
      // between two ChatGPT accounts must send the id matching the CURRENT token.
      accountId: accountIdFromJwt(credential) || opts.codexAccountId || undefined,
    };
  }
  return { kind: "openai-compatible", baseUrl: opts.target };
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendError(res: http.ServerResponse, status: number, type: string, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

/** A failed turn's message as the SDK should see it. OpenCode's free tier
 *  answers 403 to any client but its own: say so instead of a bare 403. The
 *  "HTTP 403" prefix stays so errorStatus keeps the status. */
export function turnError(opts: Pick<ByokModeOptions, "mode">, error: string | undefined): string {
  const message = error ?? "model call failed";
  if (opts.mode === "opencode" && /^HTTP 403\b/.test(message)) return `HTTP 403: ${OPENCODE_FREE_TIER}`;
  return message;
}

let warnedToolChoice = false;

export async function handleByok(req: http.IncomingMessage, res: http.ServerResponse, opts: ByokModeOptions): Promise<void> {
  const url = req.url ?? "/";

  // count_tokens has no equivalent outside Anthropic: a cheap char/4 estimate
  // keeps the SDK's context bookkeeping working.
  if (req.method === "POST" && url.includes("count_tokens")) {
    const raw = await readBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: Math.ceil(raw.toString("utf8").length / 4) }));
    return;
  }

  if (!(req.method === "POST" && url.startsWith("/v1/messages"))) {
    sendError(res, 404, "not_found_error", "unsupported route");
    return;
  }

  const raw = await readBody(req);
  let body: AnthropicRequest;
  try {
    body = JSON.parse(raw.toString("utf8")) as AnthropicRequest;
  } catch {
    sendError(res, 400, "invalid_request_error", "bad json");
    return;
  }

  const apiKey = req.headers["x-api-key"];
  const credential = (Array.isArray(apiKey) ? apiKey[0] : apiKey)
    || String(req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
  const model = substituteClaudeModel(body.model);
  const request = anthropicToChatRequest(body);
  if (body.tool_choice && body.tool_choice.type !== "auto" && !warnedToolChoice) {
    warnedToolChoice = true;
    console.log(`[llm-gateway] tool_choice '${body.tool_choice.type}' is not forwarded; the model chooses`);
  }
  const conn = connectionFor(opts, credential);

  // The client went away: stop the model (the sink's throw fails the turn).
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });

  if (!body.stream) {
    const result = await chat(conn, credential, { ...request, model }, { signal: controller.signal, timeoutMs: TURN_TIMEOUT_MS });
    if (!result.ok) {
      const message = turnError(opts, result.error);
      const { status, type } = errorStatus(message);
      sendError(res, status, type, message);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(foldResult(result, model)));
    return;
  }

  const stream = new AnthropicStream(model, (chunk) => {
    if (!res.headersSent) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    }
    res.write(chunk);
  });
  const result = await chat(conn, credential, { ...request, model }, {
    signal: controller.signal,
    timeoutMs: TURN_TIMEOUT_MS,
    onEvent: (event) => {
      if (res.destroyed) throw new Error("client disconnected");
      stream.push(event);
    },
  });
  if (res.destroyed) return;
  if (!result.ok) {
    const message = turnError(opts, result.error);
    if (!stream.hasStarted) {
      // Nothing was written: the SDK gets a proper HTTP error (401/429/… keep
      // their status so it reports them the way it would from Anthropic).
      const { status, type } = errorStatus(message);
      sendError(res, status, type, message);
      return;
    }
    stream.fail(message);
    res.end();
    return;
  }
  stream.end(result);
  res.end();
}

/** An agent turn can run long (large tool catalogs, slow local models). */
const TURN_TIMEOUT_MS = Number(process.env.LLM_GATEWAY_TURN_TIMEOUT_MS || 10 * 60_000);

export { frame };
