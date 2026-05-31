// @vonzio/plugin-telegram — backend half.
//
// What this plugin does at this point in the 3C arc:
//  - declares its env-config namespace (PLATFORM_TELEGRAM_*) plus
//    BETTER_AUTH_URL (read out of process.env, not validated -- core
//    already validated it and rejects on invalid)
//  - registers a notification handler for kind "telegram" that
//    resolves the recipient -> integration row -> Bot API send
//  - registers the /v1/integrations/telegram/* setup routes
//    (route paths preserved verbatim via routePrefix: { kind:
//    "absolute" } so the dashboard's API client + bookmarks don't
//    break -- this validates the legacy-URL escape hatch on the
//    plugin contract)
//  - runs resyncTelegramBotCommands once at boot to refresh every
//    paired bot's /setMyCommands menu
//
// Still to land in 3C follow-ups:
//  - telegram-events.ts (webhook + relay) -- biggest remaining piece
//  - db schema + migrations (telegram_*_sessions, telegram_playbook_threads)
//  - orchestrator hook (replace orchestrator's direct DB read of
//    telegramSessions with a SessionEvents subscription)
//  - dashboard Telegram UI (settings card actual content)

import { z } from "zod";
import type { VonzioPlugin, PluginTelegramPlatformBot } from "@vonzio/plugin-api";
import { TelegramService } from "./services/telegram-service.js";
import { buildTelegramNotifyHandler } from "./notify-handler.js";
import { telegramSetupRoutes, resyncTelegramBotCommands } from "./routes/setup.js";

const configSchema = z.object({
  PLATFORM_TELEGRAM_BOT_TOKEN: z.string().optional(),
  PLATFORM_TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  // BETTER_AUTH_URL is a CORE env var (not telegram-specific). We
  // re-validate it here so the plugin's webhook construction has it
  // typed -- core has already loaded process.env.dotenv so the
  // value is set.
  BETTER_AUTH_URL: z.string().default("http://localhost:3000"),
});

type TelegramPluginConfig = z.infer<typeof configSchema>;

/**
 * When core didn't expose its PlatformBotService (rare -- typically
 * happens in test setups), supply a disabled stub so the setup
 * routes' platform-bot connect endpoint can return a clean 503
 * instead of crashing on .getMetadata().
 */
const disabledPlatformBot: PluginTelegramPlatformBot = {
  getMetadata: () => null,
  getToken: () => null,
  getWebhookSecret: () => null,
  isConfigured: () => false,
};

const plugin: VonzioPlugin<TelegramPluginConfig> = {
  name: "telegram",
  apiVersion: "0.1.0",
  configSchema,
  routePrefix: { kind: "absolute", prefix: "/v1/integrations/telegram" },

  async init(ctx) {
    ctx.log.info(
      { hasPlatformBot: Boolean(ctx.config.PLATFORM_TELEGRAM_BOT_TOKEN) },
      "telegram plugin init",
    );

    const telegramService = new TelegramService();
    const platformBot = ctx.core.telegramPlatformBot ?? disabledPlatformBot;

    // Health check -- proves the route wires alongside the legacy
    // setup routes. Same /v1/integrations/telegram prefix so it sits
    // next to /v1/integrations/telegram/config without extra fastify
    // scope.
    ctx.server.get("/v1/integrations/telegram/_health", async () => ({
      plugin: "telegram",
      status: "ok",
      apiVersion: "0.1.0",
      hasPlatformBot: platformBot.isConfigured(),
    }));

    // Register all the legacy /v1/integrations/telegram/* setup routes
    // via the moved-here fastify-plugin. Same registration shape as
    // when this was wired in core-server's buildServer.
    await ctx.server.register(telegramSetupRoutes, {
      betterAuthUrl: ctx.config.BETTER_AUTH_URL,
      integrationService: ctx.core.integrations,
      telegramService,
      profileService: ctx.core.profiles,
      workspaceService: ctx.core.workspaces,
      platformBotService: platformBot,
      authHook: ctx.core.authHook,
    });

    // Real notification handler -- resolves req.recipient (integration
    // id) -> bot_token + chat -> chunked MarkdownV2 send with
    // plain-text fallback -> thread-claim row persistence.
    ctx.notificationBus.registerHandler("telegram", buildTelegramNotifyHandler(ctx));

    // Fire-and-forget command-menu resync. Telegram caches the slash-
    // command menu client-side, so any deploy that changes BOT_COMMANDS
    // needs to push the new list to every paired bot once. Failure
    // logs but doesn't block startup.
    void resyncTelegramBotCommands({
      integrationService: ctx.core.integrations,
      telegramService,
      platformBotToken: platformBot.getToken(),
      log: ctx.log,
    });
  },
};

export default plugin;
