/**
 * Passthrough: forward the SDK's Anthropic Messages request to an upstream
 * that speaks the same API.
 *
 * - `ollama`: Ollama Cloud serves /v1/messages natively but wants
 *   `Authorization: Bearer`, not `x-api-key`, and rejects an image nested in a
 *   tool_result. The body is fixed up and the auth rewritten.
 * - `passthrough` with LLM_GATEWAY_PASSTHROUGH_RAW=1: the client's own headers
 *   are kept (the upstream IS api.anthropic.com). Used when egress enforcement
 *   forces a native-Anthropic agent through the gateway purely to reach the
 *   proxy. The body is not touched.
 */
import type http from "node:http";
import { makeUpstreamReq } from "./proxy.js";
import { substituteClaudeModel } from "./model.js";

// Hop-by-hop headers (RFC 7230 §6.1) must not be blindly forwarded upstream:
// a client-controlled Transfer-Encoding/Connection enables request smuggling,
// and a stray proxy-authorization would leak the proxy token to the provider.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

export interface PassthroughOptions {
  target: string;
  /** Keep the client's auth headers instead of rewriting x-api-key → Bearer. */
  raw: boolean;
}

type AnthropicBlock = { type?: string; text?: string; content?: unknown; [k: string]: unknown };
type AnthropicMessage = { role?: string; content?: string | AnthropicBlock[] };

/**
 * Ollama's /v1/messages rejects an image block nested inside a tool_result
 * ("Input should be a valid string"), unlike the real Anthropic API, which
 * the Claude Agent SDK targets (its Read tool returns an image as tool_result
 * content). Relocate any such image OUT of the tool_result (leaving a text
 * placeholder) and append it to the SAME user message as a normal image
 * block. Returns true if anything changed.
 */
export function relocateToolResultImages(body: { messages?: AnthropicMessage[] } | null | undefined): boolean {
  if (!body || !Array.isArray(body.messages)) return false;
  let changed = false;
  for (const msg of body.messages) {
    if (!msg || msg.role !== "user" || !Array.isArray(msg.content)) continue;
    const relocated: AnthropicBlock[] = [];
    for (const block of msg.content) {
      if (!block || block.type !== "tool_result" || !Array.isArray(block.content)) continue;
      const parts = block.content as AnthropicBlock[];
      const images = parts.filter((b) => b && b.type === "image");
      if (images.length === 0) continue;
      const text = parts.filter((b) => b && b.type === "text").map((b) => b.text ?? "").join("\n");
      block.content = (text ? text + "\n" : "") + `[${images.length} image(s) from this tool result are attached below]`;
      relocated.push(...images);
      changed = true;
    }
    if (relocated.length > 0) {
      msg.content.push({ type: "text", text: "Image(s) from the tool result above:" }, ...relocated);
    }
  }
  return changed;
}

/** The body rewrites a non-raw passthrough applies to a /v1/messages request. */
export function rewriteMessagesBody(raw: Buffer): Buffer {
  try {
    const json = JSON.parse(raw.toString("utf8")) as { model?: string; messages?: AnthropicMessage[] };
    let changed = relocateToolResultImages(json);
    const model = substituteClaudeModel(json.model);
    if (model !== (json.model || "")) {
      json.model = model;
      changed = true;
    }
    return changed ? Buffer.from(JSON.stringify(json), "utf8") : raw;
  } catch {
    return raw; // not JSON: forward the original bytes unchanged
  }
}

function forward(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: string,
  headers: Record<string, string | string[] | number | undefined>,
  body: Buffer | null,
): void {
  const hdrs = { ...headers };
  if (body != null) {
    hdrs["content-length"] = body.byteLength;
    delete hdrs["transfer-encoding"];
  }
  const upstream = makeUpstreamReq(req.method ?? "GET", url, hdrs, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: e.message } }));
  });
  if (body != null) upstream.end(body);
  else req.pipe(upstream);
}

export function handlePassthrough(req: http.IncomingMessage, res: http.ServerResponse, opts: PassthroughOptions): void {
  const headers: Record<string, string | string[] | number | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (key !== "host" && !HOP_BY_HOP.has(key)) headers[key] = v;
  }
  if (!opts.raw) {
    const apiKey = req.headers["x-api-key"] || "";
    headers.authorization = `Bearer ${apiKey}`;
    delete headers["x-api-key"];
  }
  const url = `${opts.target.replace(/\/+$/, "")}${req.url ?? "/"}`;

  const isMessages = !opts.raw && req.method === "POST" && (req.url ?? "").startsWith("/v1/messages")
    && !(req.url ?? "").includes("count_tokens");
  if (!isMessages) {
    forward(req, res, url, headers, null);
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("error", () => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "request stream error" } }));
  });
  req.on("end", () => forward(req, res, url, headers, rewriteMessagesBody(Buffer.concat(chunks))));
}
