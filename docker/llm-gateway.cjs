/**
 * LLM gateway — lets the Claude Agent SDK (which speaks the Anthropic Messages
 * API) talk to an OpenAI-compatible Chat Completions endpoint.
 *
 * The SDK only knows how to POST /v1/messages in Anthropic wire format. OpenAI
 * (and any OpenAI-compatible server) speaks /v1/chat/completions in a different
 * shape. This gateway runs inside the agent container on 127.0.0.1 and
 * translates request + response (including SSE streaming and tool calls) in
 * both directions.
 *
 * Modes (LLM_GATEWAY_MODE):
 *   - "openai"      translate Anthropic Messages <-> OpenAI Chat Completions
 *   - "passthrough" forward verbatim, only rewriting x-api-key -> Bearer
 *                   (the legacy ollama-proxy behavior; kept for completeness)
 *
 * Env:
 *   LLM_GATEWAY_MODE        "openai" | "passthrough"   (default "openai")
 *   LLM_GATEWAY_TARGET_URL  upstream base URL          (default https://api.openai.com)
 *   LLM_GATEWAY_PORT        local listen port          (default 11434)
 *
 * The pure translation functions are exported for unit testing; the HTTP server
 * only starts when this file is run directly. Delete this file to remove
 * OpenAI-compatible support.
 */
const http = require("http");
const https = require("https");

// ---------------------------------------------------------------------------
// Request translation: Anthropic Messages -> OpenAI Chat Completions
// ---------------------------------------------------------------------------

/** Flatten an Anthropic `system` field (string | block[]) into one string. */
function systemToText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n\n");
  }
  return "";
}

/** Anthropic content (string | block[]) -> OpenAI message(s). */
function translateMessage(msg, out) {
  const role = msg.role;
  const content = msg.content;

  if (typeof content === "string") {
    out.push({ role, content });
    return;
  }
  if (!Array.isArray(content)) return;

  // tool_result blocks (user turn) become standalone OpenAI {role:"tool"} msgs.
  const toolResults = content.filter((b) => b && b.type === "tool_result");
  const toolUses = content.filter((b) => b && b.type === "tool_use");
  const textParts = content.filter((b) => b && b.type === "text");
  const imageParts = content.filter((b) => b && b.type === "image");

  if (role === "assistant") {
    const assistant = { role: "assistant" };
    const text = textParts.map((b) => b.text).join("");
    if (text) assistant.content = text;
    if (toolUses.length > 0) {
      assistant.tool_calls = toolUses.map((b) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      if (!assistant.content) assistant.content = null;
    }
    out.push(assistant);
    return;
  }

  // user turn: emit any tool_results first (OpenAI requires them right after the
  // assistant tool_calls turn), then the user text/images.
  for (const tr of toolResults) {
    out.push({
      role: "tool",
      tool_call_id: tr.tool_use_id,
      content: toolResultText(tr.content),
    });
  }

  if (imageParts.length > 0) {
    const parts = [];
    for (const t of textParts) parts.push({ type: "text", text: t.text });
    for (const img of imageParts) {
      const src = img.source || {};
      const url =
        src.type === "url"
          ? src.url
          : `data:${src.media_type};base64,${src.data}`;
      parts.push({ type: "image_url", image_url: { url } });
    }
    out.push({ role: "user", content: parts });
  } else if (textParts.length > 0) {
    out.push({ role: "user", content: textParts.map((b) => b.text).join("") });
  }
}

/** Anthropic tool_result `content` (string | block[]) -> plain string. */
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

/** Anthropic tool_choice -> OpenAI tool_choice. */
function translateToolChoice(tc) {
  if (!tc) return undefined;
  if (tc.type === "auto") return "auto";
  if (tc.type === "any") return "required";
  if (tc.type === "tool" && tc.name) {
    return { type: "function", function: { name: tc.name } };
  }
  return undefined;
}

/** Full Anthropic Messages request body -> OpenAI Chat Completions body. */
function anthropicToOpenAIRequest(body) {
  const messages = [];
  const system = systemToText(body.system);
  if (system) messages.push({ role: "system", content: system });
  for (const m of body.messages || []) translateMessage(m, messages);

  const oa = {
    model: body.model,
    messages,
    stream: !!body.stream,
  };
  // Route the token cap to the field the target model accepts. OpenAI's
  // GPT-5 and o-series reasoning models reject the legacy `max_tokens` and
  // require `max_completion_tokens`; gpt-4* and most OpenAI-compatible
  // servers (vLLM, LM Studio, OpenRouter) only understand `max_tokens`.
  // Anthropic always sends `max_tokens`, so pick by target model family.
  if (body.max_tokens != null) {
    if (/^(o\d|gpt-5)/i.test(body.model || "")) {
      oa.max_completion_tokens = body.max_tokens;
    } else {
      oa.max_tokens = body.max_tokens;
    }
  }
  if (oa.stream) oa.stream_options = { include_usage: true };

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    oa.tools = body.tools
      // skip Anthropic server-tool shapes that have no OpenAI analogue
      .filter((t) => t && t.name && (t.input_schema || t.parameters))
      .map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description || "",
          parameters: t.input_schema || t.parameters || { type: "object", properties: {} },
        },
      }));
    const choice = translateToolChoice(body.tool_choice);
    if (choice) oa.tool_choice = choice;
  }

  return oa;
}

