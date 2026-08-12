import type { FastifyInstance, FastifyRequest } from "fastify";
import type WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { ConnectionManager } from "./connection.js";
import { generateTitle, heuristicTitle } from "../services/title-service.js";
import type { TaskService } from "../services/task-service.js";
import { ForbiddenError } from "../services/task-service.js";
import type { WorkspaceService } from "../services/workspace-service.js";
import type { SessionRegistry } from "../container/session-registry.js";
import type { Orchestrator, Logger } from "../orchestrator/orchestrator.js";
import type { ProfileService } from "../services/profile-service.js";
import type { ContainerManager } from "@vonzio/shared";
import type { Workspace } from "@vonzio/shared";
import type { ClientMessage } from "@vonzio/shared";
import type { TaskAttachment } from "@vonzio/shared";
import type { ImageRewriterService } from "../services/image-rewriter-service.js";
import { rewriteAgentImages } from "../services/agent-output-rewriter.js";
import type { EventLog } from "../events/event-log.js";
import { ErrorCodes } from "../errors.js";
import { submitTaskSchema } from "../routes/validation.js";
import { runWithOrgId, getActiveOrgId } from "../lib/active-org.js";
import { SlidingWindowRateLimiter } from "../rate-limit/sliding-window.js";
import type { RateLimitResult } from "@vonzio/shared";


export interface WsHandlerOptions {
  connectionManager: ConnectionManager;
  taskService: TaskService;
  workspaceService: WorkspaceService;
  sessionRegistry: SessionRegistry;
  orchestrator: Orchestrator;
  containerManager: ContainerManager;
  profileService: ProfileService;
  eventLog: EventLog;
  imageRewriterService: ImageRewriterService;
  log?: Logger;
  /**
   * Optional SaaS hook (see CoreDeps.recordTaskOrg) — when present and
   * a WS submit message arrives on a connection with a pinned org id,
   * we link the new task to that org so the orchestrator can resolve
   * it before launching the workspace. OSS deployments leave this
   * undefined.
   */
  recordTaskOrg?: (taskId: string, orgId: string) => Promise<void>;
  /** SaaS hook — subset of candidate profile ids visible in the active org
   *  (null = no filter / OSS). Keeps WS task visibility + submission within
   *  the connection's tenant boundary, mirroring the REST /v1/tasks route. */
  visibleProfileIdsForOrg?: (
    userId: string,
    activeOrgId: string | null,
    candidates: string[],
  ) => Promise<Set<string> | null>;
}

const ORCHESTRATOR_EVENTS = [
  "task:system_prompt",
  "task:token",
  "task:tool_use",
  "task:tool_result",
  "task:ask_user",
  "task:done",
  "task:failed",
  "task:container",
  "task:continuing",
  "task:goal_eval",
  "task:goal_stop",
  "task:goal_judging",
  "task:local_tool_call",
] as const;

