// Real notify handler for kind "telegram". Moved here from
// packages/core-server/src/services/notification-service.ts as part
// of the 3C inversion. Implements:
//  - resolve recipient (integration id) -> Telegram bot + chat config
//  - format markdown -> Telegram MarkdownV2
//  - split into <=4000 char chunks
//  - send via Bot API, with plain-text fallback if MarkdownV2 parsing
//    fails server-side
//  - attach thread-claim inline keyboard to the LAST chunk only when
//    metadata.threadClaim is set, and persist a
//    telegram_playbook_threads row so callback queries can resolve
//    message_id -> sessionId
//
// `telegramPlaybookThreads` is still in core's schema for now (the
// schema-move PR is later in the 3C arc). The plugin uses raw SQL
// against the table for that one write; once schema moves into the
// plugin, this turns into a normal drizzle insert against plugin-
// owned tables.
//
// The handler contract is `NotificationHandler` from @vonzio/plugin-api:
//   (NotificationRequest) -> Promise<NotificationResult>.

import { sql } from "drizzle-orm";
import { encodeThreadClaim, encodeThreadDismiss } from "@vonzio/shared";
import type { NotificationHandler, PluginContext } from "@vonzio/plugin-api";
import type { TelegramConfig } from "./types.js";
import {
  TelegramService,
  markdownToTelegram,
  splitTelegramMessage,
} from "./services/telegram-service.js";

interface TelegramNotifyMetadata {
  userId?: string;
  threadClaim?: { sessionId: string; label?: string };
}

/** Drizzle handle interface narrowed to what this handler uses. */
interface DbHandle {
  execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

/**
 * Build a NotificationHandler bound to the plugin's services + context.
 * Called from init().
 */
export function buildTelegramNotifyHandler(ctx: PluginContext): NotificationHandler {
  const telegramService = new TelegramService();

  return async function notifyTelegram(req) {
    const meta = (req.metadata ?? {}) as TelegramNotifyMetadata;
    const integrationId = req.recipient;

    // Look up the user's Telegram integration (decrypted) via core's
    // adapter. Plugin doesn't touch the user_integrations table
    // directly -- core owns it.
    const integration = await ctx.core.integrations.get(integrationId, { decrypt: true });
    if (!integration) {
      return {
        ok: false,
        error: `Telegram integration ${integrationId} not found`,
        retryable: false,
      };
    }
    if (meta.userId && integration.user_id !== meta.userId) {
      return {
        ok: false,
        error: `Telegram integration ${integrationId} does not belong to user`,
        retryable: false,
      };
    }
    if (integration.type !== "telegram") {
      return {
        ok: false,
        error: `Integration ${integrationId} is not telegram`,
        retryable: false,
      };
    }

    const config = integration.config as unknown as TelegramConfig;
    if (!config.owner_tg_user_id) {
      return {
        ok: false,
        error: "Telegram bot not linked yet. Send /link <code> in Telegram first.",
        retryable: false,
      };
    }

    const formatted = markdownToTelegram(req.text);
    const chunks = splitTelegramMessage(formatted, 4000);

    // Attach the thread-claim keyboard to the LAST chunk only -- earlier
    // chunks are just continuations of the same logical message; we
    // want one set of buttons at the bottom.
    const threadClaim = meta.threadClaim;
    const lastIdx = chunks.length - 1;
    let lastSentMessageId: number | null = null;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isLast = i === lastIdx;
      const replyMarkup =
        isLast && threadClaim
          ? {
              inline_keyboard: [
                [
                  { text: "📎 Reply here", callback_data: encodeThreadClaim(threadClaim.sessionId) },
                  { text: "💬 Keep my chat", callback_data: encodeThreadDismiss(threadClaim.sessionId) },
                ],
              ],
            }
          : undefined;

      try {
        const sent = await telegramService.sendMessage(config.bot_token, {
          chat_id: config.owner_tg_user_id,
          text: chunk,
          parse_mode: "MarkdownV2",
          disable_web_page_preview: true,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
        if (isLast) lastSentMessageId = sent.message_id;
      } catch (mvErr) {
        // MarkdownV2 parse rejection from the API -- retry as plain
        // text after stripping the V2 escapes. Surfaces a failure
        // result if even that fails.
        try {
          const sent = await telegramService.sendMessage(config.bot_token, {
            chat_id: config.owner_tg_user_id,
            text: chunk.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1"),
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          });
          if (isLast) lastSentMessageId = sent.message_id;
        } catch (plainErr) {
          ctx.log.warn(
            { mvErr: String(mvErr), plainErr: String(plainErr) },
            "Telegram send failed (both MarkdownV2 and plain text)",
          );
          return {
            ok: false,
            error: plainErr instanceof Error ? plainErr.message : String(plainErr),
            // Telegram API failures are usually rate-limit or temporary
            // server issues -- worth a retry from the caller's side.
            retryable: true,
          };
        }
      }
    }

    // Persist the thread-claim row tied to the last chunk's message_id
    // so the callback_query handler (in telegram-events.ts, still in
    // core for now) can resolve which session this message belongs to.
    if (threadClaim && lastSentMessageId !== null) {
      if (!config.bot_user_id) {
        // Required for the PK lookup in telegram-events. Skip rather
        // than writing empty-string keys that won't match anything.
        ctx.log.warn(
          { sessionId: threadClaim.sessionId },
          "Skipping telegram_playbook_threads insert -- bot_user_id missing in config",
        );
      } else {
        try {
          // Raw SQL because telegram_playbook_threads is still in core's
          // schema for this PR. Becomes a typed drizzle insert against
          // plugin-owned tables once the schema-move PR lands.
          const db = ctx.core.db as DbHandle;
          const label = threadClaim.label ?? null;
          await db.execute(sql`
            INSERT INTO telegram_playbook_threads
              (bot_user_id, chat_id, message_id, session_id, label, sent_at)
            VALUES (
              ${config.bot_user_id},
              ${String(config.owner_tg_user_id)},
              ${String(lastSentMessageId)},
              ${threadClaim.sessionId},
              ${label},
              ${new Date().toISOString()}
            )
          `);
        } catch (err) {
          // The message itself went out; the thread-claim row not
          // existing just means replies fall back to existing
          // telegram_active_sessions routing (same behavior as before
          // feature #18). Don't fail the notification over this.
          ctx.log.warn(
            { err: err instanceof Error ? err.message : String(err), sessionId: threadClaim.sessionId },
            "Failed to persist telegram_playbook_threads row",
          );
        }
      }
    }

    return { ok: true };
  };
}
