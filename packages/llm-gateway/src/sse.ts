/**
 * byok's turn → the Anthropic Messages wire format, streamed or whole.
 *
 * Streaming: `AnthropicStream` turns byok `ChatEvent`s into the SSE sequence
 * the Claude Agent SDK expects (message_start, content_block_* per block,
 * message_delta with the stop reason and usage, message_stop). Blocks are
 * indexed in the order they open; a text block stays open until a tool call
 * starts or the turn ends.
 *
 * Whole: `foldResult` builds the non-streaming Messages response from the
 * `AIChatResult`, for the SDK's `stream: false` calls.
 */
import type { ChatEvent } from "@amenophis1er/byok/core";

export interface ChatResultLike {
  ok: boolean;
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args?: Record<string, unknown>; argsError?: { raw: string } }>;
  stopReason?: "end" | "tool_use" | "length" | "refusal";
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  error?: string;
}

export type AnthropicStopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal";

export function mapStopReason(reason: ChatResultLike["stopReason"], hasToolCalls: boolean): AnthropicStopReason {
  switch (reason) {
    case "tool_use": return "tool_use";
    case "length": return "max_tokens";
    case "refusal": return "refusal";
    default: return hasToolCalls ? "tool_use" : "end_turn";
  }
}

export function anthropicUsage(usage: ChatResultLike["usage"]) {
  return {
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    ...(usage?.cacheReadTokens !== undefined ? { cache_read_input_tokens: usage.cacheReadTokens } : {}),
    ...(usage?.cacheWriteTokens !== undefined ? { cache_creation_input_tokens: usage.cacheWriteTokens } : {}),
  };
}

export const newMessageId = () => `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/** One SSE frame. */
export function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type OpenBlock = { index: number; kind: "text" | "tool_use"; id?: string; json: string };

export class AnthropicStream {
  private started = false;
  private nextIndex = 0;
  private text: OpenBlock | null = null;
  private tools = new Map<string, OpenBlock>();
  /** Calls announced in the stream; the result's calls not among them are emitted whole at the end. */
  private announced = new Set<string>();
  readonly id = newMessageId();

  constructor(private model: string, private write: (chunk: string) => void) {}

  /** The message_start frame, written once before any block. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.write(frame("message_start", {
      type: "message_start",
      message: {
        id: this.id, type: "message", role: "assistant", model: this.model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }));
  }

  get hasStarted(): boolean {
    return this.started;
  }

  push(event: ChatEvent): void {
    this.start();
    switch (event.type) {
      case "text": {
        if (!event.delta) return;
        if (!this.text) {
          this.text = { index: this.nextIndex++, kind: "text", json: "" };
          this.write(frame("content_block_start", { type: "content_block_start", index: this.text.index, content_block: { type: "text", text: "" } }));
        }
        this.write(frame("content_block_delta", { type: "content_block_delta", index: this.text.index, delta: { type: "text_delta", text: event.delta } }));
        return;
      }
      case "tool_call_start": {
        this.closeText();
        if (this.tools.has(event.id)) return;
        const block: OpenBlock = { index: this.nextIndex++, kind: "tool_use", id: event.id, json: "" };
        this.tools.set(event.id, block);
        this.announced.add(event.id);
        this.write(frame("content_block_start", { type: "content_block_start", index: block.index, content_block: { type: "tool_use", id: event.id, name: event.name, input: {} } }));
        return;
      }
      case "tool_call_delta": {
        const block = this.tools.get(event.id);
        if (!block || !event.argsDelta) return;
        block.json += event.argsDelta;
        this.write(frame("content_block_delta", { type: "content_block_delta", index: block.index, delta: { type: "input_json_delta", partial_json: event.argsDelta } }));
        return;
      }
      case "tool_call_end": {
        this.closeTool(event.id);
        return;
      }
      case "usage":
        // Copied into message_delta from the result; nothing to write yet.
        return;
    }
  }

  private closeText(): void {
    if (!this.text) return;
    this.write(frame("content_block_stop", { type: "content_block_stop", index: this.text.index }));
    this.text = null;
  }

  private closeTool(id: string): void {
    const block = this.tools.get(id);
    if (!block) return;
    // A call announced with no argument text: the SDK parses the concatenated
    // partial_json, and "" is not JSON, so send the empty object.
    if (!block.json) {
      block.json = "{}";
      this.write(frame("content_block_delta", { type: "content_block_delta", index: block.index, delta: { type: "input_json_delta", partial_json: "{}" } }));
    }
    this.write(frame("content_block_stop", { type: "content_block_stop", index: block.index }));
    this.tools.delete(id);
  }

  /** Close every open block and write message_delta + message_stop from the result. */
  end(result: ChatResultLike): void {
    this.start();
    // Text the result has that never streamed (an empty stream with a final text).
    if (!this.text && this.nextIndex === 0 && result.text) {
      this.push({ type: "text", delta: result.text });
    }
    this.closeText();
    // Calls the result carries that the stream never announced.
    for (const call of result.toolCalls ?? []) {
      if (this.announced.has(call.id)) continue;
      const index = this.nextIndex++;
      const json = call.argsError ? call.argsError.raw : JSON.stringify(call.args ?? {});
      this.write(frame("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } }));
      this.write(frame("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } }));
      this.write(frame("content_block_stop", { type: "content_block_stop", index }));
    }
    for (const id of [...this.tools.keys()]) this.closeTool(id);
    const hasTools = (result.toolCalls?.length ?? 0) > 0 || this.announced.size > 0;
    this.write(frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: mapStopReason(result.stopReason, hasTools), stop_sequence: null },
      usage: anthropicUsage(result.usage),
    }));
    this.write(frame("message_stop", { type: "message_stop" }));
  }

  /** A failure after the stream began: the SDK reads an `error` event. */
  fail(message: string): void {
    this.start();
    this.write(frame("error", { type: "error", error: { type: "api_error", message } }));
  }
}

/** The non-streaming Messages response for a finished turn. */
export function foldResult(result: ChatResultLike, model: string) {
  const content: Array<Record<string, unknown>> = [];
  if (result.text) content.push({ type: "text", text: result.text });
  for (const call of result.toolCalls ?? []) {
    let input: unknown = call.args ?? {};
    if (call.argsError) {
      try { input = JSON.parse(call.argsError.raw); } catch { input = {}; }
    }
    content.push({ type: "tool_use", id: call.id, name: call.name, input });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    id: newMessageId(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapStopReason(result.stopReason, (result.toolCalls?.length ?? 0) > 0),
    stop_sequence: null,
    usage: anthropicUsage(result.usage),
  };
}

/** HTTP status and Anthropic error type for a failed turn. */
export function errorStatus(message: string): { status: number; type: string } {
  const m = /HTTP (\d{3})/.exec(message);
  const status = m ? Number(m[1]) : /ChatGPT rejected this sign-in|sign in again/i.test(message) ? 401
    : /limit is reached|rate.?limit/i.test(message) ? 429
    : /Timed out/i.test(message) ? 504
    : 502;
  const type = status === 401 ? "authentication_error"
    : status === 403 ? "permission_error"
    : status === 429 ? "rate_limit_error"
    : status === 529 ? "overloaded_error"
    : status >= 400 && status < 500 ? "invalid_request_error"
    : "api_error";
  return { status, type };
}
