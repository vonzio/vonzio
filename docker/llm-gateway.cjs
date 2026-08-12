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
 *   - "codex"       translate Anthropic Messages <-> OpenAI RESPONSES API,
 *                   against the ChatGPT Codex backend (subscription OAuth)
 *   - "passthrough" forward verbatim, only rewriting x-api-key -> Bearer
 *                   (the legacy ollama-proxy behavior; kept for completeness)
 *
 * Env:
 *   LLM_GATEWAY_MODE        "openai" | "codex" | "passthrough"  (default "openai")
 *   LLM_GATEWAY_TARGET_URL  upstream base URL          (default https://api.openai.com;
 *                           codex default https://chatgpt.com/backend-api)
 *   LLM_GATEWAY_PORT        local listen port          (default 11434)
 *   CODEX_ACCOUNT_ID        ChatGPT account id header  (codex mode)
 *   CODEX_ORIGINATOR        originator header          (codex mode, default "vonzio")
 *
 * The pure translation functions are exported for unit testing; the HTTP server
 * only starts when this file is run directly. Delete this file to remove
 * OpenAI-compatible support.
 */
const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");

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
  // The model-family regex is only a FIRST-GUESS hint — what the provider
  // actually accepts is learned from its 400s (applyCapabilityFix) and
  // cached, so a mis-guess costs one request, once, per daemon lifetime.
  const caps = capsFor(body.model);
  if (body.max_tokens != null) {
    const tokenParam = caps.tokenParam
      || (/^(o\d|gpt-5)/i.test(body.model || "") ? "max_completion_tokens" : "max_tokens");
    oa[tokenParam] = body.max_tokens;
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

    // gpt-5.x reasoning models on /v1/chat/completions DEFAULT reasoning_effort
    // to a non-none level and then reject it in combination with function
    // tools ("Function tools with reasoning_effort are not supported … use
    // /v1/responses or set reasoning_effort to 'none'"). The SDK always sends
    // tools, so without this every agent turn 400s. Working tools beat hidden
    // reasoning until this mode speaks the Responses API (issue #349). The
    // regex is a first-guess hint; learned capabilities override it in both
    // directions (a server that rejects the param entirely gets it removed).
    if (!caps.noReasoningEffortParam
        && (caps.reasoningEffortNone || /^gpt-5/i.test(body.model || ""))) {
      oa.reasoning_effort = "none";
    }
  }

  return oa;
}

// ---------------------------------------------------------------------------
// Learned per-model capabilities
//
// Model-name regexes only PREDICT provider behavior; the provider's own 400s
// are the authoritative capability signal (a rename like gpt-6, or the same
// model behind OpenRouter's "openai/…" alias, silently defeats any regex).
// So: send the natural request first, and when the provider rejects it with a
// recognizable capability error, learn the fact, adjust, and retry — cached
// per model for the daemon's lifetime so each capability costs at most one
// failed request. Same philosophy as the adaptive tool trim below.
// ---------------------------------------------------------------------------

const modelCaps = new Map(); // model id -> { tokenParam?, reasoningEffortNone?, noReasoningEffortParam? }
function capsFor(model) {
  let c = modelCaps.get(model || "");
  if (!c) {
    // Defensive bound: model ids come from the client, so pathological unique
    // ids could grow this forever. Losing learned facts just re-learns them.
    if (modelCaps.size >= 200) modelCaps.clear();
    c = {}; modelCaps.set(model || "", c);
  }
  return c;
}

/** Inspect a 4xx error body for a KNOWN capability complaint; if found, learn
 *  it (cache) and mutate `oa` accordingly. Returns a log line, or null when
 *  the error isn't a capability we understand. Every branch changes `oa` in a
 *  way that makes the same complaint impossible on the retry, so the caller's
 *  retry loop can't spin. */
