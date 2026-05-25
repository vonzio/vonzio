import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Config } from "../config.js";
import type { IntegrationService } from "../services/integration-service.js";
import { encrypt, decrypt } from "../auth/crypto.js";

const SLACK_SCOPES = [
  "chat:write",
  "im:history",
  "im:read",
  "im:write",
  "app_mentions:read",
  "files:read",
  "files:write",
  "commands",
  "users:read",
].join(",");

export interface SlackOAuthRoutesOptions {
  config: Config;
  integrationService: IntegrationService;
  encryptionKey: string;
}

/**
 * Auth-guarded Slack OAuth routes — register inside the /v1 scope.
 */
export const slackOAuthRoutes = fp(
  async (server: FastifyInstance, opts: SlackOAuthRoutesOptions) => {
    const { config, encryptionKey } = opts;
    const callbackBase = config.BETTER_AUTH_URL.replace(/\/$/, "");

    server.get("/v1/integrations/slack/config", async () => {
      return {
        enabled: !!(config.SLACK_CLIENT_ID && config.SLACK_CLIENT_SECRET),
      };
    });

    server.get<{ Querystring: { returnPath?: string } }>(
      "/v1/integrations/slack/authorize",
      async (request, reply) => {
        if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET) {
          return reply.code(400).send({ error: "Slack OAuth not configured" });
        }

        const user = request.user!;
        const returnPath = request.query.returnPath ?? "/agents";
        const state = encrypt(
          JSON.stringify({ userId: user.id, returnPath, ts: Date.now() }),
          encryptionKey,
        );

        const redirectUri = `${callbackBase}/api/slack/callback`;
        const params = new URLSearchParams({
          client_id: config.SLACK_CLIENT_ID,
          scope: SLACK_SCOPES,
          redirect_uri: redirectUri,
          state,
        });

        return { url: `https://slack.com/oauth/v2/authorize?${params.toString()}` };
      },
    );
  },
  { name: "slack-oauth-routes" },
);

/**
 * Slack OAuth callback — register at top level (no auth, browser redirect).
 */
export const slackOAuthCallbackRoute = fp(
  async (server: FastifyInstance, opts: SlackOAuthRoutesOptions) => {
    const { config, integrationService, encryptionKey } = opts;
    const callbackBase = config.BETTER_AUTH_URL.replace(/\/$/, "");

    server.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
      "/api/slack/callback",
      async (request, reply) => {
        const { code, state, error: oauthError } = request.query;

        if (oauthError) {
          return reply.redirect(`/agents?oauth=error&message=${encodeURIComponent(oauthError)}#integrations`);
        }

        if (!code || !state) {
          return reply.redirect("/agents?oauth=error&message=missing_params#integrations");
        }

        // Decrypt and validate state
        let stateData: { userId: string; returnPath?: string; ts: number };
        try {
          stateData = JSON.parse(decrypt(state, encryptionKey));
        } catch {
          return reply.redirect("/agents?oauth=error&message=invalid_state#integrations");
        }

        const returnPath = stateData.returnPath ?? "/agents";

        // Check expiry (5 minutes)
        if (Date.now() - stateData.ts > 5 * 60 * 1000) {
          return reply.redirect(`${returnPath}?oauth=error&message=expired#integrations`);
        }

        if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET) {
          return reply.redirect(`${returnPath}?oauth=error&message=not_configured#integrations`);
        }

        try {
          // Exchange code for bot token
          const redirectUri = `${callbackBase}/api/slack/callback`;
          const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: config.SLACK_CLIENT_ID,
              client_secret: config.SLACK_CLIENT_SECRET,
              code,
              redirect_uri: redirectUri,
            }).toString(),
          });

          const tokenData = await tokenRes.json() as Record<string, unknown>;
          if (!tokenData.ok) {
            throw new Error((tokenData.error as string) ?? "Token exchange failed");
          }

          const teamInfo = tokenData.team as Record<string, string> | undefined;
          const authedUser = tokenData.authed_user as Record<string, string> | undefined;

          const slackConfig = {
            team_id: teamInfo?.id ?? "",
            team_name: teamInfo?.name ?? "Unknown workspace",
            bot_token: tokenData.access_token as string,
            bot_user_id: (tokenData.bot_user_id as string) ?? "",
            authed_user_id: authedUser?.id ?? "",
          };

          // Remove existing Slack integration for this user (replace)
          const existing = await integrationService.getByUserAndType(stateData.userId, "slack");
          if (existing) {
            await integrationService.delete(existing.id);
          }

          await integrationService.create(stateData.userId, "slack", slackConfig);

          return reply.redirect(`${returnPath}?oauth=success#integrations`);
        } catch (err) {
          server.log.error({ err }, "Slack OAuth token exchange failed");
          const message = err instanceof Error ? err.message : "exchange_failed";
          return reply.redirect(`${returnPath}?oauth=error&message=${encodeURIComponent(message)}#integrations`);
        }
      },
    );
  },
  { name: "slack-oauth-callback-route" },
);
