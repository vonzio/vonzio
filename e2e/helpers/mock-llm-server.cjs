/**
 * Mock LLM endpoint for the E2E chat test — runs as a container on
 * vonzio-network so both core-server (model list) and the agent container
 * (via the in-container ollama-proxy) can reach it by DNS.
 *
 * The agent uses @anthropic-ai/claude-agent-sdk, so the chat path speaks the
 * ANTHROPIC Messages API. The ollama-proxy is a dumb pass-through (it only
 * swaps x-api-key→Bearer), so requests arrive here unchanged. We implement:
 *
 *   GET  /v1/models               OpenAI-shaped list — core-server's
 *                                 fetchOllamaModels() hits this to populate the
 *                                 model picker and to validate the credential.
 *   POST /v1/messages             Anthropic Messages API — streaming (SSE) and
 *                                 non-streaming. Returns a single canned text
 *                                 turn with stop_reason end_turn so the agent
 *                                 loop terminates immediately (no tool use).
 *   POST /v1/messages/count_tokens  the SDK may pre-count; return a constant.
 *
 * Everything is logged to stdout (visible via `docker compose logs mock-llm`)
 * so the mock can be iterated against whatever the real SDK actually sends.
 */
"use strict";
const http = require("http");

const PORT = parseInt(process.env.PORT || "8080", 10);
const MODEL = process.env.MOCK_MODEL || "mock-model";
const REPLY = process.env.MOCK_REPLY || "E2E pong";

function log(...a) {
  process.stdout.write(`[mock-llm] ${a.join(" ")}\n`);
}

function sendJson(res, code, body) {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

function messageObject(extra) {
  return {
    id: "msg_e2e_mock",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...extra,
  };
}

function streamAnthropic(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const ev = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  ev("message_start", { type: "message_start", message: messageObject({}) });
  ev("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  ev("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: REPLY },
  });
  ev("content_block_stop", { type: "content_block_stop", index: 0 });
  ev("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 4 },
  });
  ev("message_stop", { type: "message_stop" });
  res.end();
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    log(req.method, req.url, `(${body.length}b)`);

    // OpenAI-shaped model list (core-server fetchOllamaModels).
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      return sendJson(res, 200, {
        object: "list",
        data: [{ id: MODEL, object: "model", owned_by: "vonzio-e2e" }],
      });
    }

    // Anthropic token pre-count (best-effort; the SDK may or may not call it).
    if (req.method === "POST" && req.url.startsWith("/v1/messages/count_tokens")) {
      return sendJson(res, 200, { input_tokens: 1 });
    }

    // Anthropic Messages API.
    if (req.method === "POST" && req.url.startsWith("/v1/messages")) {
      let parsed = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch (_) {
        /* canned reply regardless */
      }
      if (parsed.stream) return streamAnthropic(res);
      return sendJson(
        res,
        200,
        messageObject({
          content: [{ type: "text", text: REPLY }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 4 },
        })
      );
    }

    log("UNHANDLED", req.method, req.url);
    sendJson(res, 404, { type: "error", error: { type: "not_found_error", message: req.url } });
  });
});

server.listen(PORT, "0.0.0.0", () => log(`listening on 0.0.0.0:${PORT}, model=${MODEL}`));