function applyCapabilityFix(oa, errText) {
  const caps = capsFor(oa.model);

  // NB: every matcher requires rejection keywords or remedy phrasing IN
  // PROXIMITY to the parameter name — a plain substring test would let any
  // 400 whose body merely echoes these words (validation details, content
  // filters, proxies quoting the request) poison the cache permanently.

  // Tools + reasoning_effort unsupported on chat/completions (gpt-5 family):
  // "Function tools with reasoning_effort are not supported … set
  // reasoning_effort to 'none'".
  if (/(tools[\s\S]{0,60}reasoning_effort|reasoning_effort[\s\S]{0,60}tools|set reasoning_effort to '?none'?)/i.test(errText)
      && oa.reasoning_effort !== "none" && Array.isArray(oa.tools) && oa.tools.length > 0) {
    caps.reasoningEffortNone = true;
    oa.reasoning_effort = "none";
    return `model '${oa.model}' rejects tools+reasoning_effort — pinned reasoning_effort=none`;
  }

  // The opposite failure: a server that doesn't know the param at all (or an
  // o-series model that rejects the value "none" our hint pinned). Remove it.
  if (/(unsupported|not supported|unrecognized|unknown|unexpected|invalid|extra)[^.]{0,40}reasoning_effort|reasoning_effort[^.]{0,40}(unsupported|not supported|unrecognized|unknown|unexpected|invalid)/i.test(errText)
      && oa.reasoning_effort !== undefined) {
    caps.noReasoningEffortParam = true;
    caps.reasoningEffortNone = false;
    delete oa.reasoning_effort;
    return `model '${oa.model}' rejects the reasoning_effort param — removed`;
  }

  // Reasoning models: "Unsupported parameter: 'max_tokens' … use
  // 'max_completion_tokens' instead."
  if (/(max_tokens[\s\S]{0,80}max_completion_tokens|use ['"]?max_completion_tokens)/i.test(errText)
      && oa.max_tokens != null) {
    caps.tokenParam = "max_completion_tokens";
    oa.max_completion_tokens = oa.max_tokens;
    delete oa.max_tokens;
    return `model '${oa.model}' wants max_completion_tokens`;
  }

  // The reverse: an OpenAI-compatible server (vLLM/LM Studio) that only knows
  // the legacy field, serving a model whose NAME matched the reasoning hint.
  if (/(unsupported|not supported|unrecognized|unknown|unexpected|invalid|extra)[^.]{0,40}max_completion_tokens|max_completion_tokens[^.]{0,40}(unsupported|not supported|unrecognized|unknown|unexpected|invalid)/i.test(errText)
      && oa.max_completion_tokens != null) {
    caps.tokenParam = "max_tokens";
    oa.max_tokens = oa.max_completion_tokens;
    delete oa.max_completion_tokens;
    return `model '${oa.model}' wants legacy max_tokens`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Adaptive tool trimming
//
// The Claude Agent SDK advertises its full tool catalog (built-ins + MCP) on
// every request — easily ~20k tokens of OpenAI function schema. Small-context
// OpenAI-compatible models (e.g. an 8k model) reject that before any chat.
// Rather than uniformly stripping tools (which would needlessly cripple large
// models like Grok/GPT-5), we send everything first and only trim when a model
// rejects the request for exceeding its context window — keeping the most
// useful tools and dropping the long tail to fit, then retrying once.
// ---------------------------------------------------------------------------

// Rough token estimate (≈ 4 chars/token) — good enough for budgeting.
function estimateTokens(str) {
  return Math.ceil((str || "").length / 4);
}

// Parse a provider "context length exceeded" error and return the model's
// token limit, or null if this isn't a context-window error. Handles OpenAI's
// "maximum context length is 8192 tokens" plus the generic
// context_length_exceeded code; falls back to a conservative 8192 when the
// error is clearly about context but no number is given.
function parseContextLimit(errText) {
  const text = String(errText || "");
  const m = text.match(/maximum context length is\s+(\d+)/i) || text.match(/context length of\s+(\d+)/i);
  if (m) return parseInt(m[1], 10);
  if (/context_length_exceeded|maximum context|reduce the length of the (?:messages|prompt)/i.test(text)) {
    return 8192;
  }
  return null;
}

// Core built-in tools — the agent's "hands". Kept first when trimming and
// ordered by load-bearingness. NOT an exhaustive built-in list: anything not
// here and not an MCP tool is the droppable long tail (TodoWrite, Task, Web*,
// NotebookEdit, …). MCP tools (mcp__*) are explicitly configured by the
// operator, so they rank ABOVE that long tail (see `rank`).
const TOOL_PRIORITY = ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS"];

// Cap each tool description to this many chars before dropping whole tools —
// most of the ~20k is verbose prose, and a capped description keeps the
// capability while shrinking the schema.
const MAX_TOOL_DESC = 600;

// Make an OpenAI request fit the model's context window, least-destructive
// first: (1) cap verbose tool descriptions, then (2) drop lowest-priority tools
// if still over. Mutates oa. Returns { dropped, changed } — `changed` is true
// whenever anything was modified (so the caller knows a retry is worthwhile,
// even when no whole tool was dropped).
function trimOpenAIToolsToFit(oa, contextLimit) {
  if (!Array.isArray(oa.tools) || oa.tools.length === 0) return { dropped: 0, changed: false };
  const msgTokens = estimateTokens(JSON.stringify(oa.messages || []));
  // Reserve headroom for the model's reply + estimation slop.
  const RESERVE = 1024;
  const budget = Math.max(0, contextLimit - msgTokens - RESERVE);

  // Pass 1 — cap descriptions. Often enough on its own, and keeps every tool.
  let capped = false;
  for (const t of oa.tools) {
    const d = t.function && t.function.description;
    if (typeof d === "string" && d.length > MAX_TOOL_DESC) {
      t.function.description = d.slice(0, MAX_TOOL_DESC) + "…";
      capped = true;
    }
  }
  if (estimateTokens(JSON.stringify(oa.tools)) <= budget) {
    return { dropped: 0, changed: capped };
  }

  // Pass 2 — drop lowest-priority tools. Priority tiers (lower = kept first):
  //   0..N-1  core built-ins (TOOL_PRIORITY) — the agent's hands
  //   N       MCP / operator-configured tools (mcp__*) — deliberate intent
  //   N+1     everything else (generic built-in long tail) — dropped first
  const rank = (t) => {
    const name = (t.function && t.function.name) || "";
    const i = TOOL_PRIORITY.indexOf(name);
    if (i !== -1) return i;
    return name.startsWith("mcp__") ? TOOL_PRIORITY.length : TOOL_PRIORITY.length + 1;
  };
  const annotated = oa.tools.map((t, idx) => ({ t, idx, rank: rank(t), tok: estimateTokens(JSON.stringify(t)) }));
  annotated.sort((a, b) => a.rank - b.rank || a.idx - b.idx);

  const kept = [];
  let used = 0;
  for (const e of annotated) {
    if (used + e.tok <= budget) {
      kept.push(e);
      used += e.tok;
    }
  }
  const dropped = oa.tools.length - kept.length;
  kept.sort((a, b) => a.idx - b.idx); // restore original order among survivors
  if (kept.length === 0) {
    delete oa.tools;
    delete oa.tool_choice;
  } else {
    oa.tools = kept.map((e) => e.t);
    // If tool_choice forces a specific function that we just dropped, the retry
    // would 400 ("tool not found"). Fall back to "auto" in that case.
    const forced = oa.tool_choice && oa.tool_choice.function && oa.tool_choice.function.name;
    if (forced && !oa.tools.some((t) => t.function && t.function.name === forced)) {
      oa.tool_choice = "auto";
    }
  }
  return { dropped, changed: capped || dropped > 0 };
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

// ===========================================================================
// Codex mode: Anthropic Messages <-> OpenAI RESPONSES API (ChatGPT Codex)
//
// A ChatGPT subscription reaches models through the Codex backend
// (https://chatgpt.com/backend-api/codex/responses), which speaks the OpenAI
// *Responses* API — a different request shape AND a different SSE event
// vocabulary than Chat Completions. This is a SECOND translator; the token is a
// ChatGPT OAuth access token (feature 0047), account id + originator ride in as
// env-provided headers.
// ===========================================================================

/** Resolve the Codex responses endpoint from a base URL, mirroring the Codex
 *  CLI: tolerate a base already ending in /codex or /codex/responses. */
function codexResponsesUrl(base) {
  const b = (base || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
  if (b.endsWith("/codex/responses")) return b;
  if (b.endsWith("/codex")) return `${b}/responses`;
  return `${b}/codex/responses`;
}

/** Anthropic content (string | block[]) -> Responses API input item(s). Tool
 *  calls/results become top-level function_call / function_call_output items
 *  (NOT nested in a message), which is how the Responses API represents them. */
function translateMessageToResponses(msg, out) {
  const role = msg.role;
  const content = msg.content;
  const textType = role === "assistant" ? "output_text" : "input_text";

  if (typeof content === "string") {
    if (content) out.push({ role, content: [{ type: textType, text: content }] });
    return;
  }
  if (!Array.isArray(content)) return;

  const parts = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === "text") {
      parts.push({ type: textType, text: b.text || "" });
    } else if (b.type === "image" && role !== "assistant") {
      const src = b.source || {};
      const url = src.type === "url" ? src.url : `data:${src.media_type};base64,${src.data}`;
      parts.push({ type: "input_image", image_url: url });
    } else if (b.type === "tool_use") {
      // Flush any accumulated message parts before the function_call item so
      // ordering (assistant text, then its call) is preserved.
      if (parts.length) { out.push({ role, content: parts.splice(0) }); }
      out.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
    } else if (b.type === "tool_result") {
      if (parts.length) { out.push({ role, content: parts.splice(0) }); }
      out.push({ type: "function_call_output", call_id: b.tool_use_id, output: toolResultText(b.content) });
    }
  }
  if (parts.length) out.push({ role, content: parts });
}

/** Responses API tool_choice from Anthropic tool_choice. */
function translateToolChoiceResponses(tc) {
  if (!tc) return undefined;
  if (tc.type === "auto") return "auto";
  if (tc.type === "any") return "required";
  if (tc.type === "tool" && tc.name) return { type: "function", name: tc.name };
  return undefined;
}

/** Full Anthropic Messages body -> Codex Responses API body. */
function anthropicToCodexRequest(body, opts = {}) {
  const input = [];
  for (const m of body.messages || []) translateMessageToResponses(m, input);

  const cx = {
    model: body.model,
    store: false,
    stream: !!body.stream,
    instructions: systemToText(body.system) || "You are a helpful assistant.",
    input,
    // NB: we deliberately do NOT request `reasoning.encrypted_content`. With
    // store:false the API returns encrypted reasoning items only so the client
    // can echo them back on the next turn; the Anthropic wire format has no slot
    // to carry them, so we'd drop them anyway — and requesting-then-omitting them
    // makes some Responses deployments reject the tool-continuation turn with a
    // "missing reasoning item" error. Full history is resent each turn instead.
    tool_choice: "auto",
    parallel_tool_calls: true,
  };
  // NB: the Codex backend REJECTS `max_output_tokens` ("Unsupported parameter"),
  // so the SDK's max_tokens is intentionally dropped — the subscription enforces
  // its own limits server-side.

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools = body.tools
      .filter((t) => t && t.name && (t.input_schema || t.parameters))
      .map((t) => ({
        type: "function",
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || t.parameters || { type: "object", properties: {} },
        strict: false,
      }));
    if (tools.length) cx.tools = tools;
    const choice = translateToolChoiceResponses(body.tool_choice);
    if (choice) cx.tool_choice = choice;
  }
  if (opts.reasoningEffort) cx.reasoning = { effort: opts.reasoningEffort, summary: "auto" };
  return cx;
}

/**
 * Stateful translator: parsed Responses-API SSE event objects (push) -> Anthropic
 * SSE strings. Blocks are keyed by the Responses `item_id` since text and tool
 * calls interleave across output items. Reasoning items are dropped (their
 * encrypted_content is not user-facing). end() is idempotent.
 */
function makeCodexStreamTranslator(model) {
  let started = false;
  let ended = false;
  let nextIndex = 0;
  const blockByItem = new Map(); // item_id -> { index, type }
  const toolItems = new Set(); // item_ids that are function_calls (→ tool_use stop_reason)
  let usage = null;
  let stopReason = null;
  const id = `msg_${Date.now()}`;

  function start(out) {
    if (started) return;
    started = true;
    out.push(sse("message_start", {
      type: "message_start",
      message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    }));
  }

  function openText(out, itemId) {
    if (blockByItem.has(itemId)) return blockByItem.get(itemId);
    const index = nextIndex++;
    const entry = { index, type: "text" };
    blockByItem.set(itemId, entry);
    out.push(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }));
    return entry;
  }

  function openTool(out, item) {
    if (blockByItem.has(item.id)) return blockByItem.get(item.id);
    const index = nextIndex++;
    const entry = { index, type: "tool_use", gotArgs: false };
    blockByItem.set(item.id, entry);
    toolItems.add(item.id);
    out.push(sse("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: item.call_id || item.id, name: item.name || "", input: {} },
    }));
    return entry;
  }

  function closeItem(out, itemId) {
    const entry = blockByItem.get(itemId);
    if (!entry || entry.closed) return;
    entry.closed = true;
    out.push(sse("content_block_stop", { type: "content_block_stop", index: entry.index }));
  }

  function push(evt) {
    const out = [];
    start(out);
    const type = evt && evt.type;
    if (!type) return out;

    if (type === "response.output_item.added") {
      const item = evt.item || {};
      if (item.type === "function_call") openTool(out, item);
      // reasoning + message items: opened lazily on their first delta.
      return out;
    }
    if (type === "response.output_text.delta") {
      const entry = openText(out, evt.item_id);
      if (typeof evt.delta === "string" && evt.delta.length) {
        out.push(sse("content_block_delta", { type: "content_block_delta", index: entry.index, delta: { type: "text_delta", text: evt.delta } }));
      }
      return out;
    }
    if (type === "response.function_call_arguments.delta") {
      const entry = blockByItem.get(evt.item_id);
      if (entry && typeof evt.delta === "string" && evt.delta.length) {
        entry.gotArgs = true;
        out.push(sse("content_block_delta", { type: "content_block_delta", index: entry.index, delta: { type: "input_json_delta", partial_json: evt.delta } }));
      }
      return out;
    }
    if (type === "response.output_item.done" || type === "response.output_text.done") {
      const item = evt.item || {};
      const itemId = evt.item_id || item.id;
      // Fallback: if a tool call streamed no argument deltas but the completed
      // item carries the full `arguments`, emit them so tool_use.input isn't {}.
      const entry = itemId && blockByItem.get(itemId);
      if (entry && entry.type === "tool_use" && !entry.gotArgs && typeof item.arguments === "string" && item.arguments.length) {
        entry.gotArgs = true;
        out.push(sse("content_block_delta", { type: "content_block_delta", index: entry.index, delta: { type: "input_json_delta", partial_json: item.arguments } }));
      }
      if (itemId) closeItem(out, itemId);
      return out;
    }
    if (type === "response.completed" || type === "response.incomplete") {
      const resp = evt.response || {};
      usage = resp.usage || usage;
      if (resp.status === "incomplete") stopReason = "max_tokens";
      return out;
    }
    if (type === "response.failed" || type === "error") {
      stopReason = "end_turn";
      return out;
    }
    return out;
  }

  function end() {
    const out = [];
    if (ended) return out;
    ended = true;
    start(out);
    for (const itemId of blockByItem.keys()) closeItem(out, itemId);
    const finalStop = stopReason || (toolItems.size > 0 ? "tool_use" : "end_turn");
    out.push(sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: finalStop, stop_sequence: null },
      usage: { input_tokens: usage?.input_tokens ?? 0, output_tokens: usage?.output_tokens ?? 0 },
    }));
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
// The session's actual model (set by the orchestrator). Safety net: the
// Claude Agent SDK resolves subagent model aliases ("haiku"/"sonnet"/"opus")
// to claude-* ids; those alias envs are remapped per turn, but any claude-*
// id that still reaches this gateway would be forwarded verbatim and rejected
// by every non-Anthropic upstream (e.g. Codex 400 "claude-haiku… is not
// supported when using Codex with a ChatGPT account"). Substitute the
// session model instead of failing the whole subagent.
// Read the CURRENT session model per request: this daemon outlives the exec
// that started it, so its process env is frozen — a mid-session model switch
// only reaches us through the per-turn file the orchestrator writes.
function currentDefaultModel() {
  try {
    const m = require("fs").readFileSync("/tmp/llm-gateway.model", "utf8").trim();
    if (m) return m;
  } catch { /* no file yet — boot env below */ }
  return process.env.LLM_GATEWAY_DEFAULT_MODEL || "";
}
function substituteClaudeModel(body) {
  const fallback = currentDefaultModel();
  if (fallback && fallback !== body?.model && /^claude-/i.test(body?.model || "")) {
    console.log(`[llm-gateway] rewrote unsupported model '${body.model}' -> '${fallback}'`);
    body.model = fallback;
  }
  return body;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// When egress enforcement is on, agents sit on a no-direct-internet network and
// reach the model only through the egress proxy. Node's http/https do NOT honor
// HTTP(S)_PROXY env, so the gateway — the single component that talks to the
// real provider — must route through the proxy itself: CONNECT-tunnel for https,
// absolute-form for http. The proxy token rides in the proxy URL's userinfo and
// is replayed as Proxy-Authorization. NO_PROXY isn't consulted: the gateway only
// ever dials external provider hosts (the SDK→gateway hop is localhost).
function proxyForUrl(u) {
  const env = u.protocol === "https:"
    ? (process.env.HTTPS_PROXY || process.env.https_proxy)
    : (process.env.HTTP_PROXY || process.env.http_proxy);
  return env ? new URL(env) : null;
}

function proxyAuthHeader(p) {
  if (!p.username) return null;
  // username = signed token, password empty (Basic user:pass form).
  return "Basic " + Buffer.from(`${decodeURIComponent(p.username)}:`).toString("base64");
}

/**
 * Build an outbound ClientRequest to `fullUrl`, transparently routed through the
 * egress proxy when one is configured. Returns the ClientRequest so the caller
 * can either write a buffered body or pipe a stream. Mirrors the dial logic the
 * SDK would need if it honored proxy env.
 */
function makeUpstreamReq(method, fullUrl, headers, cb) {
  const u = new URL(fullUrl);
  const hdrs = { ...headers, host: u.host };
  const proxy = proxyForUrl(u);

  if (proxy && u.protocol === "https:") {
    const port = Number(u.port) || 443;
    const proxyPort = Number(proxy.port) || 8080;
    const auth = proxyAuthHeader(proxy);
    return https.request(fullUrl, {
      method,
      headers: hdrs,
      // Defer the dial: open a TCP socket to the proxy, CONNECT, then TLS over
      // the tunnel. We hand the established TLS socket back via `oncreate`.
      createConnection(_opts, oncreate) {
        const proxyTimeout = Number(process.env.LLM_GATEWAY_PROXY_TIMEOUT || 15000);
        const sock = net.connect({ host: proxy.hostname, port: proxyPort });
        let settled = false;
        // oncreate must fire exactly once: a blackholed proxy, a CONNECT error,
        // and a TLS-handshake failure are all funneled here under the guard.
        const fail = (err) => { if (settled) return; settled = true; sock.destroy(); oncreate(err instanceof Error ? err : new Error(String(err))); };
        const onProxyError = (err) => fail(err);
        sock.setTimeout(proxyTimeout, () => fail(new Error("proxy CONNECT timeout")));
        sock.once("error", onProxyError);
        const chunks = [];
        const onData = (chunk) => {
          chunks.push(chunk);
          const buf = Buffer.concat(chunks);
          const sep = buf.indexOf("\r\n\r\n");
          if (sep === -1) return; // CONNECT reply headers not complete yet
          sock.removeListener("data", onData);
          sock.removeListener("error", onProxyError);
          sock.setTimeout(0);
          const status = buf.slice(0, buf.indexOf("\r\n")).toString("latin1");
          if (!/^HTTP\/1\.[01] 200\b/.test(status)) {
            return fail(new Error("proxy CONNECT failed: " + status.trim()));
          }
          // Bytes after the header terminator belong to the TLS stream — push
          // them back so the TLS socket reads them (avoids a desync if the proxy
          // coalesces the 200 reply with the first TLS bytes).
          const remainder = buf.slice(sep + 4);
          if (remainder.length) sock.unshift(remainder);
          const tlsSock = tls.connect({ socket: sock, servername: u.hostname });
          const onTlsErr = (err) => fail(err); // handshake failure → single oncreate
          tlsSock.once("error", onTlsErr);
          tlsSock.once("secureConnect", () => {
            if (settled) { tlsSock.destroy(); return; }
            settled = true;
            tlsSock.removeListener("error", onTlsErr); // post-handshake errors go to http
            oncreate(null, tlsSock);
          });
        };
        sock.on("data", onData);
        sock.once("connect", () => {
          let h = `CONNECT ${u.hostname}:${port} HTTP/1.1\r\nHost: ${u.hostname}:${port}\r\n`;
          if (auth) h += `Proxy-Authorization: ${auth}\r\n`;
          sock.write(h + "\r\n");
        });
        return undefined; // socket delivered via oncreate
      },
    }, cb);
  }

  if (proxy && u.protocol === "http:") {
    const auth = proxyAuthHeader(proxy);
    if (auth) hdrs["proxy-authorization"] = auth;
    return http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 8080,
      method,
      path: fullUrl, // absolute-form for a forward proxy
      headers: hdrs,
    }, cb);
  }

  const lib = u.protocol === "https:" ? https : http;
  return lib.request(fullUrl, { method, headers: hdrs }, cb);
}

