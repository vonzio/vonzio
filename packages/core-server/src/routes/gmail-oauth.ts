import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Config } from "../config.js";
import type { IntegrationService } from "../services/integration-service.js";
import { encrypt, decrypt } from "../auth/crypto.js";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

export function resolveGoogleCredentials(config: Config) {
  const clientId = config.GMAIL_CLIENT_ID || config.AUTH_GOOGLE_CLIENT_ID;
  const clientSecret = config.GMAIL_CLIENT_SECRET || config.AUTH_GOOGLE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export interface GmailOAuthRoutesOptions {
  config: Config;
  integrationService: IntegrationService;
  encryptionKey: string;
}

/**
 * Auth-guarded Gmail OAuth routes — register inside the /v1 scope.
 */
export const gmailOAuthRoutes = fp(
  async (server: FastifyInstance, opts: GmailOAuthRoutesOptions) => {
    const { config, encryptionKey } = opts;
    const callbackBase = config.BETTER_AUTH_URL.replace(/\/$/, "");

    server.get("/v1/integrations/gmail/config", async () => {
      return { enabled: !!resolveGoogleCredentials(config) };
    });

    server.get<{ Querystring: { returnPath?: string } }>(
      "/v1/integrations/gmail/authorize",
      async (request, reply) => {
        const creds = resolveGoogleCredentials(config);
        if (!creds) {
          return reply.code(400).send({ error: "Gmail OAuth not configured" });
        }

        const user = request.user!;
        const returnPath = request.query.returnPath ?? "/settings";
        const state = encrypt(
          JSON.stringify({ userId: user.id, returnPath, ts: Date.now() }),
          encryptionKey,
        );

        const redirectUri = `${callbackBase}/api/gmail/callback`;
        const params = new URLSearchParams({
          client_id: creds.clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: GMAIL_SCOPES,
          access_type: "offline",
          prompt: "consent",
          state,
        });

        return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` };
      },
    );
  },
  { name: "gmail-oauth-routes" },
);

/**
 * Gmail OAuth callback — register at top level (no auth, browser redirect).
 */
export const gmailOAuthCallbackRoute = fp(
  async (server: FastifyInstance, opts: GmailOAuthRoutesOptions) => {
    const { config, integrationService, encryptionKey } = opts;
    const callbackBase = config.BETTER_AUTH_URL.replace(/\/$/, "");

    server.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
      "/api/gmail/callback",
      async (request, reply) => {
        const { code, state, error: oauthError } = request.query;

        if (oauthError) {
          return reply.redirect(`/settings?oauth=error&message=${encodeURIComponent(oauthError)}#integrations`);
        }

        if (!code || !state) {
          return reply.redirect("/settings?oauth=error&message=missing_params#integrations");
        }

        let stateData: { userId: string; returnPath?: string; ts: number };
        try {
          stateData = JSON.parse(decrypt(state, encryptionKey));
        } catch {
          return reply.redirect("/settings?oauth=error&message=invalid_state#integrations");
        }

        const returnPath = stateData.returnPath ?? "/settings";

        // Check expiry (5 minutes)
        if (Date.now() - stateData.ts > 5 * 60 * 1000) {
          return reply.redirect(`${returnPath}?oauth=error&message=expired#integrations`);
        }

        const creds = resolveGoogleCredentials(config);
        if (!creds) {
          return reply.redirect(`${returnPath}?oauth=error&message=not_configured#integrations`);
        }

        try {
          const redirectUri = `${callbackBase}/api/gmail/callback`;

          // Exchange code for tokens
          const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: creds.clientId,
              client_secret: creds.clientSecret,
              code,
              redirect_uri: redirectUri,
              grant_type: "authorization_code",
            }).toString(),
          });

          const tokenData = (await tokenRes.json()) as Record<string, unknown>;
          if (tokenData.error) {
            throw new Error((tokenData.error_description as string) ?? (tokenData.error as string));
          }

          const accessToken = tokenData.access_token as string;
          const refreshToken = tokenData.refresh_token as string;

          if (!refreshToken) {
            throw new Error("No refresh token received. Try revoking app access in Google Account settings and reconnecting.");
          }

          // Fetch user's email address
          const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!profileRes.ok) {
            throw new Error(`Failed to fetch Google profile (${profileRes.status})`);
          }
          const profile = (await profileRes.json()) as Record<string, unknown>;
          const email = profile.email as string;
          if (!email) {
            throw new Error("Google profile did not include an email address");
          }

          const gmailConfig = {
            email,
            refresh_token: refreshToken,
            access_token: accessToken,
            token_expiry: Date.now() + ((tokenData.expires_in as number) ?? 3600) * 1000,
          };

          // Replace existing Gmail integration for this user
          const existing = await integrationService.getByUserAndType(stateData.userId, "gmail");
          if (existing) {
            await integrationService.delete(existing.id);
          }

          await integrationService.create(stateData.userId, "gmail", gmailConfig);

          return reply.redirect(`${returnPath}?oauth=success&message=gmail_connected#integrations`);
        } catch (err) {
          server.log.error({ err }, "Gmail OAuth token exchange failed");
          const message = err instanceof Error ? err.message : "exchange_failed";
          return reply.redirect(`${returnPath}?oauth=error&message=${encodeURIComponent(message)}#integrations`);
        }
      },
    );
  },
  { name: "gmail-oauth-callback-route" },
);