// ---------------------------------------------------------------------------
// Response translation: OpenAI -> Anthropic (non-streaming)
// ---------------------------------------------------------------------------

function mapFinishReason(reason) {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "stop":
    default:
      return "end_turn";
  }
}

function openAIToAnthropicResponse(oa, fallbackModel) {
  const choice = (oa.choices && oa.choices[0]) || {};
  const message = choice.message || {};
  const content = [];

  if (message.content) {
    content.push({ type: "text", text: message.content });
  }
  for (const tc of message.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  const usage = oa.usage || {};
  return {
    id: oa.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: oa.model || fallbackModel,
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming translation: OpenAI SSE chunks -> Anthropic SSE events
// ---------------------------------------------------------------------------

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Stateful translator. Feed it parsed OpenAI stream chunk objects via push();
 * call end() when the OpenAI stream finishes ([DONE]). Both return an array of
 * Anthropic SSE strings ready to write to the client.
 */
function makeStreamTranslator(model) {
  let started = false;
  let nextIndex = 0;
  let textOpen = false;
  let textIndex = -1;
  const toolByOaIndex = new Map(); // openai tool_call index -> {anthIndex}
  let finishReason = null;
  let usage = null;
  const id = `msg_${Date.now()}`;

  function start(out) {
    if (started) return;
    started = true;
    out.push(
      sse("message_start", {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    );
  }

  function closeOpenBlock(out) {
    if (textOpen) {
      out.push(sse("content_block_stop", { type: "content_block_stop", index: textIndex }));
      textOpen = false;
      textIndex = -1;
    }
  }

  function push(chunk) {
    const out = [];
    start(out);
    const choice = (chunk.choices && chunk.choices[0]) || {};
    const delta = choice.delta || {};
    if (chunk.usage) usage = chunk.usage;

    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (!textOpen) {
        textIndex = nextIndex++;
        textOpen = true;
        out.push(
          sse("content_block_start", {
            type: "content_block_start",
            index: textIndex,
            content_block: { type: "text", text: "" },
          }),
        );
      }
      out.push(
        sse("content_block_delta", {
          type: "content_block_delta",
          index: textIndex,
          delta: { type: "text_delta", text: delta.content },
        }),
      );
    }

    for (const tc of delta.tool_calls || []) {
      const oaIndex = tc.index ?? 0;
      let entry = toolByOaIndex.get(oaIndex);
      if (!entry) {
        closeOpenBlock(out);
        const anthIndex = nextIndex++;
        entry = { anthIndex };
        toolByOaIndex.set(oaIndex, entry);
        out.push(
          sse("content_block_start", {
            type: "content_block_start",
            index: anthIndex,
            content_block: {
              type: "tool_use",
              id: tc.id || `toolu_${Date.now()}_${oaIndex}`,
              name: tc.function?.name || "",
              input: {},
            },
          }),
        );
      }
      const args = tc.function?.arguments;
      if (typeof args === "string" && args.length > 0) {
        out.push(
          sse("content_block_delta", {
            type: "content_block_delta",
            index: entry.anthIndex,
            delta: { type: "input_json_delta", partial_json: args },
          }),
        );
      }
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
    return out;
  }

  function end() {
    const out = [];
    start(out);
    closeOpenBlock(out);
    for (const entry of toolByOaIndex.values()) {
      out.push(sse("content_block_stop", { type: "content_block_stop", index: entry.anthIndex }));
    }
    out.push(
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: mapFinishReason(finishReason), stop_sequence: null },
        usage: {
          input_tokens: usage?.prompt_tokens ?? 0,
          output_tokens: usage?.completion_tokens ?? 0,
        },
      }),
    );
    out.push(sse("message_stop", { type: "message_stop" }));
    return out;
  }

  return { push, end };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const TARGET = process.env.LLM_GATEWAY_TARGET_URL || "https://api.openai.com";
const MODE = process.env.LLM_GATEWAY_MODE || "openai";
const PORT = parseInt(process.env.LLM_GATEWAY_PORT || "11434", 10);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function upstreamRequest(method, url, headers, bodyBuf) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const r = lib.request(
      url,
      { method, headers: { ...headers, host: u.host } },
      (res) => resolve(res),
    );
    r.on("error", reject);
    if (bodyBuf) r.write(bodyBuf);
    r.end();
  });
}

