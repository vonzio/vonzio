export const TASK_MODES = ["batch", "pooled", "session"] as const;
export type TaskMode = (typeof TASK_MODES)[number];

export const TASK_STATUSES = [
  "submitted",
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["high", "normal", "low"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/**
 * In-memory file payload passed from a chat surface (WS / Slack / Telegram)
 * to the orchestrator, which materializes each entry as a file in the
 * agent container's /workspace/uploads/<ts>/ dir and tells the agent to
 * Read them. `data` is base64-encoded bytes; `media_type` is the source
 * mime (e.g. image/jpeg, application/pdf) used to pick the file extension.
 */
export interface TaskAttachment {
  type: "image" | "document";
  media_type: string;
  data: string;
  name?: string;
}

export interface RetryPolicy {
  max_attempts: number;
  backoff_seconds: number;
  retry_on: ("timeout" | "error" | "rate_limit")[];
}

export interface WorkspaceConfig {
  type: "git" | "files";
  git_url?: string;
  git_ref?: string;
  git_pat?: string;
  files?: { path: string; content: string }[];
}

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  timestamp: string;
}

export interface TaskResult {
  text: string;
  structured_output?: unknown;
  tool_calls: ToolCall[];
  session_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  turns: number;
}

export interface Task {
  id: string;
  mode: TaskMode;
  status: TaskStatus;
  prompt: string;
  profile_id: string;
  session_id?: string;
  allowed_tools?: string[];
  output_schema?: Record<string, unknown>;
  workspace?: WorkspaceConfig;
  claude_md?: string;
  egress_domains?: string[];
  priority: TaskPriority;
  max_turns?: number;
  max_budget_usd?: number;
  model?: string;
  effort?: string;
  timeout_seconds?: number;
  retry?: RetryPolicy;
  /** In-memory only — not stored in DB. Passed from WS/API to orchestrator. */
  attachments?: TaskAttachment[];

  created_at: string;
  started_at?: string;
  finished_at?: string;
  cancelled_at?: string;
  attempt: number;
  result?: TaskResult;
  error?: string;
}

export const LOG_LEVELS = ["info", "warn", "error", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface TaskLog {
  id: number;
  task_id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
}

export interface MetricRecord {
  id: number;
  name: string;
  value: number;
  labels?: Record<string, string>;
  timestamp: string;
}
