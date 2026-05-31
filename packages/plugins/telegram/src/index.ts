// @vonzio/plugin-telegram -- backend half.
//
// POC SCAFFOLD: this file is the minimum viable plugin shape -- it
// satisfies the VonzioPlugin contract and proves the loader path
// end-to-end. The real Telegram routes / service / migrations land
// in subsequent PRs of the 3C arc.
//
// Today this plugin:
//  - declares its env-config namespace (TELEGRAM_*)
//  - registers a notification handler for kind "telegram" that
//    no-ops with a structured log (so a notify request that would
//    have gone to Telegram doesn't 404 silently while extraction is
//    in flight)
//  - serves a /plugins/telegram/health route so the routing wire-up
//    is observable
//
// Future PRs in the 3C arc fold in:
//  - telegram-service.ts (API client)
//  - telegram-events.ts (webhook + relay)
//  - telegram-setup.ts (per-user + platform-bot setup)
//  - schema + migrations (telegram_active_sessions, telegram_sessions,
//    telegram_playbook_threads)
//  - resyncTelegramBotCommands scheduled job
//  - orchestrator hook (replace orchestrator's direct DB read with a
//    SessionEvents subscription)

import { z } from "zod";
import type { VonzioPlugin } from "@vonzio/plugin-api";
import { buildTelegramNotifyHandler } from "./notify-handler.js";

const configSchema = z.object({
  // Shared platform bot (matches the existing core env vars so the
  // extraction won't require deployers to rename anything).
  PLATFORM_TELEGRAM_BOT_TOKEN: z.string().optional(),
  PLATFORM_TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
});

type TelegramConfig = z.infer<typeof configSchema>;

const plugin: VonzioPlugin<TelegramConfig> = {
  name: "telegram",
  apiVersion: "0.1.0",
  configSchema,

  async init(ctx) {
    ctx.log.info(
      { hasPlatformBot: Boolean(ctx.config.PLATFORM_TELEGRAM_BOT_TOKEN) },
      "telegram plugin init (POC scaffold)",
    );

    // Health check -- proves the route wires under the plugin prefix.
    // routePrefix defaults to { kind: "auto" }, so this URL becomes
    // GET /plugins/telegram/health at runtime.
    ctx.server.get("/plugins/telegram/health", async () => ({
      plugin: "telegram",
      status: "ok",
      apiVersion: "0.1.0",
      hasPlatformBot: Boolean(ctx.config.PLATFORM_TELEGRAM_BOT_TOKEN),
    }));

    // Real notification handler -- resolves the integration via
    // ctx.core.integrations.get(), formats markdown to MarkdownV2,
    // chunks to <=4000 chars, sends through the Bot API with
    // plain-text fallback, optionally writes a telegram_playbook_threads
    // row for thread-claim. Moved from core-server's notification-service
    // as part of the 3C inversion arc.
    ctx.notificationBus.registerHandler("telegram", buildTelegramNotifyHandler(ctx));
  },
};

export default plugin;
