import { createSign } from "node:crypto";

/**
 * Minimal GitHub App client — no SDK dependency.
 *
 * A GitHub App authenticates in two layers:
 *   1. An **app JWT** (RS256, signed with the app's private key) proves "I am
 *      this app". Short-lived (max 10 min) and used only to manage installations.
 *   2. An **installation access token**, minted from the JWT for a specific
 *      installation id, is what actually reads/writes repos. It expires after
 *      one hour, so we cache it and re-mint shortly before expiry.
 *
 * This is the piece that lets vonzio sidestep "OAuth App access restrictions":
 * org owners approve the *installation* (with a repo allow-list) during setup,
 * and the resulting tokens are scoped to exactly those repos.
 */

export interface GithubInstallation {
  id: number;
  /** Login of the account (user or org) the app is installed on. */
  accountLogin: string;
  /** "User" | "Organization". */
  accountType: string;
}

interface CachedToken {
  token: string;
  /** Epoch ms at which the cached token should be considered expired. */
  expiresAtMs: number;
}

const GITHUB_API = "https://api.github.com";
/** Re-mint this many ms before the real expiry to avoid handing out a token
 * that dies mid-request. */
const EXPIRY_SKEW_MS = 60_000;

export interface GithubAppConfig {
  appId?: string;
  privateKey?: string;
  slug?: string;
  /** The App's user-OAuth client id/secret — required to verify, at install
   *  callback time, that the user actually owns the installation they sent us. */
  clientId?: string;
  clientSecret?: string;
}

export class GithubAppService {
  private appId?: string;
  private privateKey?: string;
  readonly slug?: string;
  private clientId?: string;
  private clientSecret?: string;
  private tokenCache = new Map<string, CachedToken>();

  constructor(cfg: GithubAppConfig) {
    this.appId = cfg.appId;
    // PEM keys pasted into a single-line env var carry literal "\n" escapes;
    // normalize them back to real newlines so the crypto layer accepts the key.
    this.privateKey = cfg.privateKey ? cfg.privateKey.replace(/\\n/g, "\n") : undefined;
    this.slug = cfg.slug;
    this.clientId = cfg.clientId;
    this.clientSecret = cfg.clientSecret;
  }

  /** True only when the app is fully configured (id + private key). */
  isConfigured(): boolean {
    return !!(this.appId && this.privateKey);
  }

  /**
   * True when we can offer AND securely complete an install: we need the slug
   * (to build the URL) and the OAuth client id/secret (to verify, at callback
   * time, that the user owns the installation). Without the client creds we
   * can't verify ownership, so we don't offer the install at all — default-deny,
   * rather than create an unverified, hijackable binding.
   */
  canInstall(): boolean {
    return this.isConfigured() && !!this.slug && !!this.clientId && !!this.clientSecret;
  }

  /**
   * Exchange the user-OAuth `code` GitHub returns alongside `installation_id`
   * (requires "Request user authorization (OAuth) during installation" on the
   * App) for a user access token. That token represents the human who did the
   * install — used only to confirm installation ownership, never stored.
   */
  async exchangeUserCode(code: string): Promise<string> {
    if (!this.clientId || !this.clientSecret) {
      throw new Error("GitHub App OAuth client not configured (GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET)");
    }
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Vonzio" },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, code }),
    });
    if (!res.ok) {
      throw new Error(`GitHub user-OAuth exchange failed (${res.status})`);
    }
    const data = (await res.json()) as { access_token?: string; error?: string };
    if (!data.access_token) {
      throw new Error(`GitHub user-OAuth exchange returned no token${data.error ? ` (${data.error})` : ""}`);
    }
    return data.access_token;
  }

  /**
   * Confirm the authenticated user can actually access `installationId` — i.e.
   * the install belongs to them (or an org they administer). This is the gate
   * that stops a user binding someone else's (enumerable) installation id to
   * their own account. Paginates GET /user/installations.
   */
  async userHasInstallation(userToken: string, installationId: string): Promise<boolean> {
    const wanted = String(installationId);
    for (let page = 1; page <= 10; page++) {
      const res = await fetch(`${GITHUB_API}/user/installations?per_page=100&page=${page}`, {
        headers: {
          Authorization: `Bearer ${userToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Vonzio",
        },
      });
      if (!res.ok) throw new Error(`Failed to list user installations (${res.status})`);
      const data = (await res.json()) as { total_count: number; installations: Array<{ id: number }> };
      if (data.installations.some((i) => String(i.id) === wanted)) return true;
      if (page * 100 >= data.total_count) break;
    }
    return false;
  }

  /** github.com/apps/<slug>/installations/new — opens the install/repo-picker UI. */
  installUrl(state: string): string {
    if (!this.slug) throw new Error("GITHUB_APP_SLUG not configured");
    return `https://github.com/apps/${this.slug}/installations/new?state=${encodeURIComponent(state)}`;
  }

  /**
   * Mint (or return a cached) installation access token for `installationId`.
   * Tokens are cached until ~1 minute before GitHub's stated expiry.
   */
  async getInstallationToken(installationId: string): Promise<string> {
    const cached = this.tokenCache.get(installationId);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.token;
    }

    const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: this.appAuthHeaders(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Failed to mint installation token (${res.status}): ${body}`);
    }
    const data = (await res.json()) as { token: string; expires_at: string };
    const expiresAtMs = new Date(data.expires_at).getTime() - EXPIRY_SKEW_MS;
    this.tokenCache.set(installationId, { token: data.token, expiresAtMs });
    return data.token;
  }

  /** Fetch installation metadata (account login/type) — used at connect time. */
  async getInstallation(installationId: string): Promise<GithubInstallation> {
    const res = await fetch(`${GITHUB_API}/app/installations/${installationId}`, {
      headers: this.appAuthHeaders(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Failed to fetch installation (${res.status}): ${body}`);
    }
    const data = (await res.json()) as {
      id: number;
      account: { login: string; type: string } | null;
    };
    return {
      id: data.id,
      accountLogin: data.account?.login ?? "unknown",
      accountType: data.account?.type ?? "User",
    };
  }

  /** Drop any cached token for an installation (e.g. on disconnect). */
  invalidate(installationId: string): void {
    this.tokenCache.delete(installationId);
  }

  private appAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.appJwt()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Vonzio",
    };
  }

  /**
   * Build a short-lived (9 min) app JWT signed with the app private key.
   * `iat` is backdated 60s to tolerate minor clock skew between us and GitHub.
   */
  private appJwt(): string {
    if (!this.appId || !this.privateKey) {
      throw new Error("GitHub App not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)");
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const payload = b64url(
      Buffer.from(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: this.appId })),
    );
    const signingInput = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256").update(signingInput).sign(this.privateKey);
    return `${signingInput}.${b64url(signature)}`;
  }
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
