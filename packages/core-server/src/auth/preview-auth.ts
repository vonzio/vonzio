import { createHmac, timingSafeEqual } from "node:crypto";
import { fromNodeHeaders } from "better-auth/node";
import type { Auth } from "./better-auth.js";
import type { AuthUser } from "./user-auth.js";
import { isOwnerOrAdmin } from "./user-auth.js";
import type { SessionRegistry } from "../container/session-registry.js";

/** Cached session: maps session token → AuthUser */
interface CachedSession {
  user: AuthUser;
  ts: number;
}

const SESSION_CACHE_TTL = 60_000; // 60 seconds
const PREVIEW_TOKEN_TTL = 3600_000; // 1 hour

export interface PreviewAuthChecker {
  /**
   * Validate that the request has a valid session cookie and the user owns the container.
   * Returns the AuthUser if allowed, null otherwise.
   */
  checkSession(
    headers: Record<string, string | string[] | undefined>,
    fullContainerId: string,
  ): Promise<AuthUser | null>;

  /**
   * Validate a signed preview token (_pvt query param).
   * Returns true if the token is valid and not expired.
   */
  checkToken(token: string, fullContainerId: string): boolean;

  /**
   * Generate a signed preview token for a container + user.
   */
  signToken(fullContainerId: string, userId: string): string;

  /**
   * Check if the container's workspace has public_preview enabled.
   */
  isPublic(fullContainerId: string): boolean;
}

export function createPreviewAuthChecker(
  auth: Auth,
  sessionRegistry: SessionRegistry,
  secret: string,
): PreviewAuthChecker {
  const sessionCache = new Map<string, CachedSession>();

  // Periodically clean stale cache entries
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of sessionCache) {
      if (now - entry.ts > SESSION_CACHE_TTL) sessionCache.delete(key);
    }
  }, SESSION_CACHE_TTL);
  cleanupInterval.unref();

  async function getSessionUser(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthUser | null> {
    const cookieHeader = headers.cookie;
    const cookieStr = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    if (!cookieStr) return null;

    const cached = sessionCache.get(cookieStr);
    if (cached && Date.now() - cached.ts < SESSION_CACHE_TTL) {
      return cached.user;
    }

    try {
      const reqHeaders = fromNodeHeaders(headers);
      const session = await auth.api.getSession({ headers: reqHeaders });
      if (!session?.user) return null;

      const user: AuthUser = {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        role: (session.user as Record<string, unknown>).role as string ?? "user",
      };

      sessionCache.set(cookieStr, { user, ts: Date.now() });
      return user;
    } catch {
      return null;
    }
  }

  function hmac(data: string): string {
    return createHmac("sha256", secret).update(data).digest("hex");
  }

  return {
    async checkSession(headers, fullContainerId): Promise<AuthUser | null> {
      const user = await getSessionUser(headers);
      if (!user) return null;

      const workspace = sessionRegistry.getByContainer(fullContainerId);
      if (!workspace) return null;

      if (!isOwnerOrAdmin(user, workspace.user_id)) return null;

      return user;
    },

    checkToken(token: string, fullContainerId: string): boolean {
      // Token format: containerId:userId:expiresAt:signature
      const parts = token.split(":");
      if (parts.length !== 4) return false;

      const [tokenContainer, userId, expiresStr, sig] = parts;
      const expires = parseInt(expiresStr, 10);
      if (isNaN(expires) || Date.now() > expires) return false;

      // Verify container matches
      if (tokenContainer !== fullContainerId) return false;

      // Verify ownership
      const workspace = sessionRegistry.getByContainer(fullContainerId);
      if (!workspace) return false;
      if (workspace.user_id !== userId && userId !== "admin") return false;

      // Verify signature
      const payload = `${tokenContainer}:${userId}:${expiresStr}`;
      const expected = hmac(payload);
      try {
        return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
      } catch {
        return false;
      }
    },

    signToken(fullContainerId: string, userId: string): string {
      const expires = Date.now() + PREVIEW_TOKEN_TTL;
      const payload = `${fullContainerId}:${userId}:${expires}`;
      const sig = hmac(payload);
      return `${payload}:${sig}`;
    },

    isPublic(fullContainerId: string): boolean {
      const workspace = sessionRegistry.getByContainer(fullContainerId);
      return workspace?.public_preview === true;
    },
  };
}

/**
 * Shared Sodium / Carbon error-page shell used by every preview-side
 * static HTML response (no React, no token swap, no fetch — these pages
 * are served when the dashboard is unreachable through the proxy).
 *
 * Matches the dashboard's Carbon surface + Sodium accent, so an error in
 * the iframe doesn't yank the user into a different visual world.
 */
export function brandedErrorHtml(opts: {
  title: string;
  eyebrow: string;
  body: string;
  ctaLabel: string;
  ctaHref: string;
}): string {
  const { title, eyebrow, body, ctaLabel, ctaHref } = opts;
  // Token values inlined here — these pages must be self-contained with no
  // external CSS / font dependency, so any token change in the dashboard
  // needs to be mirrored here. Kept in sync with brand/tokens.css.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} · vonzio</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@500&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0A0E14;font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#E6E9EE;">
  <div style="text-align:center;max-width:480px;padding:40px 24px;">
    <svg viewBox="0 0 64 64" width="48" height="48" aria-hidden="true" style="display:block;margin:0 auto 28px;">
      <rect width="64" height="64" rx="14" fill="#0E1116" stroke="#1F2630" stroke-width="1"/>
      <path d="M18 22 L32 44 L46 22" fill="none" stroke="#FF5722" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="22" y="49" width="20" height="3.5" rx="1.75" fill="#FF5722"/>
    </svg>
    <div style="font-family:'DM Mono',ui-monospace,monospace;font-size:11px;font-weight:500;letter-spacing:0.18em;text-transform:uppercase;color:#FF5722;margin-bottom:14px;">// ${eyebrow}</div>
    <h1 style="margin:0 0 12px;font-size:24px;font-weight:600;letter-spacing:-0.01em;color:#E6E9EE;">${title}</h1>
    <p style="margin:0 0 32px;font-size:14.5px;line-height:1.6;color:#7A8290;">${body}</p>
    <a href="${ctaHref}" style="display:inline-flex;align-items:center;gap:8px;padding:11px 22px;background:#FF5722;color:#fff;text-decoration:none;border-radius:8px;font-size:13px;font-weight:600;font-family:'DM Mono',ui-monospace,monospace;letter-spacing:0.06em;text-transform:uppercase;transition:background 120ms cubic-bezier(.2,.7,.2,1);" onmouseover="this.style.background='#E64A1A'" onmouseout="this.style.background='#FF5722'">
      ${ctaLabel}
      <span aria-hidden="true">→</span>
    </a>
  </div>
</body>
</html>`;
}

export function unauthorizedHtml(dashboardUrl: string): string {
  return brandedErrorHtml({
    title: "Sign in required",
    eyebrow: "Auth",
    body: "You need to sign in to view this preview. Only the workspace owner can access it.",
    ctaLabel: "Go to dashboard",
    ctaHref: dashboardUrl,
  });
}