function upstreamRequest(method, url, headers, bodyBuf) {
  return new Promise((resolve, reject) => {
    const r = makeUpstreamReq(method, url, headers, (res) => resolve(res));
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
    substituteClaudeModel(anthropicBody);
    const oa = anthropicToOpenAIRequest(anthropicBody);
    const send = (body) => {
      const buf = Buffer.from(JSON.stringify(body));
      return upstreamRequest(
        "POST",
        `${TARGET}/v1/chat/completions`,
        { authorization: auth, "content-type": "application/json", "content-length": Buffer.byteLength(buf) },
        buf,
      );
    };
    let upstream = await send(oa);

    // Adaptive error-driven retries. Two learners share the loop:
    //  - capability fixes (applyCapabilityFix): the provider says a param
    //    combination is unsupported → learn it for this model, adjust, retry;
    //  - tool trim: context-window overflow → drop lowest-priority tools ONCE.
    // Each fix provably changes the request, and attempts are bounded, so the
    // loop can't spin. Unrecognized errors surface to the caller unchanged.
    let trimmed = false;
    let attempts = 0;
    while (
      (upstream.statusCode === 400 || upstream.statusCode === 413 || upstream.statusCode === 422) &&
      attempts < 3
    ) {
      const errText = (await readAll(upstream)).toString("utf8");

      const fix = applyCapabilityFix(oa, errText);
      if (fix) {
        attempts++;
        console.error(`[llm-gateway] ${fix}, retrying`);
        upstream = await send(oa);
        continue;
      }

      if (
        !trimmed &&
        process.env.LLM_GATEWAY_NO_TOOL_TRIM !== "1" &&
        Array.isArray(oa.tools) && oa.tools.length > 0
      ) {
        const limit = parseContextLimit(errText);
        const trim = limit ? trimOpenAIToolsToFit(oa, limit) : { dropped: 0, changed: false };
        if (trim.changed) {
          trimmed = true;
          attempts++;
          console.error(`[llm-gateway] context limit ${limit}: capped descriptions${trim.dropped ? ` + dropped ${trim.dropped} tool(s)` : ""} to fit, retrying`);
          upstream = await send(oa);
          continue;
        }
      }

      // Not an error we know how to fix — surface as-is, preserving the
      // upstream status + content-type.
      res.writeHead(upstream.statusCode, {
        "content-type": upstream.headers["content-type"] || "application/json",
      });
      res.end(errText);
      return;
    }

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

// Raw passthrough preserves the client's own auth (x-api-key, anthropic-version,
// ...) instead of rewriting x-api-key -> Bearer. Used when egress enforcement
// forces the native-Anthropic model path through the gateway purely to reach the
// proxy: the upstream IS api.anthropic.com, which expects x-api-key, not Bearer.
const PASSTHROUGH_RAW = process.env.LLM_GATEWAY_PASSTHROUGH_RAW === "1";

// Hop-by-hop headers (RFC 7230 §6.1) must not be blindly forwarded upstream —
// a client-controlled Transfer-Encoding/Connection enables request smuggling,
// and a stray proxy-authorization would leak the proxy token to the provider.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

async function handlePassthrough(req, res) {
  const headers = { host: new URL(TARGET).hostname };
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase() !== "host" && !HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
  }
  if (!PASSTHROUGH_RAW) {
    const apiKey = req.headers["x-api-key"] || "";
    headers.authorization = `Bearer ${apiKey}`;
    delete headers["x-api-key"];
  }
  // Route through the egress proxy when configured (HTTPS_PROXY) so the model
  // call works on the no-direct-internet network; direct otherwise.
  const proxyReq = makeUpstreamReq(req.method, `${TARGET}${req.url}`, headers, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (e) => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: e.message }));
  });
  req.pipe(proxyReq);
}

