// @vonzio/plugin-telegram -- backend half.
//
// As of Phase 3D.1d.1 the plugin owns the full Telegram surface:
//  - declares its env-config namespace (PLATFORM_TELEGRAM_*) plus
//    BETTER_AUTH_URL (read out of process.env; core has already
//    validated it on boot)
//  - registers the notification handler for kind "telegram" (kind ->
//    recipient -> integration row -> Bot API send)
//  - registers the /v1/integrations/telegram/* setup routes
//    (config, bots, status, paircode, /connect, /connect-platform, ...)
//  - registers the /api/telegram/webhook/:botId webhook + the
//    orchestrator -> Telegram outbound relay (5 task:* subscriptions)
//  - constructs PlatformBotService locally and wires its init at boot
//  - owns the telegram_*_sessions + telegram_playbook_threads schema
//    + a single idempotent migration
//
// The plugin no longer requires PluginCore.telegramPlatformBot --
// PlatformBotService is plugin-internal now. Core's
// db/schema.ts telegram mirrors + v14/v19 migrations are also gone
// after this PR.

import { z } from "zod";
import type { VonzioPlugin } from "@vonzio/plugin-api";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { TelegramService } from "./services/telegram-service.js";
import { PlatformBotService } from "./services/platform-bot-service.js";
import { buildTelegramNotifyHandler } from "./notify-handler.js";
import { telegramSetupRoutes, resyncTelegramBotCommands } from "./routes/setup.js";
import { telegramEventsRoutes } from "./routes/events.js";
import { buildTelegramPresenceProvider } from "./presence-provider.js";
import { telegramMigrations } from "./db/migrations.js";

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

const plugin: VonzioPlugin<TelegramPluginConfig> = {
  name: "telegram",
  apiVersion: "0.1.0",
  configSchema,
  migrations: telegramMigrations,
  routePrefix: { kind: "absolute", prefix: "/v1/integrations/telegram" },

  async init(ctx) {
    ctx.log.info(
      { hasPlatformBot: Boolean(ctx.config.PLATFORM_TELEGRAM_BOT_TOKEN) },
      "telegram plugin init",
    );

    const telegramService = new TelegramService();
    // PlatformBotService is now plugin-local; construct + kick off
    // init() (fire-and-forget -- failure logs and disables the
    // feature without blocking boot).
    const platformBotService = new PlatformBotService(
      ctx.config,
      telegramService,
      ctx.log,
    );
    void platformBotService.init();

    // Health check -- proves the route wires alongside the legacy
    // setup routes. Same /v1/integrations/telegram prefix so it sits
    // next to /v1/integrations/telegram/config without extra fastify
    // scope.
    ctx.server.get("/v1/integrations/telegram/_health", async () => ({
      plugin: "telegram",
      status: "ok",
      apiVersion: "0.1.0",
      hasPlatformBot: platformBotService.isConfigured(),
    }));

    // /v1/integrations/telegram/* setup routes (auth-gated via
    // ctx.core.authHook inside the registration).
    await ctx.server.register(telegramSetupRoutes, {
      betterAuthUrl: ctx.config.BETTER_AUTH_URL,
      integrationService: ctx.core.integrations,
      telegramService,
      profileService: ctx.core.profiles,
      workspaceService: ctx.core.workspaces,
      platformBotService,
      authHook: ctx.core.authHook,
    });

    // /api/telegram/webhook/:botId + the 5 orchestrator-event
    // subscriptions. Path is absolute (set on Telegram's side via
    // setWebhook) -- not under the plugin's auto-prefix. Auth is
    // per-request (the x-telegram-bot-api-secret-token header
    // constant-time compared to the per-bot secret), so no authHook.
    //
    // The profileService passed here intersects PluginProfileLookup
    // (list, get) and PluginProfileResolver (getResolved) -- the
    // events file uses both shapes. The sessionRegistry param is
    // PluginSessionLifecycle (register / extendExpiry / setStatus /
    // getConnectedSessionIds).
    await ctx.server.register(telegramEventsRoutes, {
      config: { BETTER_AUTH_URL: ctx.config.BETTER_AUTH_URL },
      db: ctx.core.db as NodePgDatabase<Record<string, never>>,
      integrationService: ctx.core.integrations,
      telegramService,
      taskService: ctx.core.tasks,
      profileService: {
        ...ctx.core.profiles,
        ...ctx.core.profileResolver,
      },
      sessionRegistry: ctx.core.sessionLifecycle,
      workspaceService: ctx.core.workspaces,
      orchestrator: ctx.core.orchestrator,
      eventLog: ctx.core.eventLog,
      connectionManager: ctx.core.connectionManager,
      imageRewriterService: ctx.core.imageRewriter,
      platformBotService,
      modelListService: ctx.core.modelList,
      sessionEvents: ctx.sessionEvents,
    });

    // Real notification handler -- resolves req.recipient (integration
    // id) -> bot_token + chat -> chunked MarkdownV2 send with
    // plain-text fallback -> thread-claim row persistence.
    ctx.notificationBus.registerHandler("telegram", buildTelegramNotifyHandler(ctx));

    // Chat-surface presence provider. Replaces the three places where
    // core used to read schema.telegram* directly.
    ctx.core.sessionPresence.register(buildTelegramPresenceProvider(ctx));

    // Fire-and-forget command-menu resync. Telegram caches the slash-
    // command menu client-side, so any deploy that changes BOT_COMMANDS
    // needs to push the new list to every paired bot once.
    void resyncTelegramBotCommands({
      integrationService: ctx.core.integrations,
      telegramService,
      platformBotToken: platformBotService.getToken(),
      log: ctx.log,
    });
  },
};

export default plugin;
