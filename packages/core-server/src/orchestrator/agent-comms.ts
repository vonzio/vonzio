import type { ContainerManager } from "@vonzio/shared";
import type { McpServerConfig } from "@vonzio/shared";
import type { TaskAttachment } from "@vonzio/shared";

export interface AgentMessage {
  type: "init" | "token" | "tool_use" | "tool_result" | "result" | "error" | "exit" | "ask_user";
  session_id?: string;
  text?: string;
  tool?: string;
  input?: Record<string, unknown>;
  output?: string;
  result?: {
    text: string;
    structured_output?: unknown;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    turns: number;
  };
  error?: string;
  code?: number;
}

export interface ToolFilePayload {
  name: string;
  code: string;
}

export interface TaskPayload {
  prompt: string;
  allowed_tools?: string[];
  max_turns?: number;
  max_budget_usd?: number;
  session_id?: string;
  resume?: boolean;
  output_schema?: Record<string, unknown>;
  mcp_servers?: McpServerConfig[];
  tool_files?: ToolFilePayload[];
  system_prompt?: string;
  agents?: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }>;
  has_skills?: boolean;
  model?: string;
  effort?: string;
  attachments?: TaskAttachment[];
}

export class AgentCommunicator {
  private activeExecs = new Map<string, AbortController>();

  constructor(private manager: ContainerManager) {}

  async *dispatch(
    containerId: string,
    payload: TaskPayload,
    env?: Record<string, string>,
  ): AsyncIterable<AgentMessage> {
    const controller = new AbortController();
    this.activeExecs.set(containerId, controller);

    try {
      const stdin = JSON.stringify(payload) + "\n";
      const stream = this.manager.execInContainer(
        containerId,
        ["node", "/app/dist/index.js"],
        stdin,
        env,
      );

      let lastNonJsonLines: string[] = [];

      for await (const line of stream) {
        if (controller.signal.aborted) break;

        try {
          const msg = JSON.parse(line) as AgentMessage;
          lastNonJsonLines = []; // reset on successful parse
          yield msg;

          if (msg.type === "exit") break;
        } catch {
          // Capture non-JSON lines (stderr, crash output) for error reporting
          lastNonJsonLines.push(line);
        }
      }

      // If process ended with non-JSON output and no clean exit, emit it as an error
      if (lastNonJsonLines.length > 0) {
        yield { type: "error", error: lastNonJsonLines.join("\n") } as AgentMessage;
      }
    } finally {
      this.activeExecs.delete(containerId);
    }
  }

  async abort(containerId: string, keepContainer = false): Promise<void> {
    const controller = this.activeExecs.get(containerId);
    if (controller) {
      controller.abort();
    }
    if (!keepContainer) {
      // Force kill the container's exec processes (batch mode)
      try {
        await this.manager.stopContainer(containerId, 10);
      } catch {
        // Container may already be stopped
      }
    }
  }

  isRunning(containerId: string): boolean {
    return this.activeExecs.has(containerId);
  }
}