// Originator is a static, truthful identity. The account id is NOT read from a
// module-load env — it's decoded from the per-request token below, so a reused
// container that switches between two ChatGPT subscriptions (different account
// ids, same gateway process) always sends the id matching the CURRENT token
// rather than a stale one baked in at first boot. CODEX_ACCOUNT_ID is only a
// fallback for tokens whose account id can't be decoded.
const CODEX_ORIGINATOR = process.env.CODEX_ORIGINATOR || "vonzio";
const CODEX_ACCOUNT_ID_FALLBACK = process.env.CODEX_ACCOUNT_ID || "";

/** Decode `chatgpt_account_id` from a Codex JWT (no signature check — it's only
 *  a routing header). Mirrors accountIdFromJwt in codex-oauth-service.ts. */
function codexAccountId(jwt) {
  try {
    const parts = String(jwt).split(".");
    if (parts.length < 2) return "";
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const id = payload && payload["https://api.openai.com/auth"] && payload["https://api.openai.com/auth"].chatgpt_account_id;
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}

async function handleCodex(req, res) {
  const token = req.headers["x-api-key"] || (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");

  // count_tokens: no Responses equivalent — cheap char/4 estimate (parity with
  // handleOpenAI) so the SDK's context bookkeeping keeps working.
  if (req.method === "POST" && req.url.includes("count_tokens")) {
    const raw = await readBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: Math.ceil(raw.toString("utf8").length / 4) }));
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/v1/messages")) {
    const raw = await readBody(req);
    let anthropicBody;
    try {
      anthropicBody = JSON.parse(raw.toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad json" } }));
      return;
    }
    const wantStream = !!anthropicBody.stream;
    substituteClaudeModel(anthropicBody);
    // The Codex backend only streams; force stream upstream and aggregate below
    // if the SDK asked for a non-streaming reply.
    const cx = anthropicToCodexRequest({ ...anthropicBody, stream: true });
    const buf = Buffer.from(JSON.stringify(cx));
    // Codex has its own backend base; only honor LLM_GATEWAY_TARGET_URL if it
    // was set for codex (the global TARGET default is api.openai.com, wrong here).
    const codexBase = process.env.LLM_GATEWAY_TARGET_URL || "https://chatgpt.com/backend-api";
    const endpoint = codexResponsesUrl(codexBase);
    const accountId = codexAccountId(token) || CODEX_ACCOUNT_ID_FALLBACK;
    const upstreamHeaders = {
      authorization: `Bearer ${token}`,
      originator: CODEX_ORIGINATOR,
      "openai-beta": "responses=experimental",
      "content-type": "application/json",
      accept: "text/event-stream",
      "content-length": Buffer.byteLength(buf),
    };
    // Omit the header entirely when we can't resolve an id — some backends
    // reject an empty chatgpt-account-id rather than treating it as absent.
    if (accountId) upstreamHeaders["chatgpt-account-id"] = accountId;
    const upstream = await upstreamRequest("POST", endpoint, upstreamHeaders, buf);

    if (upstream.statusCode >= 400) {
      const errText = (await readAll(upstream)).toString("utf8");
      res.writeHead(upstream.statusCode, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `codex upstream ${upstream.statusCode}: ${errText.slice(0, 500)}` } }));
      return;
    }

    const tr = makeCodexStreamTranslator(anthropicBody.model);
    // Parse the upstream Responses SSE (event:/data: lines); we only need the
    // data payloads, which carry `type`. response.completed ends the stream.
    const parseInto = (chunkStr, sink, bufRef) => {
      bufRef.s += chunkStr;
      const lines = bufRef.s.split("\n");
      bufRef.s = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try { sink(JSON.parse(payload)); } catch { /* keep-alive / partial */ }
      }
    };

    if (wantStream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const bufRef = { s: "" };
      let finished = false;
      const finish = () => { if (finished) return; finished = true; for (const ev of tr.end()) res.write(ev); res.end(); };
      upstream.on("data", (chunk) => {
        if (finished) return;
        parseInto(chunk.toString("utf8"), (obj) => { for (const ev of tr.push(obj)) res.write(ev); }, bufRef);
      });
      upstream.on("end", finish);
      upstream.on("error", () => { if (!finished) { finished = true; res.end(); } });
      return;
    }

    // Non-streaming: drain the upstream stream, run it through the translator,
    // and fold the Anthropic SSE events back into a single Messages response.
    const respBuf = await readAll(upstream);
    const bufRef = { s: "" };
    const events = [];
    parseInto(respBuf.toString("utf8"), (obj) => { for (const ev of tr.push(obj)) events.push(ev); }, bufRef);
    for (const ev of tr.end()) events.push(ev);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(foldAnthropicSSE(events, anthropicBody.model)));
    return;
  }

  // No other Responses routes are needed (models are enumerated server-side).
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "unsupported route" } }));
}

