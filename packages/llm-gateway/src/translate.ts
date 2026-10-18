/**
 * Anthropic Messages request → byok `ChatRequest`.
 *
 * What the SDK sends that byok has no field for is dropped, deliberately:
 * thinking blocks (byok keeps a provider's own reasoning in `providerState`,
 * which a stateless gateway cannot carry), `cache_control`, `metadata`,
 * `stop_sequences`, `temperature`, and a forced `tool_choice` (byok always
 * lets the model choose). None of these change what an agent turn can do.
 */
import type { ChatRequest } from "@amenophis1er/byok/core";

type Block = Record<string, unknown> & { type?: string };
type Message = { role?: string; content?: string | Block[] };

export interface AnthropicRequest {
  model?: string;
  system?: string | Block[];
  messages?: Message[];
  tools?: Array<Record<string, unknown>>;
  tool_choice?: { type?: string; name?: string; disable_parallel_tool_use?: boolean };
  max_tokens?: number;
  stream?: boolean;
}

type UserPart = Extract<ChatRequest["messages"][number], { role: "user" }>["content"] extends infer C
  ? C extends Array<infer P> ? P : never
  : never;
type ToolMessage = Extract<ChatRequest["messages"][number], { role: "tool" }>;
type AssistantMessage = Extract<ChatRequest["messages"][number], { role: "assistant" }>;
type ToolCall = NonNullable<AssistantMessage["toolCalls"]>[number];

/** Flatten an Anthropic `system` field (string | block[]) into one string. */
export function systemToText(system: AnthropicRequest["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n\n");
  }
  return "";
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg"]);

/** Anthropic content blocks (text/image/document) → byok user parts. */
function userParts(blocks: Block[]): UserPart[] {
  const parts: UserPart[] = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      const src = (b.source ?? {}) as { type?: string; media_type?: string; data?: string; url?: string };
      if (src.type === "base64" && src.data && IMAGE_TYPES.has(src.media_type ?? "")) {
        parts.push({ type: "image", mediaType: src.media_type as "image/png" | "image/jpeg", data: src.data });
      } else if (src.type === "base64" && src.data) {
        parts.push({ type: "text", text: `[image omitted: ${src.media_type ?? "unsupported type"}]` });
      } else if (src.url) {
        parts.push({ type: "text", text: `[image: ${src.url}]` });
      }
    } else if (b.type === "document") {
      const src = (b.source ?? {}) as { type?: string; media_type?: string; data?: string };
      if (src.type === "base64" && src.media_type === "application/pdf" && src.data) {
        parts.push({ type: "document", mediaType: "application/pdf", data: src.data, ...(typeof b.title === "string" ? { name: b.title } : {}) });
      } else {
        parts.push({ type: "text", text: "[document omitted: unsupported type]" });
      }
    }
  }
  return parts;
}

/** A user content array as byok wants it: a plain string when it is only text. */
function userContent(blocks: Block[]): string | UserPart[] {
  const parts = userParts(blocks);
  if (parts.every((p) => p.type === "text")) return parts.map((p) => (p as { text: string }).text).join("");
  return parts;
}

/** Anthropic tool_result `content` → byok tool message content. */
function toolResultContent(content: unknown): string | UserPart[] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return userContent(content as Block[]);
  return "";
}

/** Full Anthropic Messages request body → byok ChatRequest (model excluded). */
export function anthropicToChatRequest(body: AnthropicRequest): Omit<ChatRequest, "model"> {
  const messages: ChatRequest["messages"] = [];
  // tool_result blocks name only the tool_use id; byok's tool message also
  // carries the tool's name, so remember it from the assistant turn.
  const toolNames = new Map<string, string>();

  for (const m of body.messages ?? []) {
    if (!m) continue;
    const content = m.content;
    if (m.role === "assistant") {
      const blocks = typeof content === "string" ? [{ type: "text", text: content } as Block] : (content ?? []);
      const text = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("");
      const toolCalls: ToolCall[] = blocks
        .filter((b) => b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string")
        .map((b) => {
          toolNames.set(b.id as string, b.name as string);
          const input = b.input;
          return { id: b.id as string, name: b.name as string, args: (input && typeof input === "object" ? input : {}) as Record<string, unknown> };
        });
      const assistant: AssistantMessage = { role: "assistant" };
      if (text) assistant.content = text;
      if (toolCalls.length > 0) assistant.toolCalls = toolCalls;
      if (text || toolCalls.length > 0) messages.push(assistant);
      continue;
    }
    // user turn: tool results first (providers require them right after the
    // assistant's calls), then the user's own text/images.
    if (typeof content === "string") {
      if (content) messages.push({ role: "user", content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const results = content.filter((b) => b?.type === "tool_result");
    for (const r of results) {
      const id = String(r.tool_use_id ?? "");
      const tool: ToolMessage = {
        role: "tool",
        toolCallId: id,
        name: toolNames.get(id) ?? "tool",
        content: toolResultContent(r.content),
        ...(r.is_error === true ? { isError: true } : {}),
      };
      messages.push(tool);
    }
    const rest = content.filter((b) => b && b.type !== "tool_result");
    const user = userContent(rest);
    if (typeof user === "string" ? user : user.length > 0) messages.push({ role: "user", content: user });
  }

  const tools = (body.tools ?? [])
    // skip Anthropic server-tool shapes that have no function analogue
    .filter((t) => t && typeof t.name === "string" && (t.input_schema || t.parameters))
    .map((t) => ({
      name: t.name as string,
      description: typeof t.description === "string" ? t.description : "",
      inputSchema: (t.input_schema ?? t.parameters ?? { type: "object", properties: {} }) as object,
    }));

  const req: Omit<ChatRequest, "model"> = {
    system: systemToText(body.system),
    messages,
    // Anthropic allows parallel calls unless the request disables them.
    parallelToolCalls: body.tool_choice?.disable_parallel_tool_use !== true,
  };
  if (tools.length > 0) req.tools = tools;
  if (typeof body.max_tokens === "number") req.maxTokens = body.max_tokens;
  return req;
}
