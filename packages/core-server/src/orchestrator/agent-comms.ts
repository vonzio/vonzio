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
  | "judge_error"
  | "agent_error";

/** Independent judge request — dispatched in place of a TaskPayload to run the
 *  completion judge inside the container (where model access lives). */
export interface JudgePayload {
  goal: string;
  acceptance_criteria?: string[];
  agent_result: string;
  prior_missing?: string[];
  /** Omitted → the SDK's default model. On gateway providers the alias-remap
   *  envs pin that default to the session's model, so "no model" is the
   *  correct spelling of "whatever this session actually runs on". */
  model?: string;
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
  disallowed_tools?: string[];
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
  /** Whether the effective model accepts image input. When false, the runner
   *  blocks image Reads so a non-vision model degrades instead of hard-failing. */
  supports_images?: boolean;
  model?: string;
  effort?: string;
  attachments?: TaskAttachment[];
}

// Where the agent records its own PID inside the container (see dispatch()).
// Session abort reads this to kill the agent process group without stopping
// the container.
const AGENT_PID_FILE = "/tmp/vonzio-agent.pid";

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
      // Record the agent's own PID to a file so abort() can kill THIS process
      // (and its tool/bash children) inside the container while keeping the
      // container — and its long-running dev servers — alive. `exec` replaces
      // the shell with node so the recorded $$ is node's PID. Without this,
      // aborting only stops us reading the stream; the agent keeps running.
      const stream = this.manager.execInContainer(
        containerId,
        ["sh", "-c", `echo $$ > ${AGENT_PID_FILE}; exec node /app/dist/index.js`],
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
      // Stops OUR read loop immediately so the UI goes quiet at once.
      controller.abort();
    }
    if (!keepContainer) {
      // Batch mode: stopping the whole container is the kill.
      try {
        await this.manager.stopContainer(containerId, 10);
      } catch {
        // Container may already be stopped
      }
      return;
    }
    // Session mode: aborting the read loop is NOT enough — the agent process is
    // still running inside the container and will keep executing tool calls.
    // Kill the recorded agent PID (and its process group, to catch tool/bash
    // children) with TERM then KILL, while leaving the container — and its
    // dev servers — running.
    await this.killAgentProcess(containerId);
  }

  /** Kill the in-container agent process (TERM, then KILL after a grace) using
   *  the PID it recorded at launch. Best-effort; never throws. */
  private async killAgentProcess(containerId: string): Promise<void> {
    // `-$P` targets the process group; `$P` the process itself — belt and
    // suspenders since the agent may or may not be a group leader. The brief
    // sleep gives a clean SIGTERM shutdown before the hard SIGKILL.
    const script =
      `P=$(cat ${AGENT_PID_FILE} 2>/dev/null); [ -z "$P" ] && exit 0; ` +
      `kill -TERM -"$P" 2>/dev/null; kill -TERM "$P" 2>/dev/null; ` +
      `sleep 1; ` +
      `kill -KILL -"$P" 2>/dev/null; kill -KILL "$P" 2>/dev/null; ` +
      `rm -f ${AGENT_PID_FILE} 2>/dev/null; true`;
    try {
      // Drain the exec stream so the kill actually runs to completion.
      for await (const _line of this.manager.execInContainer(containerId, ["sh", "-c", script])) {
        // no output expected; consume to drive the command
      }
    } catch {
      // Container gone or exec failed — nothing more we can do.
    }
  }

  isRunning(containerId: string): boolean {
    return this.activeExecs.has(containerId);
  }
}
