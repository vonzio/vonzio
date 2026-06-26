export interface McpServerConfig {
  name: string;
  type: "sdk" | "stdio" | "http";
  tools?: string[];
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface ToolFilePayload {
  name: string;
  code: string;
}

export interface Attachment {
  type: "image" | "document";
  media_type: string; // e.g. "image/png", "application/pdf"
  data: string;       // base64-encoded
  name?: string;      // optional filename
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
  attachments?: Attachment[];
}

export interface GoalVerdict {
  /** True only when every acceptance criterion is demonstrably met. */
  done: boolean;
  /** Outstanding items still required to meet the goal. */
  missing: string[];
  /** Whether this round made meaningful progress vs the previous one. */
  progress_made: boolean;
  /** One-line justification for the verdict. */
  rationale: string;
}

/**
 * A judge request. When the runner receives a payload with a `judge` field it
 * runs the independent completion judge instead of an agent turn, and emits a
 * single `verdict` message. The orchestrator dispatches this between
 * continuation rounds so the model call happens where model access lives.
 */
export interface JudgePayload {
  goal: string;
  acceptance_criteria?: string[];
  /** The agent's final reported result for the latest iteration. */
  agent_result: string;
  /** What the previous round still had outstanding. */
  prior_missing?: string[];
  model: string;
  effort?: string;
}

/** Top-level stdin payload: either an agent task or a judge request. */
export interface JudgeRequest {
  judge: JudgePayload;
}

export interface RunnerMessage {
  type: "init" | "token" | "tool_use" | "tool_result" | "result" | "error" | "exit" | "ask_user" | "verdict";
  session_id?: string;
  verdict?: GoalVerdict;
  text?: string;
  tool?: string;
  input?: Record<string, unknown>;
  output?: string;
  result?: {
    text: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    turns: number;
  };
  error?: string;
  code?: number;
}
