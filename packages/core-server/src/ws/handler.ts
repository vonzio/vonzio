import type { FastifyInstance, FastifyRequest } from "fastify";
import type WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { ConnectionManager } from "./connection.js";
import type { TaskService } from "../services/task-service.js";
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

/**
 * Generate a short workspace title using the Claude API.
 * Falls back to a basic heuristic if the API call fails.
 */
async function generateTitle(prompt: string, response: string, apiKey?: string, log?: { info: Function; error: Function }): Promise<string> {
  // Try LLM-generated title
  if (apiKey) {
    try {
      log?.info({ hasKey: !!apiKey, keyPrefix: apiKey.slice(0, 10) }, "Generating title via Haiku");
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 20,
          messages: [{
            role: "user",
            content: `Generate a very short title (3-6 words, no quotes) for this conversation:\n\nUser: ${prompt.slice(0, 200)}\nAssistant: ${response.slice(0, 200)}`,
          }],
        }),
      });
      if (res.ok) {
        const data = await res.json() as { content: Array<{ text: string }> };
        const title = data.content?.[0]?.text?.trim().replace(/^["']|["']$/g, "");
        log?.info({ title, status: res.status }, "Haiku title response");
        if (title && title.length > 0 && title.length < 60) return title;
      } else {
        const body = await res.text();
        log?.error({ status: res.status, body: body.slice(0, 200) }, "Haiku title API error");
      }
    } catch (err) {
      log?.error({ err }, "Haiku title call failed");
    }
  } else {
    log?.info("No API key available for title generation");
  }

  // Fallback heuristic
  let title = prompt.trim();
  title = title.replace(/^(can you |please |i want to |i need to |help me |let's |let me |are you )/i, "");
  if (title.length > 40) title = title.slice(0, 40).replace(/\s+\S*$/, "");
  title = title.replace(/[.,;:?!]+$/, "");
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return title || "Untitled";
}

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
] as const;

export function setupWsHandler(
  server: FastifyInstance,
  opts: WsHandlerOptions,
): () => void {
  const { connectionManager, taskService, orchestrator, eventLog, imageRewriterService, log: baseLog } = opts;
  const wsLog = baseLog?.child?.({ component: "ws" });

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

  orchestrator.on("task:done", async (taskId: string, sessionId: string | undefined, result?: { text: string }) => {
    if (sessionId) {
      const rawText = result?.text;
      // Persist the RAW result text synchronously *before* awaiting the
      // image-signing roundtrip. Order matters: any follow-up event (next
      // turn, replay request) reading the log must see this turn.done
      // already written. We sign for broadcast separately — replay also
      // signs on read, so the log doesn't need to carry tokens.
      eventLog.append(sessionId, "turn.done", { type: "turn.done", session_id: sessionId, result_text: rawText });

      const signedText = rawText
        ? await imageRewriterService.signImagesIn(sessionId, rawText).catch(() => rawText)
        : rawText;
      const msg = { type: "turn.done", session_id: sessionId, result_text: signedText };
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

          // Skip if workspace already has a good title (not auto-generated)
          const name = workspace.name ?? "";
          const looksAutoGenerated = !name
            || name.endsWith("...")
            || name.startsWith("Workspace ")
            || name.startsWith("– ")
            || name.startsWith("- ")
            || name.length > 45;
          wsLog?.info({ sessionId, name, looksAutoGenerated }, "Title generation: name check");
          if (!looksAutoGenerated) return;

          const events = eventLog.read(sessionId);
          const userMsg = events.find((e) => e.type === "user_message");
          if (!userMsg) return;

          const prompt = (userMsg.data.text as string) ?? "";
          const response = result.text;

          // Get decrypted API key from profile for LLM title generation
          const resolved = await opts.profileService.getResolved(workspace.profile_id);
          const apiKey = resolved?.resolved_api_key;

          const title = await generateTitle(prompt, response, apiKey, wsLog as any);
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
        await handleMessage(connectionId, user, connectionOrgId, msg);
      } catch (err) {
        connectionManager.sendTo(connectionId, {
          type: "error",
          code: ErrorCodes.INTERNAL_ERROR,
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

  async function getUserProfileIds(userId: string): Promise<string[]> {
    const profiles = await opts.profileService.list(userId);
    return profiles.map((p) => p.id);
  }

  async function handleMessage(
    connectionId: string,
    user: NonNullable<FastifyRequest["user"]>,
    connectionOrgId: string | null,
    msg: ClientMessage,
  ): Promise<void> {
    switch (msg.type) {
      case "submit": {
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

        const profileIds = await getUserProfileIds(user.id);

        // If the user is submitting to an existing session_id that's not
        // in the in-memory Map, it's almost certainly expired. The
        // orchestrator can't dispatch against a session it doesn't see
        // — silently dropping the task is what produced the "send a
        // new text to wake up has no effect" bug. Resurrect first.
        const submittedSessionId = parsed.data.session_id;
        if (submittedSessionId) {
          const resurrected = await opts.sessionRegistry.resurrect(submittedSessionId, user.id);
          if (!resurrected) {
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
        connectionManager.subscribeTask(connectionId, result.task_id);
        connectionManager.sendTo(connectionId, {
          type: "queued",
          task_id: result.task_id,
        });
        break;
      }

      case "cancel": {
        await taskService.cancel(msg.task_id);
        break;
      }

      case "session.start": {
        const newSessionId = randomUUID();
        // Default to user's first profile if none specified (e.g. chat widget without ?profile=)
        let profileId = msg.profile_id;
        if (!profileId) {
          const profileIds = await getUserProfileIds(user.id);
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
        if (session && session.user_id !== user.id) {
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
              connectionManager.sendTo(connectionId, { ...data, _replay: true, _seq: evt.seq, _ts: evt.ts });
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

        // Log the user message so replay shows the full conversation
        eventLog.append(msg.session_id, "user_message", {
          type: "user_message",
          session_id: msg.session_id,
          text: msg.message,
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
            // session.turn isn't in ClientMessage's discriminated union yet —
            // the field is validated by submitTaskSchema upstream.
            attachments: (msg as Record<string, unknown>).attachments as TaskAttachment[] | undefined,
          },
          await getUserProfileIds(user.id),
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

      case "session.end": {
        const endSession = opts.sessionRegistry.get(msg.session_id);
        if (endSession && endSession.user_id !== user.id) break;
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
