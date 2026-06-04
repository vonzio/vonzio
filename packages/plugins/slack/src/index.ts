// @vonzio/plugin-slack -- backend half.
//
// As of Phase 3E.2 the plugin owns the full Slack backend surface:
//  - declares its env-config namespace (SLACK_CLIENT_ID / _SECRET /
//    SIGNING_SECRET) + BETTER_AUTH_URL (read out of process.env;
//    core already validated it)
//  - registers the notification handler for kind "slack" (kind ->
//    recipient -> integration row -> Bot API DM send)
//  - registers /v1/integrations/slack/{config,authorize} (auth-gated,
//    wrapped in a child scope so fp() doesn't leak the auth hook to
//    the public callback below)
//  - registers /api/slack/{events,callback} (public, secret/signature-
//    validated per-request)
//  - registers the chat-surface presence provider that previously
//    lived in core's lib/builtin-presence-providers.ts
//  - owns the slack_thread_mappings schema + a single idempotent
//    plugin migration

import { z } from "zod";
import type { VonzioPlugin } from "@vonzio/plugin-api";
import { SlackService } from "./services/slack-service.js";
import { buildSlackNotifyHandler } from "./notify-handler.js";
import { slackEventsRoutes } from "./routes/events.js";
import { slackOAuthRoutes, slackOAuthCallbackRoute } from "./routes/oauth.js";
import { buildSlackPresenceProvider } from "./presence-provider.js";
import { slackMigrations } from "./db/migrations.js";

const configSchema = z.object({
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z.string().default("http://localhost:3000"),
});

type SlackPluginConfig = z.infer<typeof configSchema>;

const plugin: VonzioPlugin<SlackPluginConfig> = {
  name: "slack",
  apiVersion: "0.1.0",
  configSchema,
  migrations: slackMigrations,

  async init(ctx) {
    ctx.log.info(
      {
        hasOauthConfig: Boolean(ctx.config.SLACK_CLIENT_ID && ctx.config.SLACK_CLIENT_SECRET),
        hasSigningSecret: Boolean(ctx.config.SLACK_SIGNING_SECRET),
      },
      "slack plugin init",
    );

    const slackService = new SlackService(ctx.http);

    // Auth-gated OAuth routes (/v1/integrations/slack/config + authorize).
    // Wrap in an explicit child scope so the addHook("onRequest",
    // authHook) inside slackOAuthRoutes only applies to those routes,
    // not to /api/slack/{events,callback} registered after on the same
    // ctx.server. Same fix pattern as setup.ts's #83.
    await ctx.server.register(async (oauthScope) => {
      await oauthScope.register(slackOAuthRoutes, {
        config: {
          SLACK_CLIENT_ID: ctx.config.SLACK_CLIENT_ID,
          SLACK_CLIENT_SECRET: ctx.config.SLACK_CLIENT_SECRET,
          BETTER_AUTH_URL: ctx.config.BETTER_AUTH_URL,
        },
        integrationService: ctx.core.integrations,
        encryption: ctx.core.encryption,
        http: ctx.http,
        authHook: ctx.core.authHook,
      });
    });

    // Public OAuth callback (/api/slack/callback). Slack redirects
    // the user's browser here after the authorize page; no cookie
    // attached, validates via the encrypted state param.
    await ctx.server.register(slackOAuthCallbackRoute, {
      config: {
        SLACK_CLIENT_ID: ctx.config.SLACK_CLIENT_ID,
        SLACK_CLIENT_SECRET: ctx.config.SLACK_CLIENT_SECRET,
        BETTER_AUTH_URL: ctx.config.BETTER_AUTH_URL,
      },
      integrationService: ctx.core.integrations,
      encryption: ctx.core.encryption,
      http: ctx.http,
    });

    // /api/slack/events + the 5 orchestrator-event subscriptions.
    // Public per-request signature validation; no authHook.
    await ctx.server.register(slackEventsRoutes, {
      config: {
        SLACK_SIGNING_SECRET: ctx.config.SLACK_SIGNING_SECRET,
        BETTER_AUTH_URL: ctx.config.BETTER_AUTH_URL,
      },
      db: ctx.core.db as never,
      integrationService: ctx.core.integrations,
      slackService,
      taskService: ctx.core.tasks,
      profileService: {
        ...ctx.core.profiles,
        ...ctx.core.profileResolver,
      },
      sessionRegistry: ctx.core.sessionLifecycle,
      workspaceService: ctx.core.workspaces,
      orchestrator: ctx.core.orchestrator,
      eventLog: ctx.core.eventLog,
      imageRewriterService: ctx.core.imageRewriter,
      modelListService: ctx.core.modelList,
      sessionEvents: ctx.sessionEvents,
      http: ctx.http,
    });

    // Bus-inverted notify handler (kind = "slack"). Same pattern as
    // telegram's #74; NotificationService.send("slack:...") routes
    // here via notificationBus.dispatch.
    ctx.notificationBus.registerHandler("slack", buildSlackNotifyHandler(ctx));

    // Chat-surface presence provider. Switched from raw SQL to typed
    // drizzle in 3E.2 now that the plugin owns the schema.
    ctx.core.sessionPresence.register(buildSlackPresenceProvider(ctx));
  },
};

export default plugin;
