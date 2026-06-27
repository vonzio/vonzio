/**
 * Re-export shim.
 *
 * The real implementation lives at
 * `packages/plugins/telegram/src/services/telegram-service.ts`
 * (exposed as `@vonzio/plugin-telegram/service`). This file exists
 * only so existing in-tree callers (telegram-events.ts,
 * notification-service.ts, platform-bot-service.ts) keep working
 * unchanged while the rest of the Telegram extraction lands
 * incrementally.
 *
 * Subsequent 3C PRs invert each caller (notification-service →
 * notificationBus.dispatch, orchestrator → SessionEvents
 * subscription, routes move into the plugin), at which point this
 * file is deleted.
 */

export {
  TelegramService,
  escapeMarkdownV2,
  markdownToTelegram,
  splitTelegramMessage,
  toTelegramHtml,
  chunkMarkdown,
  stripTelegramHtml,
  type TelegramFile,
  type TelegramMe,
  type TelegramSendMessage,
  type TelegramSentMessage,
} from "@vonzio/plugin-telegram/service";
