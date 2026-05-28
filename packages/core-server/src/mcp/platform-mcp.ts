import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { PlaybookService, CreatePlaybookInput } from "../services/playbook-service.js";
import type { TaskService, SubmitTaskInput } from "../services/task-service.js";
import type { ChainRunner } from "../orchestrator/chain-runner.js";
import type { IntegrationService, SlackConfig } from "../services/integration-service.js";
import type { SlackService } from "../services/slack-service.js";
import type { WorkspaceService } from "../services/workspace-service.js";
import type { ProfileService } from "../services/profile-service.js";
import type { EventLog } from "../events/event-log.js";
import type { Workspace, WorkspaceStatus } from "@vonzio/shared";
import { WORKSPACE_STATUSES } from "@vonzio/shared";

interface PlatformMcpSession {
  userId: string;
  profileId: string;
  /** SaaS tenant scope — null on OSS / when the workspace pre-dates the
   *  v9 backfill. Passed into every playbook/workspace service call so
   *  agent-initiated platform ops respect the same org boundary as the
   *  HTTP routes. */
  orgId: string | null;
}

export interface PlatformMcpOptions {
  playbookService: PlaybookService;
  taskService: TaskService;
  chainRunner: ChainRunner;
  integrationService: IntegrationService;
  slackService: SlackService;
  workspaceService: WorkspaceService;
  profileService: ProfileService;
  eventLog: EventLog;
  resolveSession: (token: string) => PlatformMcpSession | null;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

function rpcResult(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: number | string, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError && { isError: true }) };
}

