import { sql } from "drizzle-orm";
import type { DB } from "./index.js";
import { slugify, resolveCollision } from "../services/slug.js";
import { decryptLegacy, encrypt } from "../auth/crypto.js";

interface Migration {
  version: number;
  description: string;
  up: (handle: DB) => Promise<void>;
}

/**
 * All migrations in order. Each runs exactly once.
 * Migration 0 = full Postgres schema (fresh start after SQLite→Postgres migration).
 *
 * Rules:
 * - Never modify an existing migration
 * - Always add new migrations at the end with incrementing version
 */
const migrations: Migration[] = [
  {
    version: 0,
    description: "Full Postgres schema: tasks, workspaces, api_keys, api_key_users, profiles, api_tokens, task_logs, tool_files, skills, subagents, git_providers, invites, user_integrations, slack_thread_mappings, metrics",
    async up(handle) {
      // -- tasks --
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        session_id TEXT,
        allowed_tools JSONB,
        output_schema JSONB,
        workspace JSONB,
        claude_md TEXT,
        egress_domains JSONB,
        priority TEXT NOT NULL DEFAULT 'normal',
        max_turns INTEGER,
        max_budget_usd DOUBLE PRECISION,
        model TEXT,
        effort TEXT,
        timeout_seconds INTEGER,
        retry JSONB,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        cancelled_at TEXT,
        attempt INTEGER NOT NULL DEFAULT 1,
        result JSONB,
        error TEXT
      )`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status)`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS tasks_profile_status_idx ON tasks(profile_id, status)`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS tasks_session_id_idx ON tasks(session_id)`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS tasks_created_at_idx ON tasks(created_at)`);

      // -- workspaces --
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS workspaces (
        session_id TEXT PRIMARY KEY,
        container_id TEXT,
        user_id TEXT,
        profile_id TEXT NOT NULL,
        workspace_config JSONB,
        ws_connection_id TEXT,
        name TEXT,
        pinned BOOLEAN NOT NULL DEFAULT false,
        starred BOOLEAN NOT NULL DEFAULT false,
        tags JSONB NOT NULL DEFAULT '[]',
        archived BOOLEAN NOT NULL DEFAULT false,
        last_opened_at TEXT,
        persistent BOOLEAN NOT NULL DEFAULT false,
        volume_id TEXT,
        volume_expires_at TEXT,
        status TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS sessions_status_idx ON workspaces(status)`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS sessions_profile_id_idx ON workspaces(profile_id)`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON workspaces(expires_at)`);

      // -- api_keys --
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        encrypted_api_key TEXT,
        encrypted_auth_token TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      )`);

      // -- api_key_users (junction table) --
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS api_key_users (
        api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        PRIMARY KEY (api_key_id, user_id)
      )`);

      // -- profiles --
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'api_key',
        api_key_id TEXT,
        default_tools JSONB NOT NULL DEFAULT '[]',
        default_egress_domains JSONB NOT NULL DEFAULT '[]',
        claude_md TEXT,
        git_provider_id TEXT,
        git_provider_ids JSONB NOT NULL DEFAULT '[]',
        mcp_servers JSONB NOT NULL DEFAULT '[]',
        agent_ids JSONB NOT NULL DEFAULT '[]',
        skill_ids JSONB NOT NULL DEFAULT '[]',
        model TEXT,
        effort TEXT,
        container_image TEXT,
        container_registry JSONB,
        setup_commands JSONB NOT NULL DEFAULT '[]',
        persistent_sessions BOOLEAN NOT NULL DEFAULT true,
        concurrency_limit INTEGER NOT NULL DEFAULT 5,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      )`);

      // -- api_tokens --
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        user_id TEXT,
        allowed_profile_ids JSONB NOT NULL,
        rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      )`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS api_tokens_key_hash_idx ON api_tokens(key_hash)`);

      // -- task_logs --
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS task_logs (
        id SERIAL PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL
      )`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS task_logs_task_id_idx ON task_logs(task_id)`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS task_logs_timestamp_idx ON task_logs(timestamp)`);

      // -- tool_files --
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS tool_files (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        file_name TEXT NOT NULL,
        source TEXT NOT NULL,
        code TEXT,
        input_schema TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);

      // -- skills --
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);

      // -- git_providers --
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS git_providers (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        auth_method TEXT NOT NULL DEFAULT 'pat',
        encrypted_token TEXT NOT NULL,
        user_name TEXT,
        user_email TEXT,
        created_at TEXT NOT NULL
      )`);

      // -- subagents --
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS subagents (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        prompt TEXT NOT NULL,
        tools JSONB,
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);

      // -- invites --
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        token_hash TEXT NOT NULL,
        invited_by TEXT NOT NULL,
        api_key_ids JSONB NOT NULL DEFAULT '[]',
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      )`);

      // -- user_integrations --
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS user_integrations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        encrypted_config TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);

      // -- slack_thread_mappings --
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS slack_thread_mappings (
        id SERIAL PRIMARY KEY,
        slack_team_id TEXT NOT NULL,
        slack_channel_id TEXT NOT NULL,
        slack_thread_ts TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS slack_thread_lookup_idx ON slack_thread_mappings(slack_team_id, slack_channel_id, slack_thread_ts)`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS slack_thread_session_idx ON slack_thread_mappings(session_id)`);

      // -- metrics --
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS metrics (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        value DOUBLE PRECISION NOT NULL,
        labels JSONB,
        timestamp TEXT NOT NULL
      )`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS metrics_name_timestamp_idx ON metrics(name, timestamp)`);
    },
  },
  {
    version: 1,
    description: "Add public_preview column to workspaces",
    up: async (handle: DB) => {
      await handle.db.execute(sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS public_preview BOOLEAN NOT NULL DEFAULT false`);
    },
  },
  {
    version: 2,
    description: "Add memories table with pg_trgm indexes, add memory_enabled to profiles",
    up: async (handle: DB) => {
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        profile_id TEXT,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        body TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT
      )`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS memories_user_id_idx ON memories(user_id)`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS memories_user_profile_idx ON memories(user_id, profile_id)`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS memories_user_type_idx ON memories(user_id, type)`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS memories_updated_at_idx ON memories(updated_at)`);

      await handle.db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS memories_name_trgm_idx ON memories USING GIN (name gin_trgm_ops)`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS memories_description_trgm_idx ON memories USING GIN (description gin_trgm_ops)`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS memories_body_trgm_idx ON memories USING GIN (body gin_trgm_ops)`);

      await handle.db.execute(sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS memory_enabled BOOLEAN NOT NULL DEFAULT true`);
    },
  },
  {
    version: 3,
    description: "Add user_secrets table for encrypted per-user environment variables",
    up: async (handle: DB) => {
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS user_secrets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, name)
      )`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS user_secrets_user_id_idx ON user_secrets(user_id)`);
    },
  },
  {
    version: 4,
    description: "Add playbooks and playbook_runs tables for autonomous agent tasks",
    up: async (handle: DB) => {
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS playbooks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL,
        schedule TEXT NOT NULL,
        chain_config JSONB NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT false,
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS playbooks_user_id_idx ON playbooks(user_id)`);

      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS playbook_runs (
        id TEXT PRIMARY KEY,
        playbook_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        chain_count INTEGER NOT NULL DEFAULT 0,
        total_turns INTEGER NOT NULL DEFAULT 0,
        total_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
        task_ids JSONB NOT NULL DEFAULT '[]',
        result_summary TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      )`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS playbook_runs_playbook_id_idx ON playbook_runs(playbook_id)`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS playbook_runs_user_id_idx ON playbook_runs(user_id)`);
    },
  },
  {
    version: 5,
    description: "Add activity_log column to playbook_runs for full agent work capture",
    up: async (handle: DB) => {
      await handle.db.execute(sql`ALTER TABLE playbook_runs ADD COLUMN IF NOT EXISTS activity_log JSONB`);
    },
  },
  {
    version: 6,
    description: "Phase 2: notifications, guardrails, decision engine, advanced scheduling",
    up: async (handle: DB) => {
      // Playbooks: notification settings
      await handle.db.execute(sql`ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS notify_on TEXT NOT NULL DEFAULT 'none'`);
      await handle.db.execute(sql`ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS notification_channels JSONB NOT NULL DEFAULT '[]'`);
      // Playbooks: trigger types
      await handle.db.execute(sql`ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS trigger_type TEXT NOT NULL DEFAULT 'cron'`);
      await handle.db.execute(sql`ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS interval_seconds INTEGER`);
      await handle.db.execute(sql`ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS webhook_token TEXT`);
      // Playbooks: decision engine
      await handle.db.execute(sql`ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS success_criteria JSONB`);
      // Playbook runs: decision result
      await handle.db.execute(sql`ALTER TABLE playbook_runs ADD COLUMN IF NOT EXISTS decision_result TEXT`);
    },
  },
  {
    version: 7,
    description: "Add notification_log table and is_default column to user_integrations",
    up: async (handle: DB) => {
      await handle.db.execute(sql`ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false`);

      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS notification_log (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        message TEXT NOT NULL,
        urgency TEXT NOT NULL DEFAULT 'normal',
        source TEXT NOT NULL,
        task_id TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL
      )`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS notification_log_user_id_idx ON notification_log(user_id)`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS notification_log_created_at_idx ON notification_log(created_at)`);
    },
  },
  {
    version: 8,
    description: "Add max_turns and auto-continue fields to profiles",
    up: async (handle: DB) => {
      await handle.db.execute(sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS max_turns INTEGER`);
      await handle.db.execute(sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS auto_continue BOOLEAN NOT NULL DEFAULT false`);
      await handle.db.execute(sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS max_continuations INTEGER NOT NULL DEFAULT 5`);
      await handle.db.execute(sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS continuation_budget_usd DOUBLE PRECISION`);
    },
  },
  {
    version: 9,
    description: "Add feature_flags to user table (Ollama access gating)",
    up: async (handle) => {
      await handle.db.execute(sql`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS feature_flags TEXT NOT NULL DEFAULT ''`);
    },
  },
  {
    version: 10,
    description: "Add slug to profiles with per-user uniqueness (enables @slug routing from Slack)",
    up: async (handle) => {
      await handle.db.execute(sql`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS slug TEXT`);

      // Seed the collision map with already-populated slugs so a retry after
      // a partial-failure run can't re-issue an existing slug.
      const existing = await handle.db.execute<{ user_id: string | null; slug: string }>(
        sql`SELECT user_id, slug FROM profiles WHERE slug IS NOT NULL`,
      );
      const takenByUser = new Map<string, Set<string>>();
      for (const row of existing.rows as Array<{ user_id: string | null; slug: string }>) {
        const scope = row.user_id ?? "__shared__";
        const taken = takenByUser.get(scope) ?? new Set<string>();
        taken.add(row.slug);
        takenByUser.set(scope, taken);
      }

      // Backfill remaining NULL slugs from name, resolving per-user collisions
      const rows = await handle.db.execute<{ id: string; user_id: string | null; name: string }>(
        sql`SELECT id, user_id, name FROM profiles WHERE slug IS NULL ORDER BY user_id, created_at`,
      );
      for (const row of rows.rows as Array<{ id: string; user_id: string | null; name: string }>) {
        const scope = row.user_id ?? "__shared__";
        const taken = takenByUser.get(scope) ?? new Set<string>();
        const slug = resolveCollision(slugify(row.name), taken);
        taken.add(slug);
        takenByUser.set(scope, taken);
        await handle.db.execute(sql`UPDATE profiles SET slug = ${slug} WHERE id = ${row.id}`);
      }

      await handle.db.execute(sql`ALTER TABLE profiles ALTER COLUMN slug SET NOT NULL`);
      await handle.db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS profiles_user_slug_unique ON profiles(user_id, slug)`);
    },
  },
  {
    version: 11,
    description: "Add events table for beta observability (signup/login/feature usage tracking)",
    up: async (handle) => {
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS events (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT,
        session_id TEXT,
        event TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('server', 'client')),
        properties JSONB,
        ip TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL
      )`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS events_user_created_idx ON events (user_id, created_at DESC)`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS events_event_created_idx ON events (event, created_at DESC)`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS events_properties_gin ON events USING GIN (properties)`);
    },
  },
  {
    version: 12,
    description: "Add model_override column to workspaces (per-workspace model override)",
    up: async (handle) => {
      await handle.db.execute(sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS model_override TEXT`);
    },
  },
  {
    version: 13,
    description: "Add last_run_model column to workspaces (cross-model context replay trigger)",
    up: async (handle) => {
      await handle.db.execute(sql`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS last_run_model TEXT`);
    },
  },
  {
    version: 14,
    description: "Add telegram_active_sessions and telegram_sessions tables for Telegram bot integration",
    up: async (handle) => {
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS telegram_active_sessions (
        bot_user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        tg_user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        PRIMARY KEY (bot_user_id, chat_id, tg_user_id)
      )`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS telegram_active_session_idx ON telegram_active_sessions(session_id)`);

      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS telegram_sessions (
        session_id TEXT PRIMARY KEY,
        bot_user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        tg_user_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        title TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      )`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS telegram_sessions_chat_idx ON telegram_sessions(bot_user_id, chat_id, started_at)`);
    },
  },
  {
    version: 15,
    description: "Add indexed external_id column to user_integrations for O(1) provider lookups (replaces O(N) decrypt scan)",
    up: async (handle) => {
      await handle.db.execute(sql`ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS external_id TEXT`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS user_integrations_type_ext_idx ON user_integrations(type, external_id)`);
      // Existing rows are backfilled lazily by IntegrationService on first
      // update, or via the fallback decrypt-scan path in webhook lookups —
      // can't decrypt inside a migration since the encryption key lives in env.
    },
  },
  {
    version: 16,
    description: "Add scope + profile_ids columns to user_secrets for per-agent secret scoping (feature #17)",
    up: async (handle) => {
      await handle.db.execute(sql`ALTER TABLE user_secrets ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'all'`);
      await handle.db.execute(sql`ALTER TABLE user_secrets ADD COLUMN IF NOT EXISTS profile_ids JSONB NOT NULL DEFAULT '[]'::jsonb`);
    },
  },
  {
    version: 17,
    description: "Add termination_reason column to playbook_runs (why the run ended — agent_done / agent_finished_in_limit / budget_cap / chain_limit / null for failures)",
    up: async (handle) => {
      // Nullable: existing rows pre-fix didn't track this; new code writes
      // it on every run. No backfill needed — historical runs can be
      // re-classified from existing data (cost vs cap, turns vs limit) if
      // analytics ever wants it.
      await handle.db.execute(sql`ALTER TABLE playbook_runs ADD COLUMN IF NOT EXISTS termination_reason TEXT`);
    },
  },
  {
    version: 18,
    description: "Add scope + profile_ids columns to user_integrations for per-agent integration scoping (mirrors user_secrets)",
    up: async (handle) => {
      // Default 'all' preserves existing behavior: every connected
      // integration is available to every agent owned by that user.
      // Flipping a row to scope='agents' restricts it to the profiles
      // listed in profile_ids — the orchestrator filters MCP injection
      // by this gate so a coding agent doesn't suddenly see teller_*
      // tools just because the user has a bank connected.
      await handle.db.execute(sql`ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'all'`);
      await handle.db.execute(sql`ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS profile_ids JSONB NOT NULL DEFAULT '[]'::jsonb`);
    },
  },
  {
    version: 19,
    description: "Add telegram_playbook_threads table for thread-claim routing (feature #18) — links a Telegram message_id to the playbook session that sent it",
    up: async (handle) => {
      await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS telegram_playbook_threads (
        bot_user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        label TEXT,
        sent_at TEXT NOT NULL,
        claimed_at TEXT,
        dismissed_at TEXT,
        PRIMARY KEY (bot_user_id, chat_id, message_id)
      )`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS telegram_playbook_threads_chat_sent_idx ON telegram_playbook_threads(bot_user_id, chat_id, sent_at)`);
      await handle.db.execute(sql`CREATE INDEX IF NOT EXISTS telegram_playbook_threads_session_idx ON telegram_playbook_threads(session_id)`);
    },
  },
  {
    version: 20,
    description: "Re-encrypt all stored ciphertexts with the new HKDF info string (legacy salt 'reclaude-encryption' → 'vonzio-encryption'). No-op on fresh installs; one-shot rewrite on installs that predate this version.",
    up: async (handle) => {
      // ENCRYPTION_KEY is required for both decrypt (legacy salt) and
      // encrypt (new salt). If it's missing we can't decrypt anything;
      // fresh installs with empty tables will also have no rows to
      // process, so a missing key only matters when there's data to
      // migrate — surface that loudly.
      const encryptionKey = process.env.ENCRYPTION_KEY;
      const tables: Array<{ table: string; pk: string; columns: string[] }> = [
        { table: "api_keys",          pk: "id", columns: ["encrypted_api_key", "encrypted_auth_token"] },
        { table: "git_providers",     pk: "id", columns: ["encrypted_token"] },
        { table: "user_integrations", pk: "id", columns: ["encrypted_config"] },
        { table: "user_secrets",      pk: "id", columns: ["encrypted_value"] },
      ];

      // Count what we'd touch so we can early-exit cleanly on empty DBs
      // (the typical OSS first-install path) and so logs are honest about
      // the migration's scope.
      let totalRows = 0;
      for (const { table } of tables) {
        const r = await handle.db.execute<{ cnt: number }>(
          sql.raw(`SELECT COUNT(*)::int AS cnt FROM "${table}"`),
        );
        totalRows += (r.rows[0] as { cnt: number } | undefined)?.cnt ?? 0;
      }
      if (totalRows === 0) {
        console.log(`  migration 20: no encrypted rows in this database — skipping re-encryption`);
        return;
      }
      if (!encryptionKey) {
        throw new Error(
          "Migration 20 requires ENCRYPTION_KEY to be set (re-encrypts " +
            `${totalRows} existing ciphertexts from the legacy salt). Set ENCRYPTION_KEY ` +
            "to the same value the prior process used, then restart.",
        );
      }

      let processed = 0;
      for (const { table, pk, columns } of tables) {
        // We can't use the typed schema for a generic loop, so all queries
        // here go through raw SQL. Column names are hardcoded literals from
        // the table descriptor above — no user input touches the SQL string.
        const colList = ["id", ...columns].map((c) => `"${c}"`).join(", ");
        const rows = await handle.db.execute(sql.raw(`SELECT ${colList} FROM "${table}"`));
        for (const raw of rows.rows) {
          const row = raw as Record<string, string | null>;
          const updates: Record<string, string> = {};
          for (const col of columns) {
            const ciphertext = row[col];
            if (!ciphertext) continue; // nullable column with no value
            try {
              const plaintext = decryptLegacy(ciphertext, encryptionKey);
              updates[col] = encrypt(plaintext, encryptionKey);
            } catch (err) {
              throw new Error(
                `Migration 20 failed to decrypt ${table}.${col} for ${pk}=${row[pk]} — ` +
                  `is ENCRYPTION_KEY the same value used to write this data? ` +
                  `(${err instanceof Error ? err.message : String(err)})`,
              );
            }
          }
          if (Object.keys(updates).length === 0) continue;
          // Build the SET clause + parameter list via drizzle's sql template
          // so values are properly parameterized (no string interpolation
          // into the SQL string). Ciphertexts are hex/colon-formatted ASCII
          // so injection isn't a real risk here, but parameters are cleaner.
          const setFragments = Object.entries(updates).map(
            ([col, val]) => sql`${sql.raw(`"${col}"`)} = ${val}`,
          );
          const setClause = sql.join(setFragments, sql`, `);
          await handle.db.execute(
            sql`UPDATE ${sql.raw(`"${table}"`)} SET ${setClause} WHERE ${sql.raw(`"${pk}"`)} = ${row[pk]}`,
          );
          processed += 1;
        }
      }
      console.log(`  migration 20: re-encrypted ${processed} row(s) across ${tables.length} tables`);
    },
  },
];

/**
 * Run all pending migrations.
 * Safe to call on every startup — only runs migrations that haven't been applied yet.
 */
export async function runMigrations(handle: DB): Promise<void> {
  // Create migrations tracking table
  await handle.db.execute(sql`CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  // Get current version
  const rows = await handle.db.execute<{ version: number }>(
    sql`SELECT version FROM _migrations ORDER BY version DESC LIMIT 1`,
  );
  const currentVersion = rows.rows.length > 0 ? (rows.rows[0] as { version: number }).version : -1;

  // Run pending migrations
  const pending = migrations.filter((m) => m.version > currentVersion);
  if (pending.length === 0) return;

  for (const migration of pending) {
    console.log(`Running migration ${migration.version}: ${migration.description}`);
    await migration.up(handle);
    await handle.db.execute(
      sql`INSERT INTO _migrations (version, description, applied_at) VALUES (${migration.version}, ${migration.description}, ${new Date().toISOString()})`,
    );
  }

  console.log(`Applied ${pending.length} migration(s). Current version: ${migrations[migrations.length - 1].version}`);
}
