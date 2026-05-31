import { pgTable, text, integer, boolean, doublePrecision, serial, jsonb, index, primaryKey, uniqueIndex } from "drizzle-orm/pg-core";
import { TASK_MODES, TASK_STATUSES, TASK_PRIORITIES, LOG_LEVELS } from "@vonzio/shared";
import { WORKSPACE_STATUSES } from "@vonzio/shared";
import { PROFILE_PROVIDERS } from "@vonzio/shared";
import { MEMORY_TYPES } from "@vonzio/shared";
import type { TaskResult, RetryPolicy, WorkspaceConfig } from "@vonzio/shared";
import type { McpServerConfig, RegistryConfig } from "@vonzio/shared";

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    mode: text("mode", { enum: [...TASK_MODES] }).notNull(),
    status: text("status", { enum: [...TASK_STATUSES] }).notNull(),
    prompt: text("prompt").notNull(),
    profile_id: text("profile_id").notNull(),
    session_id: text("session_id"),
    allowed_tools: jsonb("allowed_tools").$type<string[]>(),
    output_schema: jsonb("output_schema").$type<Record<string, unknown>>(),
    workspace: jsonb("workspace").$type<WorkspaceConfig>(),
    claude_md: text("claude_md"),
    egress_domains: jsonb("egress_domains").$type<string[]>(),
    priority: text("priority", { enum: [...TASK_PRIORITIES] })
      .notNull()
      .default("normal"),
    max_turns: integer("max_turns"),
    max_budget_usd: doublePrecision("max_budget_usd"),
    model: text("model"),
    effort: text("effort"),
    timeout_seconds: integer("timeout_seconds"),
    retry: jsonb("retry").$type<RetryPolicy>(),
    created_at: text("created_at").notNull(),
    started_at: text("started_at"),
    finished_at: text("finished_at"),
    cancelled_at: text("cancelled_at"),
    attempt: integer("attempt").notNull().default(1),
    result: jsonb("result").$type<TaskResult>(),
    error: text("error"),
  },
  (table) => [
    index("tasks_status_idx").on(table.status),
    index("tasks_profile_status_idx").on(table.profile_id, table.status),
    index("tasks_session_id_idx").on(table.session_id),
    index("tasks_created_at_idx").on(table.created_at),
  ],
);

export const workspaces = pgTable(
  "workspaces",
  {
    session_id: text("session_id").primaryKey(),
    container_id: text("container_id"),
    user_id: text("user_id"),
    profile_id: text("profile_id").notNull(),
    workspace_config: jsonb("workspace_config").$type<WorkspaceConfig>(),
    ws_connection_id: text("ws_connection_id"),
    name: text("name"),
    pinned: boolean("pinned").notNull().default(false),
    starred: boolean("starred").notNull().default(false),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    archived: boolean("archived").notNull().default(false),
    last_opened_at: text("last_opened_at"),
    persistent: boolean("persistent").notNull().default(false),
    volume_id: text("volume_id"),
    volume_expires_at: text("volume_expires_at"),
    public_preview: boolean("public_preview").notNull().default(false),
    model_override: text("model_override"),
    last_run_model: text("last_run_model"),
    status: text("status", { enum: [...WORKSPACE_STATUSES] }).notNull(),
    last_active_at: text("last_active_at").notNull(),
    created_at: text("created_at").notNull(),
    expires_at: text("expires_at").notNull(),
    org_id: text("org_id"),
  },
  (table) => [
    index("sessions_status_idx").on(table.status),
    index("sessions_profile_id_idx").on(table.profile_id),
    index("sessions_expires_at_idx").on(table.expires_at),
    index("workspaces_org_id_idx").on(table.org_id),
  ],
);

export const anthropicKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id"),
    name: text("name").notNull(),
    provider: text("provider", { enum: [...PROFILE_PROVIDERS] }).notNull(),
    encrypted_api_key: text("encrypted_api_key"),
    encrypted_auth_token: text("encrypted_auth_token"),
    created_at: text("created_at").notNull(),
    last_used_at: text("last_used_at"),
    org_id: text("org_id"),
  },
  (table) => [
    index("api_keys_org_id_idx").on(table.org_id),
  ],
);