async function handleOpenAI(req, res) {
  const apiKey = req.headers["x-api-key"] || "";
  const auth = apiKey ? `Bearer ${apiKey}` : req.headers["authorization"] || "";

  // /v1/messages -> /v1/chat/completions (the translated path)
  if (req.method === "POST" && req.url.startsWith("/v1/messages") && !req.url.includes("count_tokens")) {
    const raw = await readBody(req);
    let anthropicBody;
    try {
      anthropicBody = JSON.parse(raw.toString("utf8"));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad json" } }));
      return;
    }
    const wantStream = !!anthropicBody.stream;
    const oaBody = Buffer.from(JSON.stringify(anthropicToOpenAIRequest(anthropicBody)));
    const upstream = await upstreamRequest(
      "POST",
      `${TARGET}/v1/chat/completions`,
      { authorization: auth, "content-type": "application/json", "content-length": Buffer.byteLength(oaBody) },
      oaBody,
    );

    if (upstream.statusCode >= 400) {
      // surface the upstream error body as-is (helps debugging in the UI)
      res.writeHead(upstream.statusCode, { "content-type": "application/json" });
      upstream.pipe(res);
      return;
    }

    if (wantStream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const tr = makeStreamTranslator(anthropicBody.model);
      let buf = "";
      // [DONE] arrives mid-stream, but the upstream socket still fires "end"
      // afterward. Without this guard both paths flush tr.end() + res.end(),
      // re-writing message_delta/message_stop to an already-ended response
      // (ERR_STREAM_WRITE_AFTER_END). finish() makes teardown happen once.
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        for (const ev of tr.end()) res.write(ev);
        res.end();
      };
      upstream.on("data", (chunk) => {
        if (finished) return;
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (payload === "[DONE]") {
            finish();
            upstream.destroy();
            return;
          }
          try {
            const obj = JSON.parse(payload);
            for (const ev of tr.push(obj)) res.write(ev);
          } catch {
            /* ignore keep-alive / partial lines */
          }
        }
      });
      upstream.on("end", finish);
      upstream.on("error", () => { if (!finished) { finished = true; res.end(); } });
      return;
    }

    // non-streaming
    const respBuf = await readAll(upstream);
    let oaResp;
    try {
      oaResp = JSON.parse(respBuf.toString("utf8"));
    } catch {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "bad upstream json" } }));
      return;
    }
    const anthropicResp = JSON.stringify(openAIToAnthropicResponse(oaResp, anthropicBody.model));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(anthropicResp);
    return;
  }

  // count_tokens has no OpenAI equivalent — return a cheap char/4 estimate so
  // the SDK's context bookkeeping doesn't break.
  if (req.method === "POST" && req.url.includes("count_tokens")) {
    const raw = await readBody(req);
    let estimate = 0;
    try {
      estimate = Math.ceil(raw.toString("utf8").length / 4);
    } catch {
      estimate = 0;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: estimate }));
    return;
  }

  // Everything else (e.g. GET /v1/models): forward with auth rewrite.
  const raw = req.method === "POST" ? await readBody(req) : undefined;
  const upstream = await upstreamRequest(
    req.method,
    `${TARGET}${req.url}`,
    { authorization: auth, "content-type": req.headers["content-type"] || "application/json" },
    raw,
  );
  res.writeHead(upstream.statusCode, upstream.headers);
  upstream.pipe(res);
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function handlePassthrough(req, res) {
  const apiKey = req.headers["x-api-key"] || "";
  const headers = { ...req.headers, authorization: `Bearer ${apiKey}`, host: new URL(TARGET).hostname };
  delete headers["x-api-key"];
  const lib = new URL(TARGET).protocol === "https:" ? https : http;
  const proxyReq = lib.request(`${TARGET}${req.url}`, { method: req.method, headers }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (e) => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: e.message }));
  });
  req.pipe(proxyReq);
}

function startServer() {
  const server = http.createServer((req, res) => {
    const handler = MODE === "passthrough" ? handlePassthrough : handleOpenAI;
    Promise.resolve(handler(req, res)).catch((e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(e && e.message || e) } }));
    });
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") process.exit(0); // already running for this container
    throw e;
  });
  server.listen(PORT, "127.0.0.1", () => {
    process.stdout.write(`llm-gateway (${MODE}) listening on 127.0.0.1:${PORT} -> ${TARGET}\n`);
  });
}

module.exports = {
  anthropicToOpenAIRequest,
  openAIToAnthropicResponse,
  makeStreamTranslator,
  systemToText,
  translateToolChoice,
  mapFinishReason,
};

if (require.main === module) startServer();
