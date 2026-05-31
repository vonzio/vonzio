/**
 * Cross-surface fallback for `AskUserQuestion`.
 *
 * Problem: the agent calls `AskUserQuestion`, but the user is no longer
 * watching the dashboard tab AND the session isn't bound to a chat
 * surface (no telegram chat, no slack thread). The in-band relays
 * silently no-op; the agent hangs until task timeout.
 *
 * This module listens to `task:ask_user` and, when no in-band surface
 * delivered the question, falls back to the user's account-level
 * notification channels (Telegram DM via their bot, Slack DM, email)
 * with the question text + a dashboard URL so they can answer the
 * agent. The answer still flows through the normal channels -- this
 * is a "tap on the shoulder," not an alternative answer pipeline.
 *
 * Dedupe: each ask_user emit is uniquely identified by `(session_id,
 * task_id, question_hash)` and we suppress repeat notifications inside
 * a short TTL so a misbehaving agent that re-asks every turn doesn't
 * spam the user. The in-process Map is fine here -- pending questions
 * are in-flight; server restart kills the task anyway.
 *
 * Per-user opt-out lives on the IntegrationService default channel --
 * users who haven't configured any notification channel never get a
 * fallback; the agent's prompt (presence section) already steers it
 * away from AskUserQuestion in that case.
 *
 * Chat-surface presence (and the "user has an account-wide bot DM"
 * suppression check that used to read `user_integrations` for
 * `type = telegram`) both go through the SessionPresenceRegistry --
 * the fallback has no direct knowledge of which surfaces exist.
 */

import type { NotificationService } from "../services/notification-service.js";
import type { SessionRegistry } from "../container/session-registry.js";
import type { SessionPresenceRegistry } from "../lib/session-presence.js";
import type { Logger } from "./orchestrator.js";

export interface AskUserFallbackDeps {
  sessionRegistry: SessionRegistry;
  notificationService: NotificationService;
  /**
   * Walks chat-surface providers to decide whether an in-band relay
   * will already deliver the question. Replaces the direct
   * telegram_sessions / slack_thread_mappings reads + the
   * `integrationService.listByUserAndType("telegram")` linked-bot
   * check that used to live here.
   */
  sessionPresence: SessionPresenceRegistry;
  dashboardUrl: string;
  log?: Logger;
}

/**
 * In-process suppression of duplicate notifications for the same
 * question within this TTL. A 60-second window is short enough that a
 * legitimate re-ask after the user fails to answer still notifies, but
 * long enough to catch the common "agent retries on receiving no
 * response" loop.
 */
const NOTIFICATION_DEDUPE_TTL_MS = 60 * 1000;

/**
 * Sketch the question down to one line for the notification body. The
 * full question is in the dashboard -- the notification just hints what
 * the agent wants so the user can decide if it's worth opening.
 */
function summarizeQuestion(input: unknown): string {
  if (!input || typeof input !== "object") return "The agent needs your input.";
  const inputData = input as Record<string, unknown>;
  const questions = (inputData.questions as Array<Record<string, unknown>> | undefined) ?? [];
  const first = questions[0] ?? inputData;
  const text = (first.question as string | undefined) ?? "";
  if (!text) return "The agent needs your input.";
  const trimmed = text.trim();
  return trimmed.length > 240 ? trimmed.slice(0, 237) + "..." : trimmed;
}

export function createAskUserFallback(deps: AskUserFallbackDeps) {
  const dedupe = new Map<string, number>();
  const dashboardRoot = deps.dashboardUrl.replace(/\/$/, "");
  const noopLogger: Logger = {
    info() {}, warn() {}, error() {},
    child() { return noopLogger; },
  };
  const log: Logger = deps.log ?? noopLogger;

  /**
   * Tells us whether at least one in-band surface will render this
   * question. Three signals checked:
   *   - Dashboard WS subscription live for this session
   *   - A registered chat-surface provider reports the session as bound
   *   - The session owner has an account-wide channel on a registered
   *     provider (e.g. telegram with a linked bot DM that will receive
   *     the inline-keyboard question)
   *
   * The last check matches the wider reach of the in-band Telegram
   * `task:ask_user` relay (which fires for any dashboard-origin session
   * whose owner has a linked bot) -- without it, the fallback would
   * double-notify those users.
   */
  async function hasInBandSurface(sessionId: string): Promise<boolean> {
    if (deps.sessionRegistry.getConnectedSessionIds().has(sessionId)) return true;
    const surfaces = await deps.sessionPresence.surfacesFor(sessionId);
    if (surfaces.length > 0) return true;

    // No session-bound surface. Check whether any registered provider
    // delivers to the owner's account-wide channel (telegram with a
    // linked bot, slack with a linked workspace DM, etc.).
    const workspace = deps.sessionRegistry.get(sessionId);
    if (!workspace) return false;
    return deps.sessionPresence.anyHasOwnerSurface(workspace.user_id);
  }

  async function resolveUserId(sessionId: string): Promise<string | null> {
    const workspace = deps.sessionRegistry.get(sessionId);
    if (workspace?.user_id) return workspace.user_id;
    // Fallback: the session might have been written to a chat-surface
    // binding by an inbound chat message before the workspace was
    // registered. Walk registered providers for a binding-side lookup.
    return deps.sessionPresence.resolveUserIdBySession(sessionId);
  }

  /**
   * Called from the orchestrator's task:ask_user listener (or wherever
   * the relay is wired up). Fire-and-forget -- never blocks the agent.
   */
  return async function onAskUser(taskId: string, sessionId: string | undefined, input: unknown): Promise<void> {
    if (!sessionId) return; // one-shot tasks: no surface, presence section already warned the agent

    try {
      if (await hasInBandSurface(sessionId)) return;

      // Dedupe: same question for the same task within the TTL → drop.
      // We hash on the trimmed first-question text; the full ask payload
      // varies in ways (option ids, button labels) that aren't user-
      // facing relevant.
      const summary = summarizeQuestion(input);
      const dedupeKey = `${taskId}::${summary}`;
      const now = Date.now();
      const last = dedupe.get(dedupeKey);
      if (last && now - last < NOTIFICATION_DEDUPE_TTL_MS) return;
      dedupe.set(dedupeKey, now);
      // Cheap GC -- sweep stale entries on each call so the map doesn't
      // grow unbounded across a long-running server.
      for (const [k, ts] of dedupe) {
        if (now - ts > NOTIFICATION_DEDUPE_TTL_MS) dedupe.delete(k);
      }

      const userId = await resolveUserId(sessionId);
      if (!userId) {
        log.warn({ taskId, sessionId }, "ask-user fallback: could not resolve user_id");
        return;
      }

      const dashboardLink = `${dashboardRoot}/w/${sessionId}`;
      // Plain-text notification body -- NotificationService picks the
      // right channel per user (Telegram bot DM, Slack, email) and
      // handles channel-specific formatting. We deliberately don't
      // try to render Telegram inline keyboards here; the notification
      // says "answer in the dashboard" and the user follows the link.
      const message = [
        "The agent needs your input.",
        "",
        summary,
        "",
        `Open the workspace to answer: ${dashboardLink}`,
      ].join("\n");

      const result = await deps.notificationService.send({
        userId,
        message,
        urgency: "high",
        source: "agent",
        taskId,
      });
      if (!result.success) {
        log.warn({ taskId, sessionId, userId, error: result.error }, "ask-user fallback notification failed");
      } else {
        log.info({ taskId, sessionId, userId, channel: result.channel }, "ask-user fallback notification sent");
      }
    } catch (err) {
      log.error({ err, taskId, sessionId }, "ask-user fallback handler threw");
    }
  };
}
