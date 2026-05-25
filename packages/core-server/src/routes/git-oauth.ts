import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { Config } from "../config.js";
import type { GitProviderService } from "../services/git-provider-service.js";
import { encrypt, decrypt } from "../auth/crypto.js";

type ProviderType = "github" | "gitlab" | "bitbucket";

interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string;
}

export interface GitOAuthRoutesOptions {
  config: Config;
  gitProviderService: GitProviderService;
  encryptionKey: string;
}

function getProviderConfig(config: Config, provider: ProviderType): OAuthProviderConfig | null {
  switch (provider) {
    case "github":
      if (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET) return null;
      return {
        clientId: config.GITHUB_CLIENT_ID,
        clientSecret: config.GITHUB_CLIENT_SECRET,
        authorizeUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        userInfoUrl: "https://api.github.com/user",
        scopes: "repo",
      };
    case "gitlab":
      if (!config.GITLAB_CLIENT_ID || !config.GITLAB_CLIENT_SECRET) return null;
      return {
        clientId: config.GITLAB_CLIENT_ID,
        clientSecret: config.GITLAB_CLIENT_SECRET,
        authorizeUrl: "https://gitlab.com/oauth/authorize",
        tokenUrl: "https://gitlab.com/oauth/token",
        userInfoUrl: "https://gitlab.com/api/v4/user",
        scopes: "read_user read_repository write_repository",
      };
    case "bitbucket":
      if (!config.BITBUCKET_CLIENT_ID || !config.BITBUCKET_CLIENT_SECRET) return null;
      return {
        clientId: config.BITBUCKET_CLIENT_ID,
        clientSecret: config.BITBUCKET_CLIENT_SECRET,
        authorizeUrl: "https://bitbucket.org/site/oauth2/authorize",
        tokenUrl: "https://bitbucket.org/site/oauth2/access_token",
        userInfoUrl: "https://api.bitbucket.org/2.0/user",
        scopes: "repository",
      };
    default:
      return null;
  }
}

/**
 * Auth-guarded OAuth routes — register inside the /v1 scope.
 * - GET /v1/git-providers/oauth/config
 * - GET /v1/git-providers/oauth/:provider/authorize
 */
export const gitOAuthRoutes = fp(
  async (server: FastifyInstance, opts: GitOAuthRoutesOptions) => {
    const { config, encryptionKey } = opts;
    const callbackBase = config.BETTER_AUTH_URL.replace(/\/$/, "");

    server.get("/v1/git-providers/oauth/config", async () => {
      return {
        github: !!(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET),
        gitlab: !!(config.GITLAB_CLIENT_ID && config.GITLAB_CLIENT_SECRET),
        bitbucket: !!(config.BITBUCKET_CLIENT_ID && config.BITBUCKET_CLIENT_SECRET),
      };
    });

    server.get<{ Params: { provider: string }; Querystring: { returnPath?: string } }>(
      "/v1/git-providers/oauth/:provider/authorize",
      async (request, reply) => {
        const provider = request.params.provider as ProviderType;
        const providerConfig = getProviderConfig(config, provider);
        if (!providerConfig) {
          return reply.code(400).send({ error: `OAuth not configured for ${provider}` });
        }

        const user = request.user!;
        const returnPath = request.query.returnPath ?? "/settings";
        const state = encrypt(
          JSON.stringify({ userId: user.id, provider, returnPath, ts: Date.now() }),
          encryptionKey,
        );

        const redirectUri = `${callbackBase}/api/git/callback/${provider}`;
        const params = new URLSearchParams({
          client_id: providerConfig.clientId,
          redirect_uri: redirectUri,
          state,
          ...(provider === "gitlab"
            ? { response_type: "code", scope: providerConfig.scopes }
            : { scope: providerConfig.scopes }),
        });

        return { url: `${providerConfig.authorizeUrl}?${params.toString()}` };
      },
    );
  },
  { name: "git-oauth-routes" },
);

/**
 * OAuth callback route — register at top level (no auth).
 * - GET /api/git/callback/:provider
 */
