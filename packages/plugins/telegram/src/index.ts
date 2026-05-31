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

    // No-op notification handler -- prevents notify({ kind: "telegram" })
    // calls from returning the bus's synthetic "no handler" error while
    // the real implementation is being moved in piecewise. Replaced with
    // the actual telegramService.sendMessage call in the next PR.
    ctx.notificationBus.registerHandler("telegram", async (req) => {
      ctx.log.warn(
        { recipient: req.recipient, textPreview: req.text.slice(0, 40) },
        "telegram notification stub -- extraction in progress, message dropped",
      );
      return { ok: true };
    });
  },
};

export default plugin;
