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
// MOCK_SCENARIO=docx turns the mock into a two-turn scripted agent for the
// document-preview e2e (#368): turn 1 emits a Bash tool_use that creates a
// real docx in the workspace (python3-docx is baked into the agent image);
// turn 2 (recognized by a tool_result in the conversation) announces the
// path so the dashboard's auto-open fires. Default: single canned text turn.
const SCENARIO = process.env.MOCK_SCENARIO || "text";
const DOCX_PATH = "/workspace/E2E_Report.docx";
const DOCX_CMD =
  "python3 -c \"from docx import Document; d=Document(); d.add_heading('E2E Report',0); " +
  `d.add_paragraph('Generated during e2e.'); d.save('${DOCX_PATH}'); print('saved ${DOCX_PATH}')"`;

/** Decide this turn's content blocks + stop_reason from the conversation. */
function planReply(parsed) {
  if (SCENARIO === "docx") {
    // Only the agent loop sends tool definitions; auxiliary calls that share
    // this mock (e.g. server-side title generation) must get plain text —
    // a tool_use block would break their content[0].text parsing.
    if (!Array.isArray(parsed.tools) || parsed.tools.length === 0) {
      return { blocks: [{ type: "text", text: REPLY }], stop_reason: "end_turn" };
    }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const sawToolResult = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b && b.type === "tool_result")
    );
    if (!sawToolResult) {
      return {
        blocks: [{
          type: "tool_use",
          id: "toolu_e2e_docx_1",
          name: "Bash",
          input: { command: DOCX_CMD },
        }],
        stop_reason: "tool_use",
      };
    }
    return {
      blocks: [{ type: "text", text: `Your report is ready: ${DOCX_PATH}` }],
      stop_reason: "end_turn",
    };
  }
  return { blocks: [{ type: "text", text: REPLY }], stop_reason: "end_turn" };
}

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

function streamAnthropic(res, plan) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const ev = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  ev("message_start", { type: "message_start", message: messageObject({}) });
  plan.blocks.forEach((block, index) => {
    if (block.type === "tool_use") {
      ev("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      ev("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    } else {
      ev("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      ev("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      });
    }
    ev("content_block_stop", { type: "content_block_stop", index });
  });
  ev("message_delta", {
    type: "message_delta",
    delta: { stop_reason: plan.stop_reason, stop_sequence: null },
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
      const plan = planReply(parsed);
      if (parsed.stream) return streamAnthropic(res, plan);
      return sendJson(
        res,
        200,
        messageObject({
          content: plan.blocks,
          stop_reason: plan.stop_reason,
          usage: { input_tokens: 1, output_tokens: 4 },
        })
      );
    }

    log("UNHANDLED", req.method, req.url);
    sendJson(res, 404, { type: "error", error: { type: "not_found_error", message: req.url } });
  });
});

server.listen(PORT, "0.0.0.0", () => log(`listening on 0.0.0.0:${PORT}, model=${MODEL}`));
