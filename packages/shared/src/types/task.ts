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

/** "metered": pay-per-token (Anthropic API key, OpenAI API / compatible).
 *  "flat": subscription or flat-rate plan (Claude/ChatGPT subscription,
 *  Ollama Cloud, and any other provider kind). */
export type UsageBilling = "metered" | "flat";

export interface TaskResult {
  text: string;
  structured_output?: unknown;
  tool_calls: ToolCall[];
  session_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  turns: number;
  /** How the provider bills this turn. "flat" (subscriptions, Ollama Cloud):
   *  `cost_usd` is the SDK's notional API-price estimate, not money spent, so
   *  surfaces show token counts only. Absent → "metered" (older results). */
  billing?: UsageBilling;
  /** True when this turn ended by hitting the per-round turn limit (max_turns)
   *  rather than the agent stopping on its own. The goal loop uses this to
   *  continue without a (blind) judge call. */
  max_turns_hit?: boolean;
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
  /** In-memory only. Per-message goal-loop override; undefined → the profile's
   *  auto_continue default decides. */
  goal_mode?: boolean;
  /** In-memory only. Acceptance criteria the completion judge evaluates. */
  acceptance_criteria?: string[];

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

/** Provider kinds billed per token. Every other kind (claude_subscription,
 *  openai_subscription, ollama, and any kind added later) is a flat-rate plan,
 *  where the SDK's dollar estimate is not money the user spent. An unset
 *  provider is the legacy "api_key" default. */
const METERED_PROVIDERS: ReadonlySet<string> = new Set(["api_key", "openai"]);

export function usageBillingFor(provider: string | null | undefined): UsageBilling {
  return METERED_PROVIDERS.has(provider || "api_key") ? "metered" : "flat";
}
