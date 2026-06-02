// @vonzio/plugin-slack -- backend half.
//
// Second plugin in the extraction arc. Phase 3E validates that the
// @vonzio/plugin-api contract from Phase 3D generalizes to a non-
// Telegram chat surface without breaking changes.
//
// State at Phase 3E.1 (scaffold):
//  - declares its env-config namespace (SLACK_CLIENT_ID / _SECRET /
//    SIGNING_SECRET) so the schema parser short-circuits cleanly when
//    the values are absent (slack disabled, plugin still loads)
//  - registers the chat-surface presence provider that previously
//    lived as a builtin in core's lib/builtin-presence-providers.ts
//
// Coming in follow-ups:
//  - 3E.2: slack-service.ts + slack_thread_mappings schema + plugin
//    migration
//  - 3E.3: slack-events.ts + slack-oauth.ts + notify handler + 5
//    task:* sessionEvents subscriptions; remove core's slack imports
//    from server.ts; dashboard API client move
//
// All four PRs leave @vonzio/plugin-api unchanged -- that's the
// architectural bet of Phase 3D.

import { z } from "zod";
import type { VonzioPlugin } from "@vonzio/plugin-api";
import { buildSlackPresenceProvider } from "./presence-provider.js";

const configSchema = z.object({
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
});

type SlackPluginConfig = z.infer<typeof configSchema>;

const plugin: VonzioPlugin<SlackPluginConfig> = {
  name: "slack",
  apiVersion: "0.1.0",
  configSchema,

  async init(ctx) {
    ctx.log.info(
      {
        hasOauthConfig: Boolean(ctx.config.SLACK_CLIENT_ID && ctx.config.SLACK_CLIENT_SECRET),
        hasSigningSecret: Boolean(ctx.config.SLACK_SIGNING_SECRET),
      },
      "slack plugin init",
    );

    // Chat-surface presence provider. Graduates the slack builtin
    // from core's lib/builtin-presence-providers.ts -- core deletes
    // its registration of the same provider in the same PR.
    ctx.core.sessionPresence.register(buildSlackPresenceProvider(ctx));
  },
};

export default plugin;
