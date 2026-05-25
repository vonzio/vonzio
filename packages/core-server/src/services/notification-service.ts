import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { Resend } from "resend";
import type { SlackService } from "./slack-service.js";
import type { TelegramService } from "./telegram-service.js";
import { markdownToTelegram, splitTelegramMessage } from "./telegram-service.js";
import type { IntegrationService, SlackConfig, TelegramConfig } from "./integration-service.js";
import type { DrizzleDB } from "../db/index.js";
import * as schema from "../db/schema.js";
import { emailLayout } from "../email/templates.js";
import { toHtml, toPlainText, toSlackMrkdwn } from "./format-message.js";
import type { Logger } from "../orchestrator/orchestrator.js";
import type { Playbook, PlaybookRun } from "@vonzio/shared";
import { encodeThreadClaim, encodeThreadDismiss } from "@vonzio/shared";
import type { NotificationChannel } from "@vonzio/shared";

const noopLogger: Logger = {
  info() {}, warn() {}, error() {},
  child() { return noopLogger; },
};

/**
 * Render a playbook-run notification body that leads with the agent's
 * actual output and demotes operator metrics to a small footer.
 *
 * The old shape was:
 *   Playbook "VZFinance — daily log nudge" completed
 *   1 chains / 6 turns / $0.26
 *   [] [Budget cap reached]
 *
 * — stats first, the agent's "summary" was either garbage (e.g. `[]`
 * from a psql fallback) or had a termination tag glued to its tail.
 * The new shape leads with the title + status, then the agent's
 * summary block, then a single muted footer line for stats + reason.
 *
 * Exported for tests; not part of the public service contract.
 */
export function formatPlaybookNotification(
  playbook: Pick<Playbook, "name">,
  run: Pick<PlaybookRun, "status" | "decision_result" | "chain_count" | "total_turns" | "total_cost_usd" | "result_summary" | "error">,
  terminationReason: "agent_done" | "agent_finished_in_limit" | "budget_cap" | "chain_limit" | undefined,
  isFailed: boolean,
): string {
  const headIcon = isFailed ? "✗" : "✓";
  const headStatus = isFailed
    ? (run.status === "failed" ? "failed" : "decided fail")
    : "completed";
  const lines: string[] = [`${headIcon} ${playbook.name} — ${headStatus}`];

  // Body: the agent's actual output. On failure, the error message is
  // more useful than a summary.
  const body = isFailed && run.error
    ? run.error.slice(0, 600)
    : run.result_summary?.trim();
  if (body) {
    lines.push("");
    lines.push(body.slice(0, 1200));
  } else {
    lines.push("");
    lines.push("(no summary produced — see the run in the dashboard for details)");
  }

  // Footer: stats + reason in one muted line.
  const reasonLabel: Record<string, string> = {
    agent_done: "agent signaled done",
    agent_finished_in_limit: "agent finished",
    budget_cap: "stopped at budget cap",
    chain_limit: "reached chain limit",
  };
  const tail: string[] = [];
  if (terminationReason) tail.push(reasonLabel[terminationReason] ?? terminationReason);
  if (run.decision_result && run.decision_result !== "skipped") {
    tail.push(`decision: ${run.decision_result}`);
  }
  tail.push(`${run.chain_count} ${run.chain_count === 1 ? "chain" : "chains"}`);
  tail.push(`${run.total_turns} turns`);
  tail.push(`$${run.total_cost_usd.toFixed(2)}`);
  lines.push("");
  lines.push(`— ${tail.join(" · ")}`);

  return lines.join("\n");
}

export interface NotificationServiceDeps {
  slackService: SlackService;
  telegramService: TelegramService;
  integrationService: IntegrationService;
  db: DrizzleDB;
  dashboardUrl: string;
  log?: Logger;
}

export class NotificationService {
  private log: Logger;

  constructor(private deps: NotificationServiceDeps) {
    this.log = deps.log?.child({ component: "notification-service" }) ?? noopLogger;
  }

