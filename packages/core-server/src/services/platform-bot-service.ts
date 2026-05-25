/**
 * Platform-hosted Telegram bot.
 *
 * Single shared bot (one BotFather creation, one token) that any Vonzio
 * user can pair with in one tap — alternative to the per-user `/connect`
 * flow that requires a BotFather creation. Configuration:
 *
 *   PLATFORM_TELEGRAM_BOT_TOKEN     — bot token (env var, required to enable)
 *   PLATFORM_TELEGRAM_WEBHOOK_SECRET — secret_token Telegram echoes back
 *                                     in the x-telegram-bot-api-secret-token
 *                                     header (env var, required to enable)
 *
 * On startup we resolve the bot via getMe (cached for the lifetime of
 * the process) and register the webhook idempotently. When the env vars
 * are absent the service stays disabled — no startup failure, the
 * connect-platform endpoint just returns 503.
 */

import type { Config } from "../config.js";
import type { TelegramService } from "./telegram-service.js";

export interface PlatformBotMetadata {
  botUserId: string;
  botUsername: string;
}

export class PlatformBotService {
  private metadata: PlatformBotMetadata | null = null;
  private initStarted = false;

  constructor(
    private config: Config,
    private telegramService: TelegramService,
    private log: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
  ) {}

  /** True when both env vars are configured. Doesn't mean init has run yet. */
  isConfigured(): boolean {
    return !!(this.config.PLATFORM_TELEGRAM_BOT_TOKEN && this.config.PLATFORM_TELEGRAM_WEBHOOK_SECRET);
  }

  /** Cached metadata; null until init() has completed successfully. */
  getMetadata(): PlatformBotMetadata | null {
    return this.metadata;
  }

  /** Bot token, read straight from env each call so rotation takes effect immediately. */
  getToken(): string | null {
    return this.config.PLATFORM_TELEGRAM_BOT_TOKEN ?? null;
  }

  /** Secret that Telegram echoes in the webhook header. */
  getWebhookSecret(): string | null {
    return this.config.PLATFORM_TELEGRAM_WEBHOOK_SECRET ?? null;
  }

  /**
   * Validate the token via getMe, cache metadata, register the webhook
   * URL. Idempotent — setWebhook on the same URL is a no-op for Telegram.
   * Failure logs and disables the service (metadata stays null); does
   * NOT throw, so a misconfigured token can't take the whole server
   * down on boot.
   */
  async init(): Promise<void> {
    if (this.initStarted) return;
    this.initStarted = true;
    if (!this.isConfigured()) {
      this.log.info("platform telegram bot: not configured (PLATFORM_TELEGRAM_BOT_TOKEN unset) — feature disabled");
      return;
    }
    const token = this.getToken()!;
    const secret = this.getWebhookSecret()!;
    try {
      const me = await this.telegramService.getMe(token);
      if (!me.is_bot) {
        this.log.warn({ username: me.username }, "platform telegram: token does not belong to a bot account; feature disabled");
        return;
      }
      this.metadata = { botUserId: String(me.id), botUsername: me.username };

      const webhookBase = this.config.BETTER_AUTH_URL.replace(/\/$/, "");
      const webhookUrl = `${webhookBase}/api/telegram/webhook/${me.id}`;
      await this.telegramService.setWebhook(token, webhookUrl, secret);
      this.log.info({ botUsername: me.username, webhookUrl }, "platform telegram bot: ready");
    } catch (err) {
      this.log.error({ err }, "platform telegram bot init failed; feature disabled");
      this.metadata = null;
    }
  }
}
