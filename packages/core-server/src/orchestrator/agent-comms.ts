import type { ContainerManager } from "@vonzio/shared";
import type { McpServerConfig } from "@vonzio/shared";
import type { TaskAttachment } from "@vonzio/shared";

export interface GoalVerdict {
  done: boolean;
  missing: string[];
  progress_made: boolean;
  rationale: string;
}

export type GoalStopReason =
  | "done"
  | "max_iterations"
  | "budget"
  | "no_progress"
  | "judge_error";

/** Independent judge request — dispatched in place of a TaskPayload to run the
 *  completion judge inside the container (where model access lives). */
export interface JudgePayload {
  goal: string;
  acceptance_criteria?: string[];
  agent_result: string;
  prior_missing?: string[];
  model: string;
  effort?: string;
}

export interface AgentMessage {
  type: "init" | "token" | "tool_use" | "tool_result" | "result" | "error" | "exit" | "ask_user" | "verdict";
  session_id?: string;
  /** Set on `verdict` messages from a judge-mode dispatch. */
  verdict?: GoalVerdict;
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

  /**
   * Run the independent completion judge inside the container (a single model
   * call via the same env/gateway the agent uses) and resolve with its verdict.
   * Throws if the judge errors or produces no verdict.
   */
  async judge(
    containerId: string,
    judge: JudgePayload,
    env?: Record<string, string>,
  ): Promise<GoalVerdict> {
    const stdin = JSON.stringify({ judge }) + "\n";
    const stream = this.manager.execInContainer(
      containerId,
      ["node", "/app/dist/index.js"],
      stdin,
      env,
    );
    for await (const line of stream) {
      let msg: AgentMessage | null = null;
      try {
        msg = JSON.parse(line) as AgentMessage;
      } catch {
        continue; // ignore non-JSON (stderr) lines
      }
      if (msg.type === "verdict" && msg.verdict) return msg.verdict;
      if (msg.type === "error") throw new Error(msg.error ?? "judge error");
    }
    throw new Error("judge produced no verdict");
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
