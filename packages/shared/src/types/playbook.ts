export const PLAYBOOK_RUN_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;
export type PlaybookRunStatus = (typeof PLAYBOOK_RUN_STATUSES)[number];

export type NotifyOn = "completion" | "failure" | "both" | "none";
export type TriggerType = "cron" | "interval" | "manual" | "webhook";
export type DecisionResult = "pass" | "fail" | "skipped";

export type SuccessCriterion =
  | { type: "contains"; field: "result_summary"; value: string }
  | { type: "not_contains"; field: "result_summary"; value: string }
  | { type: "cost_under"; value: number }
  | { type: "turns_under"; value: number }
  | { type: "chains_under"; value: number };

export interface PlaybookChainConfig {
  max_chains: number;
  budget_cap_usd: number;
  chain_delay_ms: number;
  max_turns_per_chain?: number;
  allowed_tools?: string[];
  timeout_per_chain_seconds?: number;
}

export const DEFAULT_CHAIN_CONFIG: PlaybookChainConfig = {
  max_chains: 5,
  budget_cap_usd: 10,
  chain_delay_ms: 5000,
};

export interface Playbook {
  id: string;
  user_id: string;
  profile_id: string;
  name: string;
  description: string;
  prompt: string;
  schedule: string;
  chain_config: PlaybookChainConfig;
  enabled: boolean;
  notify_on: NotifyOn;
  notification_channels: string[];
  trigger_type: TriggerType;
  interval_seconds?: number;
  webhook_token?: string;
  success_criteria?: SuccessCriterion[];
  last_run_at?: string;
  next_run_at?: string;
  created_at: string;
  updated_at: string;
}

export interface ActivityLogEntry {
  type: "text" | "tool_use" | "tool_result";
  tool?: string;
  input?: unknown;
  output?: string;
  text?: string;
  ts: string;
}

// Why the chain-runner stopped a run. `null` (== `undefined` here) means the
// run failed/cancelled before reaching a clean terminator — see `status` +
// `error`. Used by the notification renderer to surface a clean status tag
// instead of jamming "[Budget cap reached]" into `result_summary`.
export type PlaybookTerminationReason =
  | "agent_done"
  | "agent_finished_in_limit"
  | "budget_cap"
  | "chain_limit";

export interface PlaybookRun {
  id: string;
  playbook_id: string;
  playbook_name?: string;
  user_id: string;
  session_id: string;
  status: PlaybookRunStatus;
  chain_count: number;
  total_turns: number;
  total_cost_usd: number;
  task_ids: string[];
  result_summary?: string;
  activity_log?: ActivityLogEntry[];
  decision_result?: DecisionResult;
  termination_reason?: PlaybookTerminationReason;
  error?: string;
  started_at: string;
  finished_at?: string;
}