export function setupWsHandler(
  server: FastifyInstance,
  opts: WsHandlerOptions,
): () => void {
  const { connectionManager, taskService, orchestrator, eventLog, imageRewriterService, log: baseLog } = opts;
  const wsLog = baseLog?.child?.({ component: "ws" });

  // Per-token request-rate limit on the WS task-submission path. API-token
  // callers (the embeddable chat's `rc_` key lives in public page HTML) are
  // throttled to their token's rate_limit_rpm — without this a lifted public
  // token could drive unlimited agent runs (cost/DoS). Keyed by token owner;
  // one limiter per distinct rpm (most tokens share the default). Session-cookie
  // users are not throttled here (they're authenticated dashboard users).
  const tokenRateLimiters = new Map<number, SlidingWindowRateLimiter>();
  function checkTokenRate(user: { id: string; role: string; rateLimitRpm?: number }): RateLimitResult {
    if (user.role !== "api_token") return { allowed: true };
    const rpm = user.rateLimitRpm && user.rateLimitRpm > 0 ? user.rateLimitRpm : 60;
    let limiter = tokenRateLimiters.get(rpm);
    if (!limiter) {
      limiter = new SlidingWindowRateLimiter(60_000, rpm);
      tokenRateLimiters.set(rpm, limiter);
    }
    return limiter.tryConsume(user.id);
  }

  // Relay orchestrator events to WS clients + persist to event log
  const relayToSubscribers = (taskId: string, sessionId: string | undefined, msg: Record<string, unknown>) => {
    if (sessionId) {
      connectionManager.sendToSession(sessionId, msg);
      eventLog.append(sessionId, msg.type as string, msg);
    } else {
      connectionManager.sendToTask(taskId, msg);
    }
  };

  orchestrator.on("task:system_prompt", (taskId: string, sessionId: string | undefined, prompt: string) => {
    relayToSubscribers(taskId, sessionId, { type: "system_prompt", task_id: taskId, session_id: sessionId, prompt });
  });

  orchestrator.on("task:token", (taskId: string, sessionId: string | undefined, text: string) => {
    relayToSubscribers(taskId, sessionId, { type: "token", task_id: taskId, session_id: sessionId, text });
  });

  // Local-exec: fan a local tool call out to the session's CLI. Sent directly
  // (not via relayToSubscribers) so these in-flight RPC frames are NOT written
  // to the event log — replaying a stale localtool.call would re-trigger it.
  orchestrator.on(
    "task:local_tool_call",
    (sessionId: string, callId: string, tool: string, input: Record<string, unknown>) => {
      connectionManager.sendToSession(sessionId, { type: "localtool.call", session_id: sessionId, call_id: callId, tool, input });
    },
  );

  orchestrator.on("task:tool_use", (taskId: string, sessionId: string | undefined, tool: string, input: unknown) => {
    relayToSubscribers(taskId, sessionId, { type: "tool_use", task_id: taskId, session_id: sessionId, tool, input });
  });

  orchestrator.on("task:tool_result", (taskId: string, sessionId: string | undefined, tool: string, output: string) => {
    relayToSubscribers(taskId, sessionId, { type: "tool_result", task_id: taskId, session_id: sessionId, tool, output });
  });

  orchestrator.on("task:ask_user", (taskId: string, sessionId: string | undefined, input: unknown) => {
    relayToSubscribers(taskId, sessionId, { type: "ask_user", task_id: taskId, session_id: sessionId, input });
  });

  orchestrator.on("task:continuing", (taskId: string, sessionId: string | undefined, info: { continuation: number; max_continuations: number; total_cost_usd: number }) => {
    relayToSubscribers(taskId, sessionId, { type: "turn.continuing", task_id: taskId, session_id: sessionId, ...info });
  });

  // Goal-loop events: judging started, a verdict per round, the final stop.
  orchestrator.on("task:goal_judging", (taskId: string, sessionId: string | undefined, info: { iteration: number }) => {
    relayToSubscribers(taskId, sessionId, { type: "goal_judging", task_id: taskId, session_id: sessionId, ...info });
  });
  orchestrator.on("task:goal_eval", (taskId: string, sessionId: string | undefined, info: { iteration: number; verdict: unknown }) => {
    relayToSubscribers(taskId, sessionId, { type: "goal_eval", task_id: taskId, session_id: sessionId, ...info });
  });
  orchestrator.on("task:goal_stop", (taskId: string, sessionId: string | undefined, info: { reason: string; iteration: number; total_cost_usd: number; verdict?: unknown; detail?: string }) => {
    relayToSubscribers(taskId, sessionId, { type: "goal_stop", task_id: taskId, session_id: sessionId, ...info });
  });

  orchestrator.on("task:done", async (taskId: string, sessionId: string | undefined, result?: { text: string; input_tokens?: number; output_tokens?: number; cost_usd?: number }) => {
    if (sessionId) {
      const rawText = result?.text;
      // Per-turn usage for the dashboard (in/out tokens + cost). Persisted in the
      // log too so it survives replay/reload. Some providers (ollama/openai-compat)
      // may report 0 — the UI hides the footer when both token counts are 0.
      const usage = {
        input_tokens: result?.input_tokens ?? 0,
        output_tokens: result?.output_tokens ?? 0,
        cost_usd: result?.cost_usd ?? 0,
      };
      // Persist the RAW result text synchronously *before* awaiting the
      // image-signing roundtrip. Order matters: any follow-up event (next
      // turn, replay request) reading the log must see this turn.done
      // already written.
      eventLog.append(sessionId, "turn.done", { type: "turn.done", session_id: sessionId, result_text: rawText, usage });

      const signedText = rawText
        ? await imageRewriterService.signImagesIn(sessionId, rawText).catch(() => rawText)
        : rawText;
      const msg = { type: "turn.done", session_id: sessionId, result_text: signedText, usage };
      connectionManager.sendToSession(sessionId, msg);

      // Auto-generate workspace title if name looks auto-generated (async, non-blocking)
      (async () => {
        try {
          wsLog?.info({ sessionId }, "Title generation: starting");
          const workspace = opts.sessionRegistry.get(sessionId);
          if (!workspace || !result?.text) {
            wsLog?.info({ sessionId, hasWorkspace: !!workspace, hasResult: !!result?.text }, "Title generation: skipped (no workspace or result)");
            return;
          }

          const events = eventLog.read(sessionId);
          const userMsgs = events.filter((e) => e.type === "user_message");
          const userMsg = userMsgs[0];
          if (!userMsg) return;

          // The initial workspace name is the raw first prompt (set at create),
          // which is NOT user-chosen — so on the FIRST turn always upgrade it to
          // an LLM title. On later turns only re-title when the name still looks
          // auto-generated (a placeholder), so a user's manual rename is never
          // clobbered.
          const name = workspace.name ?? "";
          const isFirstTurn = userMsgs.length <= 1;
          const looksAutoGenerated = !name
            || name.endsWith("...")
            || name.startsWith("Workspace ")
            || name.startsWith("– ")
            || name.startsWith("- ")
            || name.length > 45;
          wsLog?.info({ sessionId, name, isFirstTurn, looksAutoGenerated }, "Title generation: name check");
          if (!isFirstTurn && !looksAutoGenerated) return;

          const prompt = (userMsg.data.text as string) ?? "";
          const response = result.text;

          // Title via the workspace's ACTIVE model/provider — honoring the
          // per-workspace key + model overrides (not just the profile default),
          // falling back to a heuristic when the LLM call is unavailable.
          const resolved = await opts.profileService.getResolved(workspace.profile_id, {
            apiKeyIdOverride: workspace.api_key_id_override ?? undefined,
          });
          const llm = await generateTitle(prompt, response, {
            apiKey: resolved?.resolved_api_key,
            provider: resolved?.resolved_provider,
            baseUrl: resolved?.resolved_base_url,
            // Prefer the model that ACTUALLY produced this turn. It is consistent
            // with resolved_provider (the same api_key_id_override ran it). Using
            // model_override ?? resolved.model can desync from the provider: with
            // no model_override it falls to the profile default (e.g. an ollama
            // model) while the provider comes from a switched-to key (Anthropic)
            // → a glm model sent to Anthropic 404s and titling silently fails.
            model: workspace.last_run_model ?? workspace.model_override ?? resolved?.model,
          }, wsLog as any);
          const title = llm ?? heuristicTitle(prompt);
          if (title && title !== name) {
            await opts.workspaceService.update(sessionId, { name: title });
            connectionManager.sendToSession(sessionId, {
              type: "workspace.title_updated",
              session_id: sessionId,
              name: title,
            });
          }
        } catch (err) { wsLog?.error({ err, sessionId }, "Title generation failed"); }
      })();
    } else {
      connectionManager.sendToTask(taskId, { type: "done", task_id: taskId, result_text: result?.text });
    }
  });

  orchestrator.on("task:failed", (taskId: string, sessionId: string | undefined, error: string) => {
    const msg = { type: "error", task_id: taskId, code: ErrorCodes.TASK_FAILED, message: error };
    // Use the shared relay so session-mode tasks reach the chat WS AND
    // persist to the event log — refreshing after a failed turn will
    // still show the error inline instead of a blank thread.
    relayToSubscribers(taskId, sessionId, msg);
  });

  orchestrator.on("task:cancelled", (taskId: string) => {
    connectionManager.sendToTask(taskId, { type: "cancelled", task_id: taskId });
  });

  orchestrator.on("task:container", async (taskId: string, containerId: string) => {
    const containerName = await opts.containerManager.getContainerName(containerId).catch(() => null);
    connectionManager.sendToTask(taskId, {
      type: "started",
      task_id: taskId,
      container_id: containerId,
      container_name: containerName ?? containerId.slice(0, 12),
    });
  });

  // WS route
  (server as unknown as FastifyInstance & {
    get(
      path: string,
      opts: { websocket: true },
      handler: (socket: WebSocket, request: FastifyRequest) => void,
    ): void;
  }).get("/v1/stream", { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    const user = request.user;
    if (!user) {
      socket.close(4001, "Unauthorized");
      return;
    }
    // Pin the OrgContext at connection time. SaaS upgrades the WS via
    // the same auth hook that populates orgContext on REST routes; OSS
    // leaves it undefined → register() falls back to org_id=null.
    const connectionOrgId = request.orgContext?.org_id ?? null;

    const connectionId = connectionManager.add(socket, user.id);
    if (!connectionId) {
      wsLog?.warn({ userId: user.id }, "Connection limit reached");
      socket.close(4029, "Too many connections");
      return;
    }
    wsLog?.info({ connectionId, userId: user.id }, "Client connected");

    socket.on("message", async (data: Buffer) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        connectionManager.sendTo(connectionId, {
          type: "error",
          code: ErrorCodes.INVALID_JSON,
          message: "Failed to parse message",
        });
        return;
      }

      try {
        // Pin the connection's org to the AsyncLocalStorage so any
        // workspace insert site downstream (sessionRegistry.register
        // with no explicit orgId, future writers via getActiveOrgId())
        // picks it up without each call site threading it through.
        await runWithOrgId(connectionOrgId, () =>
          handleMessage(connectionId, user, connectionOrgId, msg),
        );
      } catch (err) {
        // A disallowed profile (e.g. org-filtered out) surfaces as
        // ForbiddenError — report it as FORBIDDEN, not a 500, matching REST.
        connectionManager.sendTo(connectionId, {
          type: "error",
          code: err instanceof ForbiddenError ? ErrorCodes.FORBIDDEN : ErrorCodes.INTERNAL_ERROR,
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    });

    socket.on("close", () => {
      connectionManager.remove(connectionId);
      wsLog?.info({ connectionId }, "Client disconnected");
    });
  });

  /** Unpause a paused session's container. No-op if not paused. Uses updateActivity (single DB write). */
  async function resumeIfPaused(sessionId: string, session: Workspace): Promise<void> {
    if (session.status !== "paused" || !session.container_id) return;
    try {
      await opts.containerManager.unpauseContainer(session.container_id);
    } catch (err) {
      wsLog?.error({ sessionId, containerId: session.container_id, err }, "Failed to unpause container");
      throw err;
    }
    // updateActivity sets status to "active" and last_active_at in a single DB write
    opts.sessionRegistry.updateActivity(sessionId);
  }

  async function getUserProfileIds(user: { id: string; allowedProfileIds?: string[] }): Promise<string[]> {
    // SECURITY: honor an API token's profile allow-list (allowedProfileIds),
    // exactly like the REST /v1/tasks path. Without this, a token scoped to one
    // profile could run ANY of the owner's profiles over the WS — the channel
    // the embeddable chat uses. Token absent → the user's own profiles.
    let ids = user.allowedProfileIds?.length
      ? user.allowedProfileIds
      : (await opts.profileService.list(user.id)).map((p) => p.id);
    // Runs inside runWithOrgId(connectionOrgId), so getActiveOrgId() returns
    // the connection's pinned org. Filter to org-visible profiles (SaaS) so a
    // multi-org user can't see/submit/cancel tasks across orgs over the WS.
    if (opts.visibleProfileIdsForOrg) {
      const visible = await opts.visibleProfileIdsForOrg(user.id, getActiveOrgId(), ids);
      if (visible) ids = ids.filter((id) => visible.has(id));
    }
    return ids;
  }

  async function handleMessage(
    connectionId: string,
    user: NonNullable<FastifyRequest["user"]>,
    connectionOrgId: string | null,
    msg: ClientMessage,
  ): Promise<void> {
    switch (msg.type) {
      case "submit": {
        const submitRate = checkTokenRate(user);
        if (!submitRate.allowed) {
          connectionManager.sendTo(connectionId, { type: "error", code: "RATE_LIMITED", message: `Rate limit exceeded — retry in ${submitRate.retryAfter ?? 60}s` });
          return;
        }
        // Validate the payload the same way REST does
        const parsed = submitTaskSchema.safeParse(msg.payload);
        if (!parsed.success) {
          connectionManager.sendTo(connectionId, {
            type: "error",
            code: ErrorCodes.VALIDATION_FAILED,
            message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          });
          return;
        }

        const profileIds = await getUserProfileIds(user);

        // If the user is submitting to an existing session_id that's not
        // in the in-memory Map, it's almost certainly expired. The
        // orchestrator can't dispatch against a session it doesn't see
        // — silently dropping the task is what produced the "send a
        // new text to wake up has no effect" bug. Resurrect first.
        const submittedSessionId = parsed.data.session_id;
        if (submittedSessionId) {
          const resurrected = await opts.sessionRegistry.resurrect(submittedSessionId, user.id);
          // Tenant boundary: in SaaS the resurrected session must belong to
          // the connection's active org. Without this a user in multiple orgs
          // could resume/submit to their own session from another org context.
          if (!resurrected || (connectionOrgId && (resurrected.org_id ?? null) !== connectionOrgId)) {
            connectionManager.sendTo(connectionId, {
              type: "error",
              code: ErrorCodes.NOT_FOUND,
              message: `Session ${submittedSessionId} not found or not accessible.`,
            });
            return;
          }
          connectionManager.subscribeSession(connectionId, submittedSessionId);
        }

        const result = await taskService.submit(
          parsed.data,
          profileIds,
        );
        // Link the task to the connection's pinned org so the
        // orchestrator's resolveOrgIdForTask returns it when the
        // workspace launches. Same mechanism the REST /v1/tasks
        // route uses; await before queueing so the orchestrator
        // can't race the link insert.
        if (connectionOrgId && opts.recordTaskOrg) {
          await opts.recordTaskOrg(result.task_id, connectionOrgId);
        }
        connectionManager.subscribeTask(connectionId, result.task_id);
        connectionManager.sendTo(connectionId, {
          type: "queued",
          task_id: result.task_id,
        });
        break;
      }

      case "cancel": {
        // Ownership check: without this any connected user could cancel any
        // task by id (cross-tenant DoS). Scope to the caller's org-visible
        // profiles — same boundary as task list/get/delete.
        const task = await taskService.get(msg.task_id);
        const allowed = await getUserProfileIds(user);
        if (!task || !allowed.includes(task.profile_id)) {
          connectionManager.sendTo(connectionId, {
            type: "error",
            code: ErrorCodes.NOT_FOUND,
            message: `Task ${msg.task_id} not found.`,
          });
          break;
        }
        await taskService.cancel(msg.task_id);
        break;
      }

      case "session.start": {
        const startRate = checkTokenRate(user);
        if (!startRate.allowed) {
          connectionManager.sendTo(connectionId, { type: "error", code: "RATE_LIMITED", message: `Rate limit exceeded — retry in ${startRate.retryAfter ?? 60}s` });
          return;
        }
        const newSessionId = randomUUID();
        // Default to user's first profile if none specified (e.g. chat widget without ?profile=)
        let profileId = msg.profile_id;
        if (!profileId) {
          const profileIds = await getUserProfileIds(user);
          profileId = profileIds[0];
          if (!profileId) {
            connectionManager.sendTo(connectionId, {
              type: "error",
              code: ErrorCodes.VALIDATION_FAILED,
              message: "No profile available",
            });
            return;
          }
        }
        // Look up profile to check persistent_sessions flag
        const profile = await opts.profileService.get(profileId);
        const persistent = profile?.persistent_sessions ?? false;
        // Just register the session — no task submitted yet.
        // The first session.turn will trigger container creation and execution.
        await opts.sessionRegistry.register(
          newSessionId,
          null,
          user.id,
          profileId,
          persistent,
          connectionOrgId,
        );
        // Local-exec (CLI `--local-exec`): the client advertised it can service
        // localtool.call frames. Record it (ephemeral, connection-scoped) so the
        // orchestrator localizes the agent's file/shell tools for this session.
        // Server can never initiate this — it only activates when the client asks.
        if (msg.capabilities?.includes("local-exec")) {
          opts.sessionRegistry.setLocalExec(newSessionId, { root: msg.local_root ?? "" });
        }
        connectionManager.subscribeSession(connectionId, newSessionId);
        connectionManager.sendTo(connectionId, {
          type: "session.ready",
          session_id: newSessionId,
          container_id: "pending",
        });
        break;
      }

      case "session.resume": {
        connectionManager.subscribeSession(connectionId, msg.session_id);
        // Expired sessions are evicted from the in-memory Map but the
        // DB row persists. Without resurrect here, `registry.get` returns
        // null, the entire `if (session)` block below is skipped, and the
        // server sends nothing back — the dashboard hangs forever waiting
        // for session.ready. That's the v0.1.83 user complaint ("the
        // websocket wasn't established"). Resurrect first so the normal
        // resume path runs.
        await opts.sessionRegistry.resurrect(msg.session_id, user.id);
        const session = opts.sessionRegistry.get(msg.session_id);
        // Reject if not owned, or (SaaS) not in the connection's active org.
        if (session && (session.user_id !== user.id
          || (connectionOrgId && (session.org_id ?? null) !== connectionOrgId))) {
          connectionManager.sendTo(connectionId, {
            type: "error",
            session_id: msg.session_id,
            code: ErrorCodes.SESSION_NOT_FOUND,
            message: "Session not found",
          });
          break;
        }
        if (session) {
          // Wake container if needed (wait for it so we can rewrite URLs in replay)
          let newContainerName: string | null = null;
          if (session.status === "resumable" || !session.container_id) {
            opts.sessionRegistry.extendExpiry(msg.session_id, new Date(Date.now() + 86400 * 1000).toISOString());
            opts.sessionRegistry.setStatus(msg.session_id, "active");

            // Lazy claim (issue #333): only PERSISTENT sessions get an eager
            // wake — their volume survives, so replayed preview URLs can be
            // rewritten to the recovered container and actually work. A
            // non-persistent resumable session lost its container AND its
            // files; waking eagerly costs a container for a conversation the
            // user may only be re-reading. Its container is created on the
            // first turn (dispatchSession), same as a brand-new chat.
            if (session.persistent) {
              try {
                const profile = await opts.profileService.getResolved(session.profile_id);
                if (profile) {
                  const containerId = await orchestrator.wakeWorkspaceContainer(msg.session_id, profile);
                  if (containerId) {
                    newContainerName = await opts.containerManager.getContainerName(containerId) ?? containerId.slice(0, 12);
                  }
                }
              } catch (err) {
                wsLog?.error({ sessionId: msg.session_id, err }, "Failed to wake container on resume");
              }
            }
          }
          await resumeIfPaused(msg.session_id, session);

          // Get the current container name for URL rewriting
          const currentContainerId = session.container_id;
          const currentContainerName = currentContainerId
            ? (await opts.containerManager.getContainerName(currentContainerId).catch(() => null)) ?? currentContainerId.slice(0, 12)
            : newContainerName;

          // Replay persisted events, rewriting old container URLs to current container
          const afterSeq = (msg as Record<string, unknown>).last_seq as number | undefined;
          const events = eventLog.read(msg.session_id, afterSeq ?? 0);
          if (events.length > 0) {
            // Extract old container names from event data (pattern: xxx-{port}.vonzio.localhost)
            const urlPattern = /([a-z]+[a-z0-9]*)-(\d{4,5})\.vonzio\.localhost/g;
            const oldNames = new Set<string>();
            for (const evt of events) {
              const json = JSON.stringify(evt.data);
              let match;
              while ((match = urlPattern.exec(json)) !== null) {
                if (match[1] !== currentContainerName) {
                  oldNames.add(match[1]);
                }
              }
            }

            connectionManager.sendTo(connectionId, {
              type: "session.replay_start",
              session_id: msg.session_id,
              count: events.length,
            });
            // Hoist the rewriter context once: the container name is the
            // same for every event in this replay, so we avoid N Docker
            // inspects + N regex compiles. Without this, a 500-event
            // session replay = 500 sequential docker.inspect() calls.
            const replayWorkspace = session;
            const replayContainerName = currentContainerName ?? undefined;
            const canSignImages = !!(replayWorkspace.container_id && replayContainerName);

            for (const evt of events) {
              let data = evt.data;
              // Replace old container names in URLs with current container name
              if (currentContainerName && oldNames.size > 0) {
                let json = JSON.stringify(data);
                for (const oldName of oldNames) {
                  json = json.replaceAll(
                    `${oldName}-`,
                    `${currentContainerName}-`,
                  );
                }
                try { data = JSON.parse(json); } catch { /* keep original */ }
              }
              // Sign agent-image URLs on the fly — persisted text has raw
              // URLs (tokens have a TTL and can't be safely cached). Same
              // signing context across the whole replay; the service caches
              // container-name lookups so subsequent calls are O(1).
              if (canSignImages && data && typeof data === "object" && ("text" in data || "result_text" in data)) {
                try {
                  const d = data as Record<string, unknown>;
                  if (typeof d.text === "string") {
                    d.text = await imageRewriterService.signImagesIn(msg.session_id, d.text);
                  }
                  if (typeof d.result_text === "string") {
                    d.result_text = await imageRewriterService.signImagesIn(msg.session_id, d.result_text);
                  }
                } catch { /* keep raw on failure */ }
              }
              // Base the client-facing type on the envelope's evt.type: flushed
              // token buffers persist data as bare `{ text }` with no type, and
              // a typeless message falls through the client switch — silently
              // dropping all streamed assistant text from replays. data spreads
              // after, so a data.type (present on most events) still wins.
              connectionManager.sendTo(connectionId, { type: evt.type, ...data, _replay: true, _seq: evt.seq, _ts: evt.ts });
            }
            connectionManager.sendTo(connectionId, {
              type: "session.replay_done",
              session_id: msg.session_id,
              last_seq: events[events.length - 1].seq,
            });
          }

          connectionManager.sendTo(connectionId, {
            type: "session.ready",
            session_id: msg.session_id,
            container_id: session.container_id ?? "pending",
            container_name: currentContainerName ?? undefined,
            resumed: true,
          });
        } else {
          connectionManager.sendTo(connectionId, {
            type: "error",
            session_id: msg.session_id,
            code: ErrorCodes.SESSION_NOT_FOUND,
            message: "Session not found",
          });
        }
        break;
      }

      case "session.turn": {
        const turnRate = checkTokenRate(user);
        if (!turnRate.allowed) {
          connectionManager.sendTo(connectionId, { type: "error", code: "RATE_LIMITED", message: `Rate limit exceeded — retry in ${turnRate.retryAfter ?? 60}s` });
          return;
        }
        const session = opts.sessionRegistry.get(msg.session_id);
        if (!session || session.user_id !== user.id) {
          connectionManager.sendTo(connectionId, {
            type: "error",
            session_id: msg.session_id,
            code: ErrorCodes.SESSION_NOT_FOUND,
            message: "Session not found",
          });
          return;
        }

        // Log the user message so replay shows the full conversation. Persist
        // the goal-mode acceptance criteria too (when present) so the criteria
        // chips render under the user bubble on refresh, not just live.
        const turnCriteria = (msg as Record<string, unknown>).acceptance_criteria as string[] | undefined;
        // Persist attachment FILE METADATA (name + type) so the attachment chips
        // survive a refresh — same as the Telegram surface. We deliberately do
        // NOT persist the base64 image bytes (that would bloat the JSONL and the
        // orchestrator already wrote the files into the container).
        const turnAttachments = (msg as Record<string, unknown>).attachments as TaskAttachment[] | undefined;
        const turnFiles = turnAttachments?.map((a) => ({ name: a.name ?? "attachment", type: a.type }));
        eventLog.append(msg.session_id, "user_message", {
          type: "user_message",
          session_id: msg.session_id,
          text: msg.message,
          ...(turnFiles && turnFiles.length > 0 && { files: turnFiles }),
          ...(turnCriteria && turnCriteria.length > 0 && { acceptance_criteria: turnCriteria }),
        });

        if (session.status === "resumable") {
          opts.sessionRegistry.extendExpiry(msg.session_id, new Date(Date.now() + 86400 * 1000).toISOString());
          opts.sessionRegistry.setStatus(msg.session_id, "active");
        }
        await resumeIfPaused(msg.session_id, session);

        connectionManager.subscribeSession(connectionId, msg.session_id);
        const result = await taskService.submit(
          {
            mode: "session",
            prompt: msg.message,
            profile_id: session.profile_id,
            session_id: msg.session_id,
            // Per-turn model override (CLI `/model`). Undefined → the profile's model.
            model: msg.model,
            // session.turn isn't in ClientMessage's discriminated union yet —
            // the field is validated by submitTaskSchema upstream.
            attachments: turnAttachments,
            // Per-message goal-loop override (composer "Run until done" toggle +
            // acceptance criteria). Undefined goal_mode → profile default decides.
            goal_mode: (msg as Record<string, unknown>).goal_mode as boolean | undefined,
            acceptance_criteria: (msg as Record<string, unknown>).acceptance_criteria as string[] | undefined,
          },
          await getUserProfileIds(user),
        );
        connectionManager.subscribeTask(connectionId, result.task_id);
        break;
      }

      case "session.turn.cancel": {
        const cancelSession = opts.sessionRegistry.get(msg.session_id);
        if (cancelSession && cancelSession.user_id !== user.id) break;
        await opts.orchestrator.cancelBySession(msg.session_id);
        break;
      }

      case "localtool.result": {
        // CLI replied to a localtool.call (local-exec). Match ownership before
        // resolving the agent's pending tool call.
        const ltSession = opts.sessionRegistry.get(msg.session_id);
        if (!ltSession || ltSession.user_id !== user.id) break;
        orchestrator.resolveLocalTool(msg.session_id, msg.call_id, { output: msg.output ?? "", exit_code: msg.exit_code });
        break;
      }

      case "localtool.deny": {
        const ltSession = opts.sessionRegistry.get(msg.session_id);
        if (!ltSession || ltSession.user_id !== user.id) break;
        orchestrator.denyLocalTool(msg.session_id, msg.call_id, msg.reason ?? "");
        break;
      }

      case "session.end": {
        const endSession = opts.sessionRegistry.get(msg.session_id);
        if (endSession && endSession.user_id !== user.id) break;
        opts.sessionRegistry.setLocalExec(msg.session_id, null);
        await opts.workspaceService.terminate(msg.session_id);
        connectionManager.sendTo(connectionId, {
          type: "session.closed",
          session_id: msg.session_id,
        });
        break;
      }

      case "session.answer": {
        // User answered an AskUserQuestion — write answers to the container
        const session = opts.sessionRegistry.get(msg.session_id);
        if (!session || session.user_id !== user.id) break;
        if (session.container_id) {
          await orchestrator.answerUserQuestion(session.container_id, msg.answers as Record<string, string>);
        }
        break;
      }

      case "ping": {
        connectionManager.sendTo(connectionId, { type: "pong" });
        break;
      }
    }
  }

  // Return cleanup function to remove orchestrator listeners
  return () => {
    for (const event of ORCHESTRATOR_EVENTS) {
      orchestrator.removeAllListeners(event);
    }
  };
}