  async send(opts: {
    userId: string;
    /**
     * Either a bare channel type ("telegram", "slack", "email", "webhook")
     * for the user's default integration of that type, OR a specific
     * Telegram integration via `telegram:<integration_id>` (matches the
     * playbook notification_channels format).
     */
    channel?: NotificationChannel | string;
    message: string;
    urgency?: "low" | "normal" | "high";
    source: "agent" | "platform";
    taskId?: string;
    /**
     * Telegram-only. When set, attaches [Reply here] / [Keep my chat]
     * inline buttons and persists a `telegram_playbook_threads` row so
     * the user's next reply routes back to `sessionId` (feature #18).
     * Ignored by non-Telegram delivery paths.
     */
    threadClaim?: { sessionId: string; label?: string };
  }): Promise<{ success: boolean; channel: string; error?: string }> {
    const { userId, message, source, taskId } = opts;
    const urgency = opts.urgency ?? "normal";

    // `telegram:<integration_id>` shorthand routes to a specific bot
    // without going through getByUserAndType. This is the form
    // playbook prompts use ("telegram:int_X") and is the only way to
    // attach thread-claim buttons to a specific bot's message.
    if (opts.channel && opts.channel.startsWith("telegram:")) {
      const integrationId = opts.channel.slice("telegram:".length);
      try {
        await this.sendToTelegramIntegration(userId, integrationId, message, opts.threadClaim);
        await this.logNotification({ userId, channel: "telegram", message, urgency, source, taskId, status: "sent" });
        return { success: true, channel: opts.channel };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await this.logNotification({ userId, channel: "telegram", message, urgency, source, taskId, status: "failed", error: errorMsg });
        return { success: false, channel: opts.channel, error: errorMsg };
      }
    }

    let integration = opts.channel
      ? await this.deps.integrationService.getByUserAndType(userId, opts.channel)
      : await this.deps.integrationService.getDefault(userId);

    // If specific channel not found, fall back to default
    if (!integration && opts.channel) {
      integration = await this.deps.integrationService.getDefault(userId);
    }

    if (!integration) {
      const result = { success: false, channel: "none", error: "No notification channels configured" };
      await this.logNotification({ userId, channel: "none", message, urgency, source, taskId, status: "failed", error: result.error });
      return result;
    }

    let result: { success: boolean; channel: string; error?: string };

    try {
      switch (integration.type) {
        case "slack":
          await this.sendViaSlack(integration, message);
          result = { success: true, channel: "slack" };
          break;
        case "email":
          await this.sendViaEmail(integration, userId, message);
          result = { success: true, channel: "email" };
          break;
        case "webhook":
          await this.sendViaWebhook(integration, message, urgency);
          result = { success: true, channel: "webhook" };
          break;
        case "telegram":
          await this.sendViaTelegram(integration, message);
          result = { success: true, channel: "telegram" };
          break;
        default:
          result = { success: false, channel: integration.type, error: `Unsupported channel: ${integration.type}` };
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      result = { success: false, channel: integration.type, error: errorMsg };
    }

    await this.logNotification({
      userId, channel: result.channel, message, urgency, source, taskId,
      status: result.success ? "sent" : "failed", error: result.error,
    });

    return result;
  }

  async notifyRunComplete(playbook: Playbook, run: PlaybookRun): Promise<void> {
    const { notify_on } = playbook;

    if (notify_on === "none") return;

    const isFailed = run.status === "failed" || run.decision_result === "fail";
    const isCompleted = run.status === "completed";

    if (notify_on === "completion" && !isCompleted) return;
    if (notify_on === "failure" && !isFailed) return;
    // "both" always notifies

    const message = formatPlaybookNotification(playbook, run, run.termination_reason, isFailed);

    await Promise.allSettled(
      playbook.notification_channels.map(async (channel) => {
        try {
          // send() now handles both "telegram:<id>" shorthand and the
          // bare channel names; no need to branch here anymore.
          await this.send({
            userId: run.user_id,
            channel: channel,
            message,
            source: "platform",
          });
        } catch (err) {
          this.log.error({ err, channel, playbookId: playbook.id }, "Failed to send notification");
        }
      }),
    );
  }

  private async sendToTelegramIntegration(
    userId: string,
    integrationId: string,
    message: string,
    threadClaim?: { sessionId: string; label?: string },
  ): Promise<void> {
    const integration = await this.deps.integrationService.get(integrationId, { decrypt: true });
    if (!integration) throw new Error(`Telegram integration ${integrationId} not found`);
    if (integration.user_id !== userId) throw new Error(`Telegram integration ${integrationId} does not belong to user`);
    if (integration.type !== "telegram") throw new Error(`Integration ${integrationId} is not telegram`);

    await this.sendViaTelegram(integration, message, threadClaim);
  }

  private async sendViaSlack(
    integration: { config: Record<string, unknown> },
    message: string,
  ): Promise<void> {
    const config = integration.config as unknown as SlackConfig;

    const res = await fetch("https://slack.com/api/conversations.open", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.bot_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ users: config.authed_user_id }),
    });
    const data = await res.json() as Record<string, unknown>;
    const dmChannel = (data.channel as Record<string, unknown>)?.id as string | undefined;

    if (!dmChannel) {
      throw new Error("Failed to open Slack DM channel");
    }

    await this.deps.slackService.sendMessage(config.bot_token, {
      channel: dmChannel,
      text: toSlackMrkdwn(message),
    });
  }

  private async sendViaTelegram(
    integration: { config: Record<string, unknown> },
    message: string,
    threadClaim?: { sessionId: string; label?: string },
  ): Promise<void> {
    const config = integration.config as unknown as TelegramConfig;
    if (!config.owner_tg_user_id) {
      throw new Error("Telegram bot not linked yet. Send /link <code> in Telegram first.");
    }
    const formatted = markdownToTelegram(message);
    const chunks = splitTelegramMessage(formatted, 4000);
    // Attach the thread-claim keyboard to the LAST chunk only — earlier
    // chunks are just continuation of the same logical message; we want
    // one set of buttons at the bottom of the visible message.
    const lastIdx = chunks.length - 1;
    let lastSentMessageId: number | null = null;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isLast = i === lastIdx;
      const replyMarkup = (isLast && threadClaim) ? {
        inline_keyboard: [[
          { text: "📎 Reply here", callback_data: encodeThreadClaim(threadClaim.sessionId) },
          { text: "💬 Keep my chat", callback_data: encodeThreadDismiss(threadClaim.sessionId) },
        ]],
      } : undefined;
      try {
        const sent = await this.deps.telegramService.sendMessage(config.bot_token, {
          chat_id: config.owner_tg_user_id,
          text: chunk,
          parse_mode: "MarkdownV2",
          disable_web_page_preview: true,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
        if (isLast) lastSentMessageId = sent.message_id;
      } catch (mvErr) {
        // Strip MarkdownV2 escapes and retry as plain text. Surface fallback errors.
        try {
          const sent = await this.deps.telegramService.sendMessage(config.bot_token, {
            chat_id: config.owner_tg_user_id,
            text: chunk.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1"),
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          });
          if (isLast) lastSentMessageId = sent.message_id;
        } catch (plainErr) {
          this.log.warn({ mvErr, plainErr }, "Telegram send failed (both MarkdownV2 and plain text)");
          throw plainErr;
        }
      }
    }
    // Persist the thread-claim row tied to the last chunk's message_id
    // so the callback_query handler (and the default-claim path in
    // telegram-events) can resolve which session this message belongs to.
    if (threadClaim && lastSentMessageId !== null) {
      if (!config.bot_user_id) {
        // Required for the PK lookup in telegram-events. Skip the row
        // rather than writing empty-string keys that won't match
        // anything downstream.
        this.log.warn({ sessionId: threadClaim.sessionId }, "Skipping telegram_playbook_threads insert — bot_user_id missing in config");
      } else {
        try {
          await this.deps.db.insert(schema.telegramPlaybookThreads).values({
            bot_user_id: config.bot_user_id,
            chat_id: String(config.owner_tg_user_id),
            message_id: String(lastSentMessageId),
            session_id: threadClaim.sessionId,
            label: threadClaim.label,
            sent_at: new Date().toISOString(),
          });
        } catch (err) {
          // Insert failure isn't worth failing the whole notification —
          // the message went out; the thread-claim row just won't exist,
          // and replies fall back to existing telegram_active_sessions
          // routing (same behavior as before this feature).
          this.log.warn({ err, sessionId: threadClaim.sessionId }, "Failed to persist telegram_playbook_threads row");
        }
      }
    }
  }

  private async sendViaEmail(
    integration: { config: Record<string, unknown> },
    userId: string,
    message: string,
  ): Promise<void> {
    const config = integration.config as { api_key: string; from_address: string };
    const resend = new Resend(config.api_key);

    const rows = await this.deps.db.execute(sql`SELECT email, name FROM "user" WHERE id = ${userId}`);
    const user = rows.rows?.[0] as { email: string; name: string } | undefined;

    if (!user?.email) {
      throw new Error("No email found for user");
    }

    const htmlBody = toHtml(message);
    const plainText = toPlainText(message);

    await resend.emails.send({
      from: config.from_address,
      to: user.email,
      subject: "Vonzio Notification",
      html: emailLayout({ name: user.name, body: htmlBody }),
      text: plainText,
    });
  }

  private async sendViaWebhook(
    integration: { config: Record<string, unknown> },
    message: string,
    urgency: string,
  ): Promise<void> {
    const config = integration.config as { url: string; secret?: string };
    const payload = { message, urgency, timestamp: new Date().toISOString() };
    const body = JSON.stringify(payload);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.secret) {
      const sig = createHmac("sha256", config.secret).update(body).digest("hex");
      headers["X-Signature-256"] = `sha256=${sig}`;
    }

    const res = await fetch(config.url, { method: "POST", headers, body });
    if (!res.ok) {
      throw new Error(`Webhook returned ${res.status}`);
    }
  }

  private async logNotification(opts: {
    userId: string; channel: string; message: string; urgency: string;
    source: string; taskId?: string; status: string; error?: string;
  }): Promise<void> {
    try {
      await this.deps.db.insert(schema.notificationLog).values({
        id: `nlog_${nanoid()}`,
        user_id: opts.userId,
        channel: opts.channel,
        message: opts.message,
        urgency: opts.urgency,
        source: opts.source,
        task_id: opts.taskId ?? null,
        status: opts.status,
        error: opts.error ?? null,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      this.log.error({ err }, "Failed to log notification");
    }
  }
}