export const gitOAuthCallbackRoute = fp(
  async (server: FastifyInstance, opts: GitOAuthRoutesOptions) => {
    const { config, gitProviderService, encryptionKey } = opts;
    const callbackBase = config.BETTER_AUTH_URL.replace(/\/$/, "");

    server.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>(
      "/api/git/callback/:provider",
      async (request, reply) => {
        const provider = request.params.provider as ProviderType;
        const { code, state, error: oauthError } = request.query;

        if (oauthError) {
          return reply.redirect(`/settings?oauth=error&message=${encodeURIComponent(oauthError)}#git`);
        }

        if (!code || !state) {
          return reply.redirect("/settings?oauth=error&message=missing_params#git");
        }

        // Decrypt and validate state
        let stateData: { userId: string; provider: string; returnPath?: string; ts: number };
        try {
          stateData = JSON.parse(decrypt(state, encryptionKey));
        } catch {
          return reply.redirect("/settings?oauth=error&message=invalid_state#git");
        }

        const returnPath = stateData.returnPath ?? "/settings";

        // Check expiry (5 minutes)
        if (Date.now() - stateData.ts > 5 * 60 * 1000) {
          return reply.redirect(`${returnPath}?oauth=error&message=expired#git`);
        }

        if (stateData.provider !== provider) {
          return reply.redirect(`${returnPath}?oauth=error&message=provider_mismatch#git`);
        }

        const providerConfig = getProviderConfig(config, provider);
        if (!providerConfig) {
          return reply.redirect(`${returnPath}?oauth=error&message=not_configured#git`);
        }

        try {
          // Exchange code for access token
          const redirectUri = `${callbackBase}/api/git/callback/${provider}`;
          const token = await exchangeCodeForToken(provider, providerConfig, code, redirectUri);

          // Fetch user info
          const userInfo = await fetchUserInfo(provider, token);

          // Create git provider entry
          await gitProviderService.createFromOAuth({
            type: provider,
            token,
            userName: userInfo.username,
            userEmail: userInfo.email,
            userId: stateData.userId,
          });

          return reply.redirect(`${returnPath}?oauth=success#git`);
        } catch (err) {
          server.log.error({ err, provider }, "OAuth token exchange failed");
          const message = err instanceof Error ? err.message : "exchange_failed";
          return reply.redirect(`${returnPath}?oauth=error&message=${encodeURIComponent(message)}#git`);
        }
      },
    );
  },
  { name: "git-oauth-callback-route" },
);

// --- Token exchange ---

async function exchangeCodeForToken(
  provider: ProviderType,
  providerConfig: OAuthProviderConfig,
  code: string,
  redirectUri: string,
): Promise<string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  let body: string;

  if (provider === "bitbucket") {
    headers["Authorization"] = `Basic ${Buffer.from(`${providerConfig.clientId}:${providerConfig.clientSecret}`).toString("base64")}`;
    body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }).toString();
  } else {
    body = new URLSearchParams({
      client_id: providerConfig.clientId,
      client_secret: providerConfig.clientSecret,
      code,
      redirect_uri: redirectUri,
      ...(provider === "gitlab" ? { grant_type: "authorization_code" } : {}),
    }).toString();
  }

  const res = await fetch(providerConfig.tokenUrl, { method: "POST", headers, body });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const token = data.access_token as string | undefined;
  if (!token) {
    throw new Error(`No access_token in response: ${JSON.stringify(data)}`);
  }
  return token;
}

// --- User info fetching ---

interface UserInfo {
  username: string;
  email?: string;
}

async function fetchUserInfo(
  provider: ProviderType,
  token: string,
): Promise<UserInfo> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "Vonzio",
  };

  switch (provider) {
    case "github": {
      const res = await fetch("https://api.github.com/user", { headers });
      if (!res.ok) throw new Error(`GitHub user info failed (${res.status})`);
      const data = await res.json() as Record<string, unknown>;
      return {
        username: (data.login as string) ?? (data.name as string) ?? "unknown",
        email: (data.email as string) ?? undefined,
      };
    }
    case "gitlab": {
      const res = await fetch("https://gitlab.com/api/v4/user", { headers });
      if (!res.ok) {
        // read_user scope may not be granted — fall back gracefully
        return { username: "gitlab-user" };
      }
      const data = await res.json() as Record<string, unknown>;
      return {
        username: (data.username as string) ?? (data.name as string) ?? "unknown",
        email: (data.email as string) ?? undefined,
      };
    }
    case "bitbucket": {
      const res = await fetch("https://api.bitbucket.org/2.0/user", { headers });
      if (!res.ok) throw new Error(`Bitbucket user info failed (${res.status})`);
      const data = await res.json() as Record<string, unknown>;
      const username = (data.username as string) ?? (data.display_name as string) ?? "unknown";
      let email: string | undefined;
      try {
        const emailRes = await fetch("https://api.bitbucket.org/2.0/user/emails", { headers });
        if (emailRes.ok) {
          const emailData = await emailRes.json() as { values?: Array<{ email: string; is_primary: boolean }> };
          email = emailData.values?.find((e) => e.is_primary)?.email ?? emailData.values?.[0]?.email;
        }
      } catch { /* email fetch is best-effort */ }
      return { username, email };
    }
    default:
      return { username: "unknown" };
  }
}