/** Collapse a sequence of Anthropic SSE strings into one non-streaming Messages
 *  response object (used when the SDK asked for a non-streaming reply). */
function foldAnthropicSSE(events, fallbackModel) {
  const blocks = [];
  let stopReason = "end_turn";
  let usage = { input_tokens: 0, output_tokens: 0 };
  let id = `msg_${Date.now()}`;
  for (const raw of events) {
    const m = /^data: (.*)$/m.exec(raw);
    if (!m) continue;
    let e;
    try { e = JSON.parse(m[1]); } catch { continue; }
    if (e.type === "message_start") { id = e.message?.id || id; }
    else if (e.type === "content_block_start") { blocks[e.index] = JSON.parse(JSON.stringify(e.content_block)); if (blocks[e.index].type === "tool_use") blocks[e.index]._json = ""; }
    else if (e.type === "content_block_delta") {
      const b = blocks[e.index];
      if (!b) continue;
      if (e.delta.type === "text_delta") b.text = (b.text || "") + e.delta.text;
      else if (e.delta.type === "input_json_delta") b._json = (b._json || "") + e.delta.partial_json;
    } else if (e.type === "message_delta") { if (e.delta?.stop_reason) stopReason = e.delta.stop_reason; if (e.usage) usage = { ...usage, ...e.usage }; }
  }
  const content = blocks.filter(Boolean).map((b) => {
    if (b.type === "tool_use") { let input = {}; try { input = JSON.parse(b._json || "{}"); } catch { /* keep {} */ } return { type: "tool_use", id: b.id, name: b.name, input }; }
    return b;
  });
  if (content.length === 0) content.push({ type: "text", text: "" });
  return { id, type: "message", role: "assistant", model: fallbackModel, content, stop_reason: stopReason, stop_sequence: null, usage };
}

function startServer() {
  const server = http.createServer((req, res) => {
    const handler = MODE === "passthrough" ? handlePassthrough : MODE === "codex" ? handleCodex : handleOpenAI;
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
  estimateTokens,
  parseContextLimit,
  trimOpenAIToolsToFit,
  // codex (Responses API) mode
  anthropicToCodexRequest,
  makeCodexStreamTranslator,
  codexResponsesUrl,
  translateMessageToResponses,
  foldAnthropicSSE,
};

if (require.main === module) startServer();