// Junction table: which users have access to which API keys
export const apiKeyUsers = pgTable("api_key_users", {
  api_key_id: text("api_key_id").notNull().references(() => anthropicKeys.id, { onDelete: "cascade" }),
  user_id: text("user_id").notNull(),
}, (table) => [
  primaryKey({ columns: [table.api_key_id, table.user_id] }),
]);

export const profiles = pgTable("profiles", {
  id: text("id").primaryKey(),
  user_id: text("user_id"),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  provider: text("provider", { enum: [...PROFILE_PROVIDERS] }).notNull().default("api_key"),
  api_key_id: text("api_key_id"),
  default_tools: jsonb("default_tools")
    .$type<string[]>()
    .notNull()
    .default([]),
  default_egress_domains: jsonb("default_egress_domains")
    .$type<string[]>()
    .notNull()
    .default([]),
  claude_md: text("claude_md"),
  git_provider_id: text("git_provider_id"), // deprecated — use git_provider_ids
  git_provider_ids: jsonb("git_provider_ids").$type<string[]>().notNull().default([]),
  mcp_servers: jsonb("mcp_servers")
    .$type<McpServerConfig[]>()
    .notNull()
    .default([]),
  agent_ids: jsonb("agent_ids")
    .$type<string[]>()
    .notNull()
    .default([]),
  skill_ids: jsonb("skill_ids")
    .$type<string[]>()
    .notNull()
    .default([]),
  model: text("model"),
  effort: text("effort"),
  container_image: text("container_image"),
  container_registry: jsonb("container_registry")
    .$type<RegistryConfig>(),
  setup_commands: jsonb("setup_commands")
    .$type<string[]>()
    .notNull()
    .default([]),
  persistent_sessions: boolean("persistent_sessions").notNull().default(true),
  concurrency_limit: integer("concurrency_limit").notNull().default(5),
  memory_enabled: boolean("memory_enabled").notNull().default(true),
  max_turns: integer("max_turns"),
  auto_continue: boolean("auto_continue").notNull().default(false),
  max_continuations: integer("max_continuations").notNull().default(5),
  continuation_budget_usd: doublePrecision("continuation_budget_usd"),
  created_at: text("created_at").notNull(),
  last_used_at: text("last_used_at"),
});

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    key_hash: text("key_hash").notNull(),
    user_id: text("user_id"),
    allowed_profile_ids: jsonb("allowed_profile_ids")
      .$type<string[]>()
      .notNull(),
    rate_limit_rpm: integer("rate_limit_rpm").notNull().default(60),
    created_at: text("created_at").notNull(),
    last_used_at: text("last_used_at"),
  },
  (table) => [index("api_tokens_key_hash_idx").on(table.key_hash)],
);

export const taskLogs = pgTable(
  "task_logs",
  {
    id: serial("id").primaryKey(),
    task_id: text("task_id")
      .notNull()
      .references(() => tasks.id),
    timestamp: text("timestamp").notNull(),
    level: text("level", { enum: [...LOG_LEVELS] }).notNull(),
    message: text("message").notNull(),
  },
  (table) => [
    index("task_logs_task_id_idx").on(table.task_id),
    index("task_logs_timestamp_idx").on(table.timestamp),
  ],
);

