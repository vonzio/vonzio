import type { TaskPayload } from "./types.js";
import { emit } from "./emit.js";
import { buildMcpServers } from "./tool-loader.js";

export async function runTask(payload: TaskPayload): Promise<void> {
  // Dynamic import to allow mocking in tests
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  // Build MCP servers config from tool files and MCP server definitions
  const mcpServers = await buildMcpServers(payload.tool_files, payload.mcp_servers);

  const options: Record<string, unknown> = {
    allowedTools: payload.allowed_tools,
    maxTurns: payload.max_turns ?? 200,
    // Containers are sandboxed in Docker — bypass interactive permission prompts
    permissionMode: "bypassPermissions",
    // Hooks to capture tool results and intercept AskUserQuestion
    hooks: {
      PostToolUse: [{
        hooks: [async (input: Record<string, unknown>) => {
          const toolName = input.tool_name as string;
          const toolInput = input.tool_input;
          const toolResponse = input.tool_response;

          // Emit tool_use with input (captures MCP tool args that aren't in the stream)
          if (toolInput != null && typeof toolInput === "object" && Object.keys(toolInput as object).length > 0) {
            emit({ type: "tool_use", tool: toolName, input: toolInput as Record<string, unknown> });
          }

          let output: string;
          if (typeof toolResponse === "string") {
            output = toolResponse;
          } else if (Array.isArray(toolResponse)) {
            // MCP CallToolResult: [{type: "text", text: "..."}] — extract text content
            const texts = toolResponse
              .filter((b: Record<string, unknown>) => b.type === "text" && b.text)
              .map((b: Record<string, unknown>) => b.text as string);
            if (texts.length > 0) {
              // If the extracted text is valid JSON, pretty-print it
              output = texts.map((t) => { try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return t; } }).join("\n");
            } else {
              try { output = JSON.stringify(toolResponse, null, 2); } catch { output = String(toolResponse); }
            }
          } else {
            try { output = JSON.stringify(toolResponse, null, 2); } catch { output = String(toolResponse); }
          }
          // Truncate very long outputs (e.g. full HTML pages)
          if (output.length > 4000) {
            output = output.slice(0, 4000) + `\n... (truncated, ${output.length} total chars)`;
          }
          emit({ type: "tool_result", tool: toolName, output });
          return {};
        }],
      }],
    },
  };

  if (payload.system_prompt) {
    options.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: payload.system_prompt,
    };
  }

  if (payload.max_budget_usd) {
    options.maxBudgetUsd = payload.max_budget_usd;
  }

  if (payload.model) {
    options.model = payload.model;
  }

  if (payload.effort) {
    options.effort = payload.effort;
  }

  // Force adaptive thinking. The SDK (0.2.x) defaults to
  // `thinking: { type: 'enabled', budgetTokens: N }` when effort is
  // set, which Opus 4.7 rejects with:
  //   "thinking.type.enabled is not supported for this model.
  //    Use thinking.type.adaptive and output_config.effort"
  // Setting it explicitly here makes the SDK forward our config
  // instead of computing its own.
  options.thinking = { type: "adaptive" };

  if (payload.session_id && payload.resume) {
    options.resume = payload.session_id;
  }

  if (payload.output_schema) {
    options.outputFormat = {
      type: "json_schema",
      schema: payload.output_schema,
    };
  }

  if (mcpServers) {
    options.mcpServers = mcpServers;
  }

  if (payload.agents && Object.keys(payload.agents).length > 0) {
    options.agents = payload.agents;
    // Ensure Agent tool is allowed when subagents are configured
    if (Array.isArray(options.allowedTools) && !options.allowedTools.includes("Agent")) {
      options.allowedTools = [...options.allowedTools, "Agent"];
    }
  }

  // Always load project settings (CLAUDE.md, skills, hooks from /workspace/.claude/)
  options.settingSources = ["project"];

  if (payload.has_skills) {
    // Ensure Skill tool is allowed when skills are configured
    if (Array.isArray(options.allowedTools) && !options.allowedTools.includes("Skill")) {
      options.allowedTools = [...options.allowedTools, "Skill"];
    }
  }

  // If attachments were written to /workspace by the orchestrator, the prompt already references them
  const prompt = payload.prompt;

  const q = query({
    prompt,
    options,
  });

  // Track active tool_use blocks being streamed
  const toolUseNames = new Map<string, string>();
  const toolInputBuffers = new Map<string, string>();
  let activeToolBlockIndex: number | null = null;

  try {
  for await (const message of q) {
    if (message.type === "system" && (message as Record<string, unknown>).subtype === "init") {
      emit({
        type: "init",
        session_id: (message as Record<string, unknown>).session_id as string,
      });
    } else if (message.type === "assistant") {
      // New SDK: full assistant message with content blocks
      const m = message as Record<string, unknown>;
      const msg = m.message as Record<string, unknown> | undefined;
      if (msg?.content && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<Record<string, unknown>>) {
          if (block.type === "text" && block.text) {
            emit({ type: "token", text: block.text as string });
          } else if (block.type === "tool_use") {
            emit({
              type: "tool_use",
              tool: block.name as string,
              input: (block.input as Record<string, unknown>) ?? {},
            });
          }
        }
      }
    } else if (message.type === "stream_event") {
      const event = (message as Record<string, unknown>).event as Record<string, unknown>;
      if (!event) continue;

      // Text token streaming
      if (
        event.type === "content_block_delta" &&
        (event.delta as Record<string, unknown>)?.type === "text_delta"
      ) {
        emit({
          type: "token",
          text: (event.delta as Record<string, unknown>).text as string,
        });
      }

      // Tool call starts — emit immediately with tool name
      if (event.type === "content_block_start") {
        const block = (event.content_block as Record<string, unknown>) ?? {};
        if (block.type === "tool_use") {
          const toolId = block.id as string;
          const toolName = block.name as string;
          activeToolBlockIndex = event.index as number;
          toolUseNames.set(toolId, toolName);
          toolInputBuffers.set(toolId, "");
          // Emit tool_use immediately with tool name (no input yet)
          emit({ type: "tool_use", tool: toolName, input: {} });
        }
      }

      // Tool input JSON streaming — accumulate chunks
      if (
        event.type === "content_block_delta" &&
        (event.delta as Record<string, unknown>)?.type === "input_json_delta"
      ) {
        const chunk = (event.delta as Record<string, unknown>).partial_json as string;
        if (chunk && activeToolBlockIndex !== null) {
          // Find the active tool by matching the block index
          for (const [toolId] of toolInputBuffers) {
            const existing = toolInputBuffers.get(toolId) ?? "";
            toolInputBuffers.set(toolId, existing + chunk);
            break; // Update the most recent one
          }
        }
      }

      // Tool call complete — emit with full input
      if (event.type === "content_block_stop" && activeToolBlockIndex !== null) {
        // Find the tool that was being streamed and emit final input
        const entries = Array.from(toolInputBuffers.entries());
        if (entries.length > 0) {
          const [toolId, rawInput] = entries[entries.length - 1];
          const toolName = toolUseNames.get(toolId) ?? "unknown";
          try {
            const parsed = JSON.parse(rawInput);
            emit({ type: "tool_use", tool: toolName, input: parsed });
          } catch {
            // Input didn't parse — emit raw
            if (rawInput) {
              emit({ type: "tool_use", tool: toolName, input: { _raw: rawInput } });
            }
          }
          toolInputBuffers.delete(toolId);
        }
        activeToolBlockIndex = null;
      }
    } else if (message.type === "result") {
      const m = message as Record<string, unknown>;
      if (m.subtype === "success") {
        emit({
          type: "result",
          session_id: m.session_id as string,
          result: {
            text: m.result as string,
            input_tokens: ((m.usage as Record<string, number>)?.input_tokens) ?? 0,
            output_tokens: ((m.usage as Record<string, number>)?.output_tokens) ?? 0,
            cost_usd: (m.total_cost_usd as number) ?? 0,
            turns: (m.num_turns as number) ?? 0,
          },
        });
      } else {
        // Non-success subtypes (error_max_turns, error_during_execution, etc.)
        // still carry session_id and usage — emit both error and result so
        // the session remains resumable.
        emit({
          type: "result",
          session_id: m.session_id as string,
          result: {
            text: "",
            input_tokens: ((m.usage as Record<string, number>)?.input_tokens) ?? 0,
            output_tokens: ((m.usage as Record<string, number>)?.output_tokens) ?? 0,
            cost_usd: (m.total_cost_usd as number) ?? 0,
            turns: (m.num_turns as number) ?? 0,
          },
        });
        emit({
          type: "error",
          error: `Agent failed: ${m.subtype}`,
        });
      }
    }
  }
  } catch (err) {
    emit({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
