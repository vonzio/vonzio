// Real notify handler for kind "slack". Moved from
// packages/core-server/src/services/notification-service.ts in
// Phase 3E.2 as part of the bus inversion (same pattern as
// telegram's #74). Implements:
//  - resolve recipient (integration id) -> bot_token + authed_user_id
//  - open a Slack DM channel for the authed user
//  - send the message via Bot API with slackify-markdown formatting
//
// The handler contract is `NotificationHandler` from @vonzio/plugin-api:
//   (NotificationRequest) -> Promise<NotificationResult>.

import { slackifyMarkdown } from "slackify-markdown";
import type { NotificationHandler, PluginContext } from "@vonzio/plugin-api";
import type { SlackConfig } from "./types.js";
import { SlackService } from "./services/slack-service.js";

interface SlackNotifyMetadata {
  userId?: string;
}

function toSlackMrkdwn(markdown: string): string {
  return slackifyMarkdown(markdown).trim();
}

/**
 * Build a NotificationHandler bound to the plugin context. Called
 * from init().
 */
export function buildSlackNotifyHandler(ctx: PluginContext): NotificationHandler {
  const slackService = new SlackService(ctx.http);

  return async function notifySlack(req) {
    const meta = (req.metadata ?? {}) as SlackNotifyMetadata;
    const integrationId = req.recipient;

    const integration = await ctx.core.integrations.get(integrationId, { decrypt: true });
    if (!integration) {
      return {
        ok: false,
        error: `Slack integration ${integrationId} not found`,
        retryable: false,
      };
    }
    if (meta.userId && integration.user_id !== meta.userId) {
      return {
        ok: false,
        error: `Slack integration ${integrationId} does not belong to user`,
        retryable: false,
      };
    }
    if (integration.type !== "slack") {
      return {
        ok: false,
        error: `Integration ${integrationId} is not slack`,
        retryable: false,
      };
    }

    const config = integration.config as unknown as SlackConfig;

    // Open a DM channel with the authed user (Slack's conversations.open
    // is idempotent -- returns the existing DM if one exists).
    try {
      const res = await ctx.http.fetch("https://slack.com/api/conversations.open", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.bot_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ users: config.authed_user_id }),
      });
      const data = await res.json() as Record<string, unknown>;
      const dmChannel = (data.channel as Record<string, unknown>)?.id as string | undefined;
      if (!dmChannel) {
        ctx.log.warn({ integrationId, slackErr: data.error }, "Slack conversations.open returned no channel");
        return {
          ok: false,
          error: "Failed to open Slack DM channel",
          retryable: true,
        };
      }
      await slackService.sendMessage(config.bot_token, {
        channel: dmChannel,
        text: toSlackMrkdwn(req.text),
      });
      return { ok: true };
    } catch (err) {
      ctx.log.warn(
        { err: err instanceof Error ? err.message : String(err), integrationId },
        "Slack notify send failed",
      );
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        // Slack rate-limits hit this path; worth a retry from the
        // caller's side.
        retryable: true,
      };
    }
  };
}