export const toolFiles = pgTable("tool_files", {
  id: text("id").primaryKey(),
  user_id: text("user_id"),
  name: text("name").notNull(),
  description: text("description"),
  file_name: text("file_name").notNull(),
  source: text("source", { enum: ["filesystem", "uploaded"] }).notNull(),
  code: text("code"),
  input_schema: text("input_schema"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const skills = pgTable("skills", {
  id: text("id").primaryKey(),
  user_id: text("user_id"),
  name: text("name").notNull(),
  description: text("description").notNull(),
  content: text("content").notNull(),
  source: text("source", { enum: ["filesystem", "uploaded"] }).notNull(),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const gitProviders = pgTable("git_providers", {
  id: text("id").primaryKey(),
  user_id: text("user_id"),
  name: text("name").notNull(),
  type: text("type", { enum: ["github", "gitlab", "bitbucket"] }).notNull(),
  auth_method: text("auth_method", { enum: ["pat", "oauth"] }).notNull().default("pat"),
  encrypted_token: text("encrypted_token").notNull(),
  user_name: text("user_name"),
  user_email: text("user_email"),
  created_at: text("created_at").notNull(),
});

export const subagents = pgTable("subagents", {
  id: text("id").primaryKey(),
  user_id: text("user_id"),
  name: text("name").notNull(),
  description: text("description").notNull(),
  prompt: text("prompt").notNull(),
  tools: jsonb("tools").$type<string[]>(),
  model: text("model"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

// Owned by @vonzio/cp-server (multi-tenant control plane). The table lives
// here for now because migrations are centralized; when cp-server takes
// ownership of its own migrations the schema will move with it.
export const invites = pgTable(
  "invites",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    role: text("role").notNull().default("user"),
    token_hash: text("token_hash").notNull(),
    invited_by: text("invited_by").notNull(),
    api_key_ids: jsonb("api_key_ids").$type<string[]>().notNull().default([]),
    expires_at: text("expires_at").notNull(),
    used_at: text("used_at"),
    created_at: text("created_at").notNull(),
    org_id: text("org_id"),
  },
  (table) => [
    index("invites_org_id_idx").on(table.org_id),
  ],
);

export const userIntegrations = pgTable(
  "user_integrations",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull(),
    type: text("type").notNull(), // "slack", "email", "webhook", "gmail", "telegram", "teller"
    // Indexed denormalization of the provider's stable external identifier
    // (e.g. Telegram bot_user_id, Teller enrollment_id). Populated by
    // IntegrationService so cold webhook lookups don't have to decrypt
    // every row of a given type.
    external_id: text("external_id"),
    encrypted_config: text("encrypted_config").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    is_default: boolean("is_default").notNull().default(false),
    // Per-agent scope: 'all' = available to every agent owned by user,
    // 'agents' = restricted to profiles listed in profile_ids. Mirrors
    // user_secrets exactly.
    scope: text("scope", { enum: ["all", "agents"] }).notNull().default("all"),
    profile_ids: jsonb("profile_ids").$type<string[]>().notNull().default([]),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    index("user_integrations_type_ext_idx").on(table.type, table.external_id),
  ],
);

export const slackThreadMappings = pgTable(
  "slack_thread_mappings",
  {
    id: serial("id").primaryKey(),
    slack_team_id: text("slack_team_id").notNull(),
    slack_channel_id: text("slack_channel_id").notNull(),
    slack_thread_ts: text("slack_thread_ts").notNull(),
    session_id: text("session_id").notNull(),
    user_id: text("user_id").notNull(),
    profile_id: text("profile_id").notNull(),
    created_at: text("created_at").notNull(),
  },
  (table) => [
    index("slack_thread_lookup_idx").on(table.slack_team_id, table.slack_channel_id, table.slack_thread_ts),
    index("slack_thread_session_idx").on(table.session_id),
  ],
);

// The three telegram_* table definitions moved to
// packages/plugins/telegram/src/db/schema.ts in Phase 3D.1c and
// telegram-events.ts itself moved in 3D.1d.1, so core no longer
// references the tables. Their CREATE TABLE migrations (formerly
// v14 + v19) also got deleted from migrations.ts -- the plugin's
// idempotent 0001 migration creates them on first boot now.

export const metrics = pgTable(
  "metrics",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    value: doublePrecision("value").notNull(),
    labels: jsonb("labels").$type<Record<string, string>>(),
    timestamp: text("timestamp").notNull(),
  },
  (table) => [index("metrics_name_timestamp_idx").on(table.name, table.timestamp)],
);

export const memories = pgTable(
  "memories",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull(),
    profile_id: text("profile_id"),
    type: text("type", { enum: [...MEMORY_TYPES] }).notNull(),
    name: text("name").notNull(),
    description: text("description"),
    body: text("body").notNull(),
    importance: integer("importance").notNull().default(0),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    last_accessed_at: text("last_accessed_at"),
    org_id: text("org_id"),
  },
  (table) => [
    index("memories_user_id_idx").on(table.user_id),
    index("memories_user_profile_idx").on(table.user_id, table.profile_id),
    index("memories_user_type_idx").on(table.user_id, table.type),
    index("memories_updated_at_idx").on(table.updated_at),
    index("memories_org_id_idx").on(table.org_id),
  ],
);

export const userSecrets = pgTable(
  "user_secrets",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull(),
    name: text("name").notNull(),
    encrypted_value: text("encrypted_value").notNull(),
    scope: text("scope", { enum: ["all", "agents"] }).notNull().default("all"),
    profile_ids: jsonb("profile_ids").$type<string[]>().notNull().default([]),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    index("user_secrets_user_id_idx").on(table.user_id),
    uniqueIndex("user_secrets_user_name_idx").on(table.user_id, table.name),
  ],
);

export const playbooks = pgTable(
  "playbooks",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull(),
    profile_id: text("profile_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    prompt: text("prompt").notNull(),
    schedule: text("schedule").notNull(),
    chain_config: jsonb("chain_config").$type<import("@vonzio/shared").PlaybookChainConfig>().notNull(),
    enabled: boolean("enabled").notNull().default(false),
    notify_on: text("notify_on").notNull().default("none"),
    notification_channels: jsonb("notification_channels").$type<string[]>().notNull().default([]),
    trigger_type: text("trigger_type").notNull().default("cron"),
    interval_seconds: integer("interval_seconds"),
    webhook_token: text("webhook_token"),
    success_criteria: jsonb("success_criteria").$type<import("@vonzio/shared").SuccessCriterion[]>(),
    last_run_at: text("last_run_at"),
    next_run_at: text("next_run_at"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
    org_id: text("org_id"),
  },
  (table) => [
    index("playbooks_user_id_idx").on(table.user_id),
    index("playbooks_org_id_idx").on(table.org_id),
  ],
);

export const playbookRuns = pgTable(
  "playbook_runs",
  {
    id: text("id").primaryKey(),
    playbook_id: text("playbook_id").notNull(),
    user_id: text("user_id").notNull(),
    session_id: text("session_id").notNull(),
    status: text("status", { enum: ["queued", "running", "completed", "failed", "cancelled"] }).notNull(),
    chain_count: integer("chain_count").notNull().default(0),
    total_turns: integer("total_turns").notNull().default(0),
    total_cost_usd: doublePrecision("total_cost_usd").notNull().default(0),
    task_ids: jsonb("task_ids").$type<string[]>().notNull().default([]),
    result_summary: text("result_summary"),
    activity_log: jsonb("activity_log").$type<{ type: string; tool?: string; input?: unknown; output?: string; text?: string; ts: string }[]>(),
    decision_result: text("decision_result"),
    // Why the run ended. One of:
    //   "agent_done"               agent self-signaled DONE via StructuredOutput
    //   "agent_finished_in_limit"  agent stopped before max_turns w/o DONE signal
    //   "budget_cap"               total cost ≥ playbook budget cap
    //   "chain_limit"              max_chains reached
    //   null                       failed/cancelled (see status + error)
    // Migration #17 added this lazily; pre-fix rows have null.
    termination_reason: text("termination_reason", {
      enum: ["agent_done", "agent_finished_in_limit", "budget_cap", "chain_limit"],
    }),
    error: text("error"),
    started_at: text("started_at").notNull(),
    finished_at: text("finished_at"),
  },
  (table) => [
    index("playbook_runs_playbook_id_idx").on(table.playbook_id),
    index("playbook_runs_user_id_idx").on(table.user_id),
  ],
);

export const notificationLog = pgTable(
  "notification_log",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id").notNull(),
    channel: text("channel").notNull(),
    message: text("message").notNull(),
    urgency: text("urgency").notNull().default("normal"),
    source: text("source").notNull(),
    task_id: text("task_id"),
    status: text("status").notNull(),
    error: text("error"),
    created_at: text("created_at").notNull(),
  },
  (table) => [
    index("notification_log_user_id_idx").on(table.user_id),
    index("notification_log_created_at_idx").on(table.created_at),
  ],
);

export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    user_id: text("user_id"),
    session_id: text("session_id"),
    event: text("event").notNull(),
    source: text("source", { enum: ["server", "client"] }).notNull(),
    properties: jsonb("properties").$type<Record<string, unknown>>(),
    ip: text("ip"),
    user_agent: text("user_agent"),
    created_at: text("created_at").notNull(),
    org_id: text("org_id"),
  },
  (table) => [
    index("events_user_created_idx").on(table.user_id, table.created_at),
    index("events_event_created_idx").on(table.event, table.created_at),
    index("events_org_id_idx").on(table.org_id),
  ],
);
