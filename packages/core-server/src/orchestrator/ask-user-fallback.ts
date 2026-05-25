/**
 * Cross-surface fallback for `AskUserQuestion`.
 *
 * Problem: the agent calls `AskUserQuestion`, but the user is no longer
 * watching the dashboard tab AND the session isn't bound to a chat
 * surface (no telegram_sessions row, no slack_thread_mappings row).
 * The in-band relays (WS, Telegram, Slack) silently no-op; the agent
 * hangs until task timeout.
 *
 * This module listens to `task:ask_user` and, when no in-band surface
 * delivered the question, falls back to the user's account-level
 * notification channels (Telegram DM via their bot, Slack DM, email)
 * with the question text + a dashboard URL so they can answer the
 * agent. The answer still flows through the normal channels — this
 * is a "tap on the shoulder," not an alternative answer pipeline.
 *
 * Dedupe: each ask_user emit is uniquely identified by `(session_id,
 * task_id, question_hash)` and we suppress repeat notifications inside
 * a short TTL so a misbehaving agent that re-asks every turn doesn't
 * spam the user. The in-process Map is fine here — pending questions
 * are in-flight; server restart kills the task anyway.
 *
 * Per-user opt-out lives on the IntegrationService default channel —
 * users who haven't configured any notification channel never get a
 * fallback; the agent's prompt (presence section) already steers it
 * away from AskUserQuestion in that case.
 */

import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import type { NotificationService } from "../services/notification-service.js";
import type { SessionRegistry } from "../container/session-registry.js";
import type { IntegrationService, TelegramConfig } from "../services/integration-service.js";
import type { Logger } from "./orchestrator.js";

export interface AskUserFallbackDeps {
  db: DrizzleDB;
  sessionRegistry: SessionRegistry;
  notificationService: NotificationService;
  // Needed to detect when the user has a LINKED Telegram bot, even if
  // the session itself isn't bound to a Telegram chat. The Telegram
  // ask_user relay extends to those cases (sends inline keyboard via
  // the user's bot), so the fallback must suppress its plain-text
  // notification to avoid double-pinging.
  integrationService: IntegrationService;
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
 * full question is in the dashboard — the notification just hints what
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
   * question. The Telegram `task:ask_user` relay now widens beyond
   * sessions with a `telegram_sessions` row to include any
   * dashboard-origin session whose owner has a linked Telegram bot —
   * so the suppression check has to match that wider reach, otherwise
   * the user gets BOTH the inline-keyboard question AND a plain-text
   * "tap on the shoulder" for the same ask.
   *
   * The three signals checked:
   *   - Dashboard WS subscription live for this session
   *   - telegram_sessions row binds the session to a chat
   *   - slack_thread_mappings row binds the session to a thread
   *   - workspace owner has at least one LINKED Telegram bot (means
   *     the in-band Telegram relay will deliver via the owner's DM)
   */
  async function hasInBandSurface(sessionId: string): Promise<boolean> {
    if (deps.sessionRegistry.getConnectedSessionIds().has(sessionId)) return true;
    const [tg, sl] = await Promise.all([
      deps.db.select({ id: schema.telegramSessions.session_id })
        .from(schema.telegramSessions)
        .where(eq(schema.telegramSessions.session_id, sessionId))
        .limit(1)
        .catch(() => []),
      deps.db.select({ id: schema.slackThreadMappings.session_id })
        .from(schema.slackThreadMappings)
        .where(eq(schema.slackThreadMappings.session_id, sessionId))
        .limit(1)
        .catch(() => []),
    ]);
    if (tg.length > 0 || sl.length > 0) return true;

    // No chat surface bound to this session. But the Telegram relay
    // also reaches dashboard-origin sessions whose owner has a linked
    // Telegram bot — check that path so we don't double-notify.
    const workspace = deps.sessionRegistry.get(sessionId);
    if (!workspace) return false;
    try {
      const bots = await deps.integrationService.listByUserAndType(workspace.user_id, "telegram");
      const anyLinked = bots.some((b) => {
        const cfg = b.config as unknown as TelegramConfig;
        return !!cfg.owner_tg_user_id;
      });
      return anyLinked;
    } catch {
      // If the integration lookup fails, fall through to "no surface"
      // — better to over-notify than under-notify on an ask.
      return false;
    }
  }

  async function resolveUserId(sessionId: string): Promise<string | null> {
    const workspace = deps.sessionRegistry.get(sessionId);
    if (workspace?.user_id) return workspace.user_id;
    // Fallback: the session might have been written to telegram_sessions
    // by a /new before the workspace was registered. Read the binding.
    const rows = await deps.db.select({ user_id: schema.telegramSessions.user_id })
      .from(schema.telegramSessions)
      .where(eq(schema.telegramSessions.session_id, sessionId))
      .limit(1)
      .catch(() => [] as Array<{ user_id: string }>);
    return rows[0]?.user_id ?? null;
  }

  /**
   * Called from the orchestrator's task:ask_user listener (or wherever
   * the relay is wired up). Fire-and-forget — never blocks the agent.
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
      // Cheap GC — sweep stale entries on each call so the map doesn't
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
      // Plain-text notification body — NotificationService picks the
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