const TOOL_DEFINITIONS = [
  // ─── Playbook tools ───
  {
    name: "playbook_create",
    description:
      "Create a new playbook (automated workflow) on the Vonzio platform. Playbooks run agent tasks on a schedule or on-demand with chaining support.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Playbook name" },
        prompt: { type: "string", description: "The task prompt the playbook will execute" },
        description: { type: "string", description: "Brief description of what this playbook does" },
        schedule: { type: "string", description: "Cron expression (e.g. '0 9 * * 1' for every Monday at 9am). Use '' for manual-only." },
        trigger_type: { type: "string", enum: ["cron", "interval", "manual", "webhook"], description: "How the playbook is triggered (default: manual)" },
        max_chains: { type: "number", description: "Max continuation chains per run (default: 5)" },
        budget_cap_usd: { type: "number", description: "Max cost per run in USD (default: 10)" },
        max_turns_per_chain: { type: "number", description: "Max turns per chain (default: 200)" },
        enabled: { type: "boolean", description: "Whether the playbook is active (default: true)" },
      },
      required: ["name", "prompt"],
    },
  },
  {
    name: "playbook_list",
    description: "List all playbooks for the current user.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "playbook_get",
    description: "Get full details of a playbook by ID, including chain config, schedule, and last run info.",
    inputSchema: {
      type: "object",
      properties: {
        playbook_id: { type: "string", description: "The playbook ID" },
      },
      required: ["playbook_id"],
    },
  },
  {
    name: "playbook_update",
    description: "Update a playbook's settings — prompt, schedule, chain config, or enabled state.",
    inputSchema: {
      type: "object",
      properties: {
        playbook_id: { type: "string", description: "The playbook ID to update" },
        name: { type: "string" },
        prompt: { type: "string" },
        description: { type: "string" },
        schedule: { type: "string" },
        enabled: { type: "boolean" },
        max_chains: { type: "number" },
        budget_cap_usd: { type: "number" },
        max_turns_per_chain: { type: "number" },
      },
      required: ["playbook_id"],
    },
  },
  {
    name: "playbook_run",
    description: "Trigger a playbook to run immediately. Returns the run ID for monitoring.",
    inputSchema: {
      type: "object",
      properties: {
        playbook_id: { type: "string", description: "The playbook ID to execute" },
      },
      required: ["playbook_id"],
    },
  },
  {
    name: "playbook_run_status",
    description: "Check the status of a playbook run — chains completed, turns used, cost, and result summary.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "The run ID to check" },
      },
      required: ["run_id"],
    },
  },

  // ─── Task tools ───
  {
    name: "task_submit",
    description:
      "Submit a new task to the Vonzio platform for execution by an agent. The task runs in its own container with full tool access.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task prompt" },
        mode: { type: "string", enum: ["batch", "pooled", "session"], description: "Execution mode (default: session)" },
        max_turns: { type: "number", description: "Max turns for this task" },
        max_budget_usd: { type: "number", description: "Budget cap in USD" },
        model: { type: "string", enum: ["sonnet", "opus", "haiku"], description: "Model to use" },
        session_id: { type: "string", description: "Session ID to run in (for continuing work in an existing workspace)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "task_get",
    description: "Get the status and result of a submitted task.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task ID" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "task_list",
    description: "List recent tasks with optional status filter.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["submitted", "queued", "running", "done", "failed", "cancelled"] },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
    },
  },

  // ─── Workspace tools ───
  {
    name: "workspace_list",
    description:
      "List the caller's Vonzio workspaces. Each workspace is a long-lived chat session backed by a container. Use this to see active sessions, what model they're running, and whether they have a model override.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["active", "idle", "paused", "resumable", "expired"],
          description: "Filter by workspace status",
        },
        starred: { type: "boolean", description: "Only return starred workspaces" },
        archived: { type: "boolean", description: "If false (default), excludes archived workspaces" },
        limit: { type: "number", description: "Max results (default: 50, capped at 200)" },
      },
    },
  },
  {
    name: "workspace_get",
    description:
      "Get full state of a workspace by session_id, including container status, model_override, last_run_model, and counts of recent tasks.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The workspace session ID" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "workspace_update",
    description:
      "Update a workspace's mutable fields. Use to set name, star/archive state, or model_override (which forces every subsequent task in the workspace to use the given model).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The workspace session ID" },
        name: { type: "string" },
        starred: { type: "boolean" },
        archived: { type: "boolean" },
        model_override: {
          type: ["string", "null"],
          description: "Per-workspace model override. Pass null to clear and fall back to the profile's default model.",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "workspace_terminate",
    description:
      "Terminate a workspace — stops and removes its container, marks the workspace expired. The session_id remains queryable but no further tasks will run.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The workspace session ID" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "workspace_events",
    description:
      "Page through the structured event log for a workspace. Each event has {seq, type, data, ts} and represents one tool call, tool result, assistant message, or lifecycle event from the agent. Use the cursor (last seen seq) to fetch only new events on subsequent calls.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The workspace session ID" },
        after_seq: {
          type: "number",
          description: "Return only events with seq strictly greater than this. Default 0 (all events).",
        },
        limit: {
          type: "number",
          description: "Max events to return (default 200, capped at 1000). Pagination is by seq cursor — fetch the next page by passing the last returned seq as after_seq.",
        },
        types: {
          type: "array",
          items: { type: "string" },
          description: "Optional filter — only return events whose type is in this list (e.g. ['tool_use','tool_result']).",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "workspace_transcript",
    description:
      "Build a flattened plain-text transcript of a workspace's conversation, suitable for handing off to another model or for human review. This is the same renderer used for cross-model context replay. For structured per-tool data, use workspace_events instead.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The workspace session ID" },
        max_chars: {
          type: "number",
          description: "Truncate transcript to this many characters (default 80000). Truncation keeps the most recent content.",
        },
      },
      required: ["session_id"],
    },
  },

  // ─── Profile tools (read-only) ───
  {
    name: "profile_list",
    description:
      "List agent profiles available to the caller. Profiles define the model, tools, MCP servers, claude.md, and other settings used when an agent runs. Secrets are redacted.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "profile_get",
    description:
      "Get one profile's full configuration by ID. Secrets in mcp_servers env/headers and container_registry are redacted.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "string", description: "The profile ID" },
      },
      required: ["profile_id"],
    },
  },

  // ─── Playbook run history ───
  {
    name: "playbook_run_list",
    description:
      "List recent playbook runs for the caller, optionally filtered to a single playbook. Returns status, cost, turn count, and decision result for each run.",
    inputSchema: {
      type: "object",
      properties: {
        playbook_id: {
          type: "string",
          description: "Optional — restrict to runs of this playbook. Otherwise returns the user's most recent runs across all playbooks.",
        },
        limit: { type: "number", description: "Max results (default 20, capped at 100)" },
      },
    },
  },

  // ─── Slack tools ───
  {
    name: "slack_post_message",
    description:
      "Post a message to a Slack channel or DM a user. Use a #channel name to post to a channel, or a @username / user ID to send a DM.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Channel name (e.g. '#general'), channel ID (e.g. 'C01234'), user ID (e.g. 'U01234'), or @username to DM",
        },
        text: { type: "string", description: "Message text (supports Slack markdown/mrkdwn)" },
        thread_ts: { type: "string", description: "Thread timestamp to reply in a thread (optional)" },
      },
      required: ["target", "text"],
    },
  },
  {
    name: "slack_list_channels",
    description: "List public Slack channels the bot has access to.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function handleToolCall(
  playbookService: PlaybookService,
  taskService: TaskService,
  chainRunner: ChainRunner,
  integrationService: IntegrationService,
  slackService: SlackService,
  workspaceService: WorkspaceService,
  profileService: ProfileService,
  eventLog: EventLog,
  session: PlatformMcpSession,
  toolName: string,
  args: Record<string, unknown>,
) {
  const { userId, profileId, orgId } = session;
  // Coalesce null → undefined so service methods that take `orgId?: string`
  // treat OSS / pre-backfill rows as "no scoping". Drizzle's eq() rejects
  // null and the OSS path expects undefined.
  const scopedOrgId = orgId ?? undefined;

  // Resolve and authorize a workspace by session_id arg in one step. Returns
  // either the workspace or a ready-to-return tool error. Same opaque error
  // for missing/not-found/not-yours so existence isn't leaked across users
  // or orgs.
  function requireOwnedWorkspace(args: Record<string, unknown>): { workspace: Workspace } | { error: ReturnType<typeof toolResult> } {
    const sessionId = args.session_id;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return { error: toolResult("Missing required parameter: session_id", true) };
    }
    const w = workspaceService.get(sessionId);
    if (!w || w.user_id !== userId) {
      return { error: toolResult("Workspace not found", true) };
    }
    // Org-scope check: when the MCP session is bound to a tenant, the
    // requested workspace must belong to the same tenant. Without this,
    // an agent in tenant A could enumerate tenant B's workspaces via
    // session_id smuggling (same user_id, different org).
    if (orgId && w.org_id !== orgId) {
      return { error: toolResult("Workspace not found", true) };
    }
    return { workspace: w };
  }

  // Coerce a JSON-RPC numeric arg to an integer in [min, max], with default.
  function clampInt(value: unknown, def: number, min: number, max: number): number {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : def;
    return Math.max(min, Math.min(n, max));
  }

  // Helper: resolve @username to Slack user ID
  async function resolveSlackUser(botToken: string, username: string): Promise<string | null> {
    const res = await fetch("https://slack.com/api/users.list", {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const data = (await res.json()) as Record<string, unknown>;
    const members = (data.members ?? []) as Array<{ id: string; name: string; real_name: string }>;
    const found = members.find((m) => m.name === username || m.real_name.toLowerCase() === username.toLowerCase());
    return found?.id ?? null;
  }

  switch (toolName) {
    // ─── Playbooks ───
    case "playbook_create": {
      const name = args.name as string;
      const prompt = args.prompt as string;
      if (!name || !prompt) return toolResult("Missing required parameters: name, prompt", true);

      const input: CreatePlaybookInput = {
        profile_id: profileId,
        name,
        prompt,
        description: (args.description as string) ?? "",
        schedule: (args.schedule as string) ?? "",
        trigger_type: (args.trigger_type as "cron" | "interval" | "manual" | "webhook") ?? "manual",
        enabled: (args.enabled as boolean) ?? true,
        chain_config: {
          max_chains: (args.max_chains as number) ?? 5,
          budget_cap_usd: (args.budget_cap_usd as number) ?? 10,
          chain_delay_ms: 5000,
          max_turns_per_chain: args.max_turns_per_chain as number | undefined,
        },
      };

      const playbook = await playbookService.create(userId, input, scopedOrgId);
      return toolResult(
        `Playbook created successfully.\nID: ${playbook.id}\nName: ${playbook.name}\nTrigger: ${playbook.trigger_type}\nEnabled: ${playbook.enabled}`,
      );
    }

    case "playbook_list": {
      const playbooks = await playbookService.list(userId, scopedOrgId);
      if (playbooks.length === 0) return toolResult("No playbooks found.");

      const lines = playbooks.map((p) =>
        `ID: ${p.id} | ${p.name} | ${p.trigger_type} | ${p.enabled ? "enabled" : "disabled"} | Last run: ${p.last_run_at ?? "never"}`,
      );
      return toolResult(`Playbooks (${playbooks.length}):\n${lines.join("\n")}`);
    }

    case "playbook_get": {
      const id = args.playbook_id as string;
      if (!id) return toolResult("Missing required parameter: playbook_id", true);

      const playbook = await playbookService.get(id, { userId, orgId: scopedOrgId });
      if (!playbook) return toolResult("Playbook not found", true);

      return toolResult(JSON.stringify(playbook, null, 2));
    }

    case "playbook_update": {
      const id = args.playbook_id as string;
      if (!id) return toolResult("Missing required parameter: playbook_id", true);

      const updates: Partial<CreatePlaybookInput> = {};
      if (args.name !== undefined) updates.name = args.name as string;
      if (args.prompt !== undefined) updates.prompt = args.prompt as string;
      if (args.description !== undefined) updates.description = args.description as string;
      if (args.schedule !== undefined) updates.schedule = args.schedule as string;
      if (args.enabled !== undefined) updates.enabled = args.enabled as boolean;

      if (args.max_chains !== undefined || args.budget_cap_usd !== undefined || args.max_turns_per_chain !== undefined) {
        const existing = await playbookService.get(id, { userId, orgId: scopedOrgId });
        if (!existing) return toolResult("Playbook not found", true);
        updates.chain_config = {
          ...existing.chain_config,
          ...(args.max_chains !== undefined && { max_chains: args.max_chains as number }),
          ...(args.budget_cap_usd !== undefined && { budget_cap_usd: args.budget_cap_usd as number }),
          ...(args.max_turns_per_chain !== undefined && { max_turns_per_chain: args.max_turns_per_chain as number }),
        };
      }

      const updated = await playbookService.update(id, userId, updates, scopedOrgId);
      if (!updated) return toolResult("Playbook not found or access denied", true);

      return toolResult(`Playbook ${id} updated successfully.`);
    }

    case "playbook_run": {
      const id = args.playbook_id as string;
      if (!id) return toolResult("Missing required parameter: playbook_id", true);

      const playbook = await playbookService.get(id, { userId, orgId: scopedOrgId });
      if (!playbook) return toolResult("Playbook not found", true);

      // Fire-and-forget — the chain runner handles the execution
      const runPromise = chainRunner.execute(playbook, userId);
      // Wait briefly to get the run ID
      const run = await runPromise.catch((err) => {
        throw new Error(`Failed to start playbook run: ${err instanceof Error ? err.message : String(err)}`);
      });

      return toolResult(
        `Playbook run started.\nRun ID: ${run.id}\nStatus: ${run.status}\nSession: ${run.session_id}`,
      );
    }

    case "playbook_run_status": {
      const runId = args.run_id as string;
      if (!runId) return toolResult("Missing required parameter: run_id", true);

      const run = await playbookService.getRun(runId);
      if (!run || run.user_id !== userId) return toolResult("Run not found", true);
      // Org boundary: runs don't carry org_id themselves — inherit
      // from the parent playbook. Reject if the playbook isn't in our
      // tenant (same opaque "not found" message).
      if (scopedOrgId) {
        const parent = await playbookService.get(run.playbook_id, { userId, orgId: scopedOrgId });
        if (!parent) return toolResult("Run not found", true);
      }

      const lines = [
        `Run ID: ${run.id}`,
        `Playbook: ${run.playbook_name ?? run.playbook_id}`,
        `Status: ${run.status}`,
        `Chains: ${run.chain_count}`,
        `Turns: ${run.total_turns}`,
        `Cost: $${run.total_cost_usd.toFixed(4)}`,
        `Decision: ${run.decision_result ?? "pending"}`,
      ];
      if (run.result_summary) lines.push(`Summary: ${run.result_summary}`);
      if (run.error) lines.push(`Error: ${run.error}`);
      if (run.started_at) lines.push(`Started: ${run.started_at}`);
      if (run.finished_at) lines.push(`Finished: ${run.finished_at}`);

      return toolResult(lines.join("\n"));
    }

    // ─── Tasks ───
    case "task_submit": {
      const prompt = args.prompt as string;
      if (!prompt) return toolResult("Missing required parameter: prompt", true);

      const input: SubmitTaskInput = {
        prompt,
        profile_id: profileId,
        mode: (args.mode as "batch" | "pooled" | "session") ?? "session",
        max_turns: args.max_turns as number | undefined,
        max_budget_usd: args.max_budget_usd as number | undefined,
        model: args.model as string | undefined,
        session_id: args.session_id as string | undefined,
      };

      const result = await taskService.submit(input, [profileId]);
      return toolResult(`Task submitted.\nTask ID: ${result.task_id}\nStatus: ${result.status}`);
    }

    case "task_get": {
      const taskId = args.task_id as string;
      if (!taskId) return toolResult("Missing required parameter: task_id", true);

      const task = await taskService.get(taskId);
      if (!task) return toolResult("Task not found", true);

      const lines = [
        `Task ID: ${task.id}`,
        `Status: ${task.status}`,
        `Mode: ${task.mode}`,
        `Turns: ${task.result?.turns ?? 0}`,
        `Cost: $${task.result?.cost_usd?.toFixed(4) ?? "0.0000"}`,
      ];
      if (task.result?.text) lines.push(`Result: ${task.result.text.slice(0, 2000)}`);
      if (task.error) lines.push(`Error: ${task.error}`);

      return toolResult(lines.join("\n"));
    }

    case "task_list": {
      const { tasks } = await taskService.list({
        profileIds: [profileId],
        status: args.status as "submitted" | "queued" | "running" | "done" | "failed" | "cancelled" | undefined,
        limit: Math.min((args.limit as number) || 20, 50),
      });

      if (tasks.length === 0) return toolResult("No tasks found.");

      const lines = tasks.map((t) =>
        `${t.id} | ${t.status} | ${t.mode} | turns:${t.result?.turns ?? 0} | $${t.result?.cost_usd?.toFixed(4) ?? "0"} | ${t.created_at}`,
      );
      return toolResult(`Tasks (${tasks.length}):\n${lines.join("\n")}`);
    }

    // ─── Workspaces ───
    case "workspace_list": {
      let status: WorkspaceStatus | undefined;
      if (typeof args.status === "string") {
        if (!(WORKSPACE_STATUSES as readonly string[]).includes(args.status)) {
          return toolResult(`Invalid status. Must be one of: ${WORKSPACE_STATUSES.join(", ")}`, true);
        }
        status = args.status as WorkspaceStatus;
      }
      const limit = clampInt(args.limit, 50, 1, 200);
      const includeArchived = args.archived === true; // default: hide archived
      const starredOnly = args.starred === true;

      const { workspaces } = await workspaceService.list({
        userId,
        orgId: scopedOrgId,
        status,
        includeArchived,
        starredOnly,
        limit,
      });

      if (workspaces.length === 0) return toolResult("No workspaces found.");

      const lines = workspaces.map((w) => {
        const name = w.name ?? "(unnamed)";
        const flags: string[] = [];
        if (w.starred) flags.push("starred");
        if (w.archived) flags.push("archived");
        if (w.persistent) flags.push("persistent");
        if (w.model_override) flags.push(`override=${w.model_override}`);
        return `${w.session_id} | ${w.status} | ${name} | last_active=${w.last_active_at}${flags.length ? " | " + flags.join(",") : ""}`;
      });
      return toolResult(`Workspaces (${workspaces.length}):\n${lines.join("\n")}`);
    }

    case "workspace_get": {
      const r = requireOwnedWorkspace(args);
      if ("error" in r) return r.error;
      const { workspace } = r;

      // Push session_id filter down to SQL so a busy profile doesn't crowd
      // out this session's tasks.
      const { tasks } = await taskService.list({ sessionId: workspace.session_id, limit: 50 });
      const counts: Record<string, number> = {};
      for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;

      return toolResult(JSON.stringify({ workspace, recent_task_counts: counts, recent_tasks_total: tasks.length }, null, 2));
    }

    case "workspace_update": {
      const r = requireOwnedWorkspace(args);
      if ("error" in r) return r.error;
      const { workspace: existing } = r;

      const updates: Parameters<WorkspaceService["update"]>[1] = {};
      if (typeof args.name === "string") updates.name = args.name;
      if (typeof args.starred === "boolean") updates.starred = args.starred;
      if (typeof args.archived === "boolean") updates.archived = args.archived;
      if (args.model_override !== undefined) {
        if (args.model_override === null) {
          updates.model_override = null;
        } else if (typeof args.model_override === "string" && args.model_override.length > 0) {
          updates.model_override = args.model_override;
        } else {
          return toolResult("model_override must be a non-empty string or null", true);
        }
      }

      if (Object.keys(updates).length === 0) {
        return toolResult("No updatable fields supplied — allowed: name, starred, archived, model_override", true);
      }

      const updated = await workspaceService.update(existing.session_id, updates, { orgId: scopedOrgId });
      if (!updated) return toolResult("Workspace not found", true);
      return toolResult(`Workspace ${existing.session_id} updated.\n${JSON.stringify(updates, null, 2)}`);
    }

    case "workspace_terminate": {
      const r = requireOwnedWorkspace(args);
      if ("error" in r) return r.error;
      const { workspace: existing } = r;

      const ok = await workspaceService.terminate(existing.session_id);
      if (!ok) return toolResult("Workspace not found", true);
      return toolResult(`Workspace ${existing.session_id} terminated.`);
    }

    case "workspace_events": {
      const r = requireOwnedWorkspace(args);
      if ("error" in r) return r.error;
      const { workspace } = r;

      const afterSeq = clampInt(args.after_seq, 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = clampInt(args.limit, 200, 1, 1000);
      const types = Array.isArray(args.types)
        ? (args.types as unknown[]).filter((t): t is string => typeof t === "string")
        : null;

      // Flush any buffered tokens so freshly-streamed text isn't missed.
      eventLog.flushTokens(workspace.session_id);

      const all = eventLog.read(workspace.session_id, afterSeq);
      const filtered = types && types.length > 0 ? all.filter((e) => types.includes(e.type)) : all;
      const page = filtered.slice(0, limit);
      const nextCursor = page.length > 0 ? page[page.length - 1].seq : afterSeq;
      const hasMore = filtered.length > limit;

      return toolResult(
        JSON.stringify(
          {
            session_id: workspace.session_id,
            count: page.length,
            next_after_seq: nextCursor,
            has_more: hasMore,
            events: page,
          },
          null,
          2,
        ),
      );
    }

    case "workspace_transcript": {
      const r = requireOwnedWorkspace(args);
      if ("error" in r) return r.error;
      const { workspace } = r;

      const maxChars = clampInt(args.max_chars, 80_000, 1_000, 500_000);
      eventLog.flushTokens(workspace.session_id);
      const transcript = eventLog.buildTranscript(workspace.session_id, maxChars);
      return toolResult(transcript || "(no transcript available — workspace may have no recorded turns yet)");
    }

    // ─── Profiles (read-only) ───
    case "profile_list": {
      const profiles = await profileService.list(userId);
      if (profiles.length === 0) return toolResult("No profiles available.");
      const lines = profiles.map((p) => {
        const tools = Array.isArray(p.default_tools) ? p.default_tools.length : 0;
        const mcp = Array.isArray(p.mcp_servers) ? p.mcp_servers.length : 0;
        return `${p.id} | ${p.name} | model=${p.model ?? "(default)"} | tools=${tools} | mcp=${mcp}`;
      });
      return toolResult(`Profiles (${profiles.length}):\n${lines.join("\n")}`);
    }

    case "profile_get": {
      const id = args.profile_id;
      if (typeof id !== "string" || id.length === 0) {
        return toolResult("Missing required parameter: profile_id", true);
      }
      const profile = await profileService.get(id);
      // ProfileService.list() scopes to user_id = caller OR user_id IS NULL
      // (shared/system profiles). Mirror that here. Same opaque error in both
      // missing/unauthorized cases so cross-user existence isn't leaked.
      if (!profile || (profile.user_id && profile.user_id !== userId)) {
        return toolResult("Profile not found", true);
      }
      // get() already returns mcp_servers + container_registry redacted via mapRow.
      return toolResult(JSON.stringify(profile, null, 2));
    }

    // ─── Playbook run history ───
    case "playbook_run_list": {
      const limit = clampInt(args.limit, 20, 1, 100);
      const playbookId = typeof args.playbook_id === "string" && args.playbook_id.length > 0 ? args.playbook_id : undefined;

      const runs = await playbookService.listRunsForUser(userId, limit, playbookId, scopedOrgId);

      if (runs.length === 0) return toolResult("No playbook runs found.");

      const lines = runs.map((r) => {
        const cost = typeof r.total_cost_usd === "number" ? r.total_cost_usd.toFixed(4) : "0.0000";
        return `${r.id} | ${r.playbook_name ?? r.playbook_id} | ${r.status} | chains=${r.chain_count} | turns=${r.total_turns} | $${cost} | ${r.started_at}`;
      });
      return toolResult(`Playbook runs (${runs.length}):\n${lines.join("\n")}`);
    }

    // ─── Slack ───
    case "slack_post_message": {
      const target = args.target as string;
      const text = args.text as string;
      if (!target || !text) return toolResult("Missing required parameters: target, text", true);

      const slackIntegration = await integrationService.getByUserAndType(userId, "slack");
      if (!slackIntegration) return toolResult("Slack is not connected. Ask the user to connect Slack in Settings > Integrations.", true);
      const slackConfig = slackIntegration.config as unknown as SlackConfig;

      let channelId: string;

      if (target.startsWith("#")) {
        // Resolve channel name to ID
        const channelName = target.slice(1);
        const listRes = await fetch("https://slack.com/api/conversations.list", {
          headers: { Authorization: `Bearer ${slackConfig.bot_token}` },
        });
        const listData = (await listRes.json()) as Record<string, unknown>;
        const channels = (listData.channels ?? []) as Array<{ id: string; name: string }>;
        const found = channels.find((c) => c.name === channelName);
        if (!found) return toolResult(`Channel #${channelName} not found. The bot may not have access to it.`, true);
        channelId = found.id;
        // Join the channel in case the bot isn't a member
        await slackService.joinChannel(slackConfig.bot_token, channelId);
      } else if (target.startsWith("@") || target.startsWith("U")) {
        // DM a user — open a conversation
        const slackUserId = target.startsWith("@") ? await resolveSlackUser(slackConfig.bot_token, target.slice(1)) : target;
        if (!slackUserId) return toolResult(`User ${target} not found in the Slack workspace.`, true);
        const openRes = await fetch("https://slack.com/api/conversations.open", {
          method: "POST",
          headers: { Authorization: `Bearer ${slackConfig.bot_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ users: slackUserId }),
        });
        const openData = (await openRes.json()) as Record<string, unknown>;
        if (!openData.ok) return toolResult(`Failed to open DM: ${openData.error}`, true);
        channelId = ((openData.channel as Record<string, unknown>)?.id as string) ?? "";
      } else {
        // Assume it's a channel ID directly
        channelId = target;
      }

      const result = await slackService.sendMessage(slackConfig.bot_token, {
        channel: channelId,
        text,
        thread_ts: args.thread_ts as string | undefined,
      });

      return toolResult(`Message posted successfully. Timestamp: ${result.ts}`);
    }

    case "slack_list_channels": {
      const slackIntegration = await integrationService.getByUserAndType(userId, "slack");
      if (!slackIntegration) return toolResult("Slack is not connected.", true);
      const slackConfig = slackIntegration.config as unknown as SlackConfig;

      const res = await fetch("https://slack.com/api/conversations.list?types=public_channel&limit=200", {
        headers: { Authorization: `Bearer ${slackConfig.bot_token}` },
      });
      const data = (await res.json()) as Record<string, unknown>;
      const channels = (data.channels ?? []) as Array<{ id: string; name: string; num_members: number; is_member: boolean }>;

      if (channels.length === 0) return toolResult("No channels found.");

      const lines = channels
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => `#${c.name} (${c.id}) — ${c.num_members} members${c.is_member ? " [joined]" : ""}`);
      return toolResult(`Channels (${channels.length}):\n${lines.join("\n")}`);
    }

    default:
      return toolResult(`Unknown tool: ${toolName}`, true);
  }
}

export const platformMcpPlugin = fp(
  async (server: FastifyInstance, opts: PlatformMcpOptions) => {
    const { playbookService, taskService, chainRunner, integrationService, slackService, workspaceService, profileService, eventLog, resolveSession } = opts;

    server.post("/mcp/platform", async (request, reply) => {
      const body = request.body as JsonRpcRequest;
      const id = body.id ?? 0;

      if (body.jsonrpc !== "2.0" || !body.method) {
        return reply.send(rpcError(id, -32600, "Invalid JSON-RPC request"));
      }

      const authHeader = request.headers.authorization;
      const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

      if (!token) {
        return reply.send(rpcError(id, -32000, "Missing Authorization header"));
      }

      const session = resolveSession(token);
      if (!session) {
        return reply.send(rpcError(id, -32000, "Invalid or expired session token"));
      }

      switch (body.method) {
        case "initialize":
          return reply.send(
            rpcResult(id, {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "vonzio-platform", version: "1.0.0" },
            }),
          );

        case "notifications/initialized":
          return reply.send(rpcResult(id, {}));

        case "tools/list":
          return reply.send(rpcResult(id, { tools: TOOL_DEFINITIONS }));

        case "tools/call": {
          const params = body.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
          if (!params?.name) {
            return reply.send(rpcError(id, -32602, "Missing tool name in params"));
          }

          try {
            const result = await handleToolCall(playbookService, taskService, chainRunner, integrationService, slackService, workspaceService, profileService, eventLog, session, params.name, params.arguments ?? {});
            return reply.send(rpcResult(id, result));
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            server.log.error({ err, tool: params.name }, "Platform MCP tool call failed");
            return reply.send(rpcResult(id, toolResult(message, true)));
          }
        }

        default:
          return reply.send(rpcError(id, -32601, `Method not found: ${body.method}`));
      }
    });
  },
  { name: "platform-mcp" },
);
