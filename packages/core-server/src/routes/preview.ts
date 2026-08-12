import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { request as httpRequest } from "node:http";
import { basename, extname, posix as posixPath } from "node:path";
import type { ContainerManager } from "@vonzio/shared";
import type { SessionRegistry } from "../container/session-registry.js";
import type { Auth } from "../auth/better-auth.js";
import { createPreviewAuthChecker, unauthorizedHtml, brandedErrorHtml, previewCodeGateHtml, CODE_COOKIE_NAME, type PreviewAuthChecker } from "../auth/preview-auth.js";
import { ErrorCodes, errorResponse } from "../errors.js";
import { ensureContainerRunning } from "../container/ensure-running.js";

// Read the `vonzio_preview` cookie value. Same-origin cookie set on the
// preview subdomain after a successful _pvt exchange.
// Brute-force guard for share-code entry, keyed by container:port:ip. Low-entropy
// codes need this — without it the gate is trivially guessable at scale.
const CODE_MAX_ATTEMPTS = 10;
const CODE_WINDOW_MS = 5 * 60_000;
const codeAttempts = new Map<string, { count: number; resetAt: number }>();
function codeRateLimited(key: string): boolean {
  const e = codeAttempts.get(key);
  return !!e && Date.now() <= e.resetAt && e.count >= CODE_MAX_ATTEMPTS;
}
function recordCodeFailure(key: string): void {
  const now = Date.now();
  const e = codeAttempts.get(key);
  if (!e || now > e.resetAt) codeAttempts.set(key, { count: 1, resetAt: now + CODE_WINDOW_MS });
  else e.count++;
}
function clearCodeAttempts(key: string): void { codeAttempts.delete(key); }

function readCookie(cookieHeader: string | string[] | undefined, name: string): string | null {
  const raw = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) {
      try { return decodeURIComponent(rest.join("=")); }
      catch { return rest.join("="); }
    }
  }
  return null;
}

function readPreviewCookie(cookieHeader: string | string[] | undefined): string | null {
  return readCookie(cookieHeader, "vonzio_preview");
}

function notFoundHtml(dashboardUrl: string): string {
  return brandedErrorHtml({
    title: "Container not available",
    eyebrow: "Container",
    body: "This workspace container is no longer running. It may have been paused, destroyed, or never started.",
    ctaLabel: "Go to dashboard",
    ctaHref: dashboardUrl,
  });
}

function proxyErrorHtml(message: string, dashboardUrl: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return brandedErrorHtml({
    title: "Nothing's listening here yet",
    eyebrow: "Preview",
    body: `The app on this port isn't responding — it may still be starting up, or it stopped. Once it's running, refresh to load the preview.<br><br><span style="display:inline-block;font-family:'DM Mono',ui-monospace,monospace;font-size:12px;color:#7A8290;word-break:break-all;">${esc(message)}</span>`,
    ctaLabel: "Back to dashboard",
    ctaHref: dashboardUrl,
  });
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
  ".ts": "text/plain", ".tsx": "text/plain", ".jsx": "text/plain",
  ".json": "application/json", ".xml": "application/xml",
  ".py": "text/plain", ".rb": "text/plain", ".go": "text/plain",
  ".rs": "text/plain", ".java": "text/plain", ".php": "text/plain",
  ".c": "text/plain", ".cpp": "text/plain", ".h": "text/plain",
  ".sh": "text/plain", ".bash": "text/plain", ".zsh": "text/plain",
  ".md": "text/plain", ".txt": "text/plain", ".csv": "text/csv",
  ".yaml": "text/plain", ".yml": "text/plain", ".toml": "text/plain",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".pdf": "application/pdf", ".zip": "application/zip",
};

// The only directory the file-download endpoint is allowed to serve. The
// preview file endpoint (including the unauthenticated public_preview path)
// must never read arbitrary container paths like /etc/passwd or on-disk
// secrets — only workspace files.
const PREVIEW_FILE_ROOT = "/workspace";

/**
 * Confine a requested file path to PREVIEW_FILE_ROOT. Normalizes away `.`/`..`
 * segments and rejects anything that resolves outside the workspace root.
 * Returns the safe absolute path, or null if the path escapes confinement.
 */
export function confineToWorkspace(filePath: string): string | null {
  // Callers send BOTH absolute paths already under /workspace (the file viewer,
  // tool file_paths like /workspace/output/x.png) AND relative ones. Accept an
  // absolute path as-is; treat a relative one as rooted at /workspace. Either
  // way, normalize `.`/`..` and then confine: anything resolving outside
  // /workspace (traversal, or a foreign absolute path) is rejected. The earlier
  // "strip leading / then join" form double-prefixed absolute inputs
  // (/workspace/x → /workspace/workspace/x), breaking every file open.
  const resolved = posixPath.normalize(
    filePath.startsWith("/") ? filePath : posixPath.join(PREVIEW_FILE_ROOT, filePath),
  );
  if (resolved !== PREVIEW_FILE_ROOT && !resolved.startsWith(`${PREVIEW_FILE_ROOT}/`)) {
    return null;
  }
  return resolved;
}

export interface PreviewRoutesOptions {
  containerManager: ContainerManager;
  previewMode: "path" | "hostname";
  previewDomain?: string; // e.g. "vonzio.localhost"
  auth: Auth;
  sessionRegistry: SessionRegistry;
  dashboardUrl: string;
  secret: string;
  encryptionKey: string;
}

export const previewRoutes: FastifyPluginAsync<PreviewRoutesOptions> = async (server, opts) => {
  const { containerManager, previewMode, previewDomain, auth, sessionRegistry, dashboardUrl, secret, encryptionKey } = opts;
  const authChecker = createPreviewAuthChecker(auth, sessionRegistry, secret, encryptionKey);

  // Cache: short container ID → { fullId, ip }
  const ipCache = new Map<string, { fullId: string; ip: string; ts: number }>();
  const CACHE_TTL = 30_000; // 30 seconds

  async function resolveTarget(shortId: string, port: number): Promise<{ fullId: string; ip: string; port: number } | null> {
    // Check cache. The running-state check must ALSO run on cache hits:
    // preview traffic doesn't bump session activity, so the idle sweep can
    // pause the container while the cache entry is still fresh — a proxied
    // request to a paused container hangs (frozen processes never accept).
    const cached = ipCache.get(shortId);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      await ensureContainerRunning(containerManager, cached.fullId, sessionRegistry);
      return { fullId: cached.fullId, ip: cached.ip, port };
    }

    // Resolve short ID → full ID
    const fullId = await containerManager.resolveContainerId(shortId);
    if (!fullId) return null;

    // Same resume-if-paused on the cold path (issue #333).
    await ensureContainerRunning(containerManager, fullId, sessionRegistry);

    // Get container IP
    const ip = await containerManager.getContainerIp(fullId);
    if (!ip) return null;

    // Cache it
    ipCache.set(shortId, { fullId, ip, ts: Date.now() });
    return { fullId, ip, port };
  }

  /** Check auth via session cookie, token, or public_preview flag. */
  async function checkAuth(request: FastifyRequest, reply: FastifyReply, fullContainerId: string, port?: number): Promise<boolean> {
    // Public previews skip auth (per-port, or the legacy container-wide master)
    if (authChecker.isPublic(fullContainerId, port)) return true;

    // Try session cookie first
    const user = await authChecker.checkSession(request.headers, fullContainerId);
    if (user) return true;

    // Try _pvt token (used by hostname-based redirect flow)
    const query = request.query as Record<string, string>;
    if (query?._pvt && authChecker.checkToken(query._pvt, fullContainerId)) return true;

    // Code-protected port: a shared viewer who's entered the code.
    if (port !== undefined && authChecker.portMode(fullContainerId, port) === "code") {
      const codeCookie = readCookie(request.headers.cookie, CODE_COOKIE_NAME);
      if (codeCookie && authChecker.checkCodeToken(codeCookie, fullContainerId, port)) return true;
      // Signed token from the unlock redirect — set the cookie, drop the param.
      if (query?.__vzc && authChecker.checkCodeToken(query.__vzc, fullContainerId, port)) {
        setCodeCookieRedirect(request, reply, query.__vzc);
        return false;
      }
      // Raw code in a convenience share link — verify, mint, set cookie, clean.
      // Rate-limited + failures recorded, same as the hostname branch and the
      // unlock endpoint, so this path can't be used to brute-force the code.
      const rlKey = `${fullContainerId}:${port}:${request.ip}`;
      if (query?.__vzc_code && !codeRateLimited(rlKey) && authChecker.checkCode(fullContainerId, port, query.__vzc_code)) {
        clearCodeAttempts(rlKey);
        const token = authChecker.signCodeToken(fullContainerId, port);
        if (token) { setCodeCookieRedirect(request, reply, token); return false; }
      }
      // A present-but-wrong inline code counts against the brute-force budget.
      if (query?.__vzc_code) recordCodeFailure(rlKey);
      const accept = (request.headers.accept ?? "") as string;
      if (accept.includes("text/html")) {
        reply.code(401).header("Content-Type", "text/html").send(
          previewCodeGateHtml({ action: "/api/preview-unlock", container: fullContainerId, port: String(port), returnUrl: request.url }),
        );
      } else {
        reply.code(401).header("Content-Type", "text/plain").send("preview code required");
      }
      return false;
    }

    reply.code(403).header("Content-Type", "text/html").send(unauthorizedHtml(dashboardUrl));
    return false;
  }

  // Strip the code params, set the unlock cookie, and bounce to the clean URL.
  function setCodeCookieRedirect(request: FastifyRequest, reply: FastifyReply, token: string): void {
    const u = new URL(request.url, "http://preview.local");
    u.searchParams.delete("__vzc");
    u.searchParams.delete("__vzc_code");
    const clean = u.pathname + (u.search || "");
    reply.header("set-cookie", `${CODE_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${7 * 24 * 3600}; HttpOnly; SameSite=Lax`);
    reply.redirect(clean);
  }

  // Only allow the unlock redirect to bounce back to our own preview surface —
  // never an arbitrary host (which would leak a freshly-minted access token).
  function isSafeReturn(returnUrl: string): boolean {
    if (returnUrl.startsWith("/preview/")) return true;
    try {
      const host = new URL(returnUrl).host;
      return !!previewDomain && (host === previewDomain || host.endsWith(`.${previewDomain}`));
    } catch { return false; }
  }

  // --- Code unlock: verify a share code, redirect back with a signed token ---
  server.get("/api/preview-unlock", async (request, reply) => {
    const q = request.query as Record<string, string>;
    const { container, port, code } = q;
    const returnUrl = q.return;
    if (!container || !port || !returnUrl || !isSafeReturn(returnUrl)) {
      return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "Invalid unlock request"));
    }
    const fullId = await containerManager.resolveContainerId(container);
    const rlKey = `${fullId ?? container}:${port}:${request.ip}`;
    if (codeRateLimited(rlKey)) {
      return reply.code(429).header("Content-Type", "text/plain").send("Too many attempts — wait a few minutes and try again.");
    }
    if (!fullId || !authChecker.checkCode(fullId, port, code ?? "")) {
      recordCodeFailure(rlKey);
      return reply.code(401).header("Content-Type", "text/html").send(
        previewCodeGateHtml({ action: "/api/preview-unlock", container, port, returnUrl, error: true }),
      );
    }
    clearCodeAttempts(rlKey);
    const token = authChecker.signCodeToken(fullId, port);
    if (!token) return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "Port is not code-protected"));
    const sep = returnUrl.includes("?") ? "&" : "?";
    return reply.redirect(`${returnUrl}${sep}__vzc=${encodeURIComponent(token)}`);
  });

  // --- Preview auth token endpoint (main domain — session cookie is available) ---
  server.get("/api/preview-auth", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const returnUrl = query?.return;
    const containerId = query?.container;

    if (!returnUrl || !containerId) {
      return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "Missing return URL or container ID"));
    }

    // Validate session cookie (this runs on the main domain, so cookie is present)
    const user = await authChecker.checkSession(request.headers, containerId);
    if (!user) {
      return reply.code(403).header("Content-Type", "text/html").send(unauthorizedHtml(dashboardUrl));
    }

    // Generate signed token and redirect back
    const token = authChecker.signToken(containerId, user.id);
    const separator = returnUrl.includes("?") ? "&" : "?";
    const redirectUrl = `${returnUrl}${separator}_pvt=${encodeURIComponent(token)}`;
    return reply.redirect(redirectUrl);
  });

  // --- Path-based proxy: /preview/:containerId/:port/* ---
  server.all("/preview/:containerId/:port/*", async (request, reply) => {
    const { containerId, port } = request.params as { containerId: string; port: string };
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "Invalid port"));
    }

    const target = await resolveTarget(containerId, portNum);
    if (!target) {
      return reply.code(404).header("Content-Type", "text/html").send(notFoundHtml(dashboardUrl));
    }

    if (!(await checkAuth(request, reply, target.fullId, portNum))) return;

    // Build the proxied path — strip /preview/:containerId/:port prefix
    const prefix = `/preview/${containerId}/${port}`;
    let targetPath = request.url.slice(prefix.length) || "/";

    return proxyRequest(request, reply, target.ip, target.port, targetPath);
  });

  // Also handle the exact prefix without trailing path
  server.all("/preview/:containerId/:port", async (request, reply) => {
    const { containerId, port } = request.params as { containerId: string; port: string };
    const portNum = parseInt(port, 10);
    if (isNaN(portNum)) return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "Invalid port"));

    const target = await resolveTarget(containerId, portNum);
    if (!target) return reply.code(404).header("Content-Type", "text/html").send(notFoundHtml(dashboardUrl));

    if (!(await checkAuth(request, reply, target.fullId, portNum))) return;

    return proxyRequest(request, reply, target.ip, target.port, "/");
  });

  // --- File download: /preview/:containerId/files/* ---
  server.get("/preview/:containerId/files/*", async (request, reply) => {
    const { containerId } = request.params as { containerId: string };
    const prefix = `/preview/${containerId}/files`;
    const filePath = decodeURIComponent(request.url.split("?")[0].slice(prefix.length));
    if (!filePath || filePath === "/") {
      return reply.code(400).send(errorResponse(ErrorCodes.BAD_REQUEST, "File path required"));
    }

    const fullId = await containerManager.resolveContainerId(containerId);
    if (!fullId) {
      return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Container not found"));
    }

    if (!(await checkAuth(request, reply, fullId))) return;

    // Confine the served path to /workspace for BOTH the authenticated owner
    // and the unauthenticated public_preview visitor — reject `..` traversal
    // and absolute paths that escape the workspace root. Without this, a
    // public preview lets anyone download arbitrary container files.
    const safePath = confineToWorkspace(filePath);
    if (!safePath) {
      return reply.code(403).send(errorResponse(ErrorCodes.FORBIDDEN, "File path outside workspace"));
    }

    try {
      // readFile execs into the container — resume it if idle-paused (#333).
      await ensureContainerRunning(containerManager, fullId, sessionRegistry);
      const content = await containerManager.readFile(fullId, safePath);
      const name = basename(safePath);
      const ext = extname(safePath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

      reply
        .header("Content-Type", contentType)
        .header("Content-Disposition", `attachment; filename="${name}"`)
        // Workspace files change in place (an agent can overwrite the same path),
        // so never serve a cached copy — otherwise the file preview shows a stale
        // image after an edit until the URL changes. See FilePreviewModal.
        .header("Cache-Control", "no-store")
        .header("Content-Length", content.length);
      return reply.send(content);
    } catch {
      return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "File not found"));
    }
  });

  // Hostname-based proxy is registered at the top level via setupHostnamePreviewProxy()

  function proxyRequest(
    request: FastifyRequest,
    reply: FastifyReply,
    targetIp: string,
    targetPort: number,
    targetPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proxyReq = httpRequest(
        {
          hostname: targetIp,
          port: targetPort,
          path: targetPath,
          method: request.method as string,
          headers: {
            ...request.headers,
            host: `${targetIp}:${targetPort}`,
          },
        },
        (proxyRes) => {
          reply.raw.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(reply.raw);
          proxyRes.on("end", resolve);
        },
      );

      proxyReq.on("error", (err) => {
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(502, { "content-type": "text/html; charset=utf-8" });
          reply.raw.end(proxyErrorHtml(err.message, dashboardUrl));
        }
        resolve();
      });

      // Pipe request body
      if (request.body) {
        const body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
        proxyReq.write(body);
        proxyReq.end();
      } else {
        request.raw.pipe(proxyReq);
      }
    });
  }
};

/**
 * Register hostname-based preview proxy as a global Fastify hook.
 * Must be called on the top-level server (not inside a plugin) so it runs before routing.
 *
 * Auth flow for hostname-based previews (subdomains can't see the main domain's session cookie):
 * 1. Check for a signed _pvt token in the query string
 * 2. If no token, redirect to /api/preview-auth on the main domain (which CAN read the session cookie)
 * 3. That endpoint validates ownership and redirects back with a signed token
 */
export function setupHostnamePreviewProxy(
  server: FastifyInstance,
  containerManager: ContainerManager,
  previewDomain: string,
  auth: Auth,
  sessionRegistry: SessionRegistry,
  dashboardUrl: string,
  secret: string,
  encryptionKey: string,
): void {
  const authChecker = createPreviewAuthChecker(auth, sessionRegistry, secret, encryptionKey);
  const ipCache = new Map<string, { fullId: string; ip: string; ts: number }>();
  const CACHE_TTL = 30_000;

  async function resolveTarget(shortId: string, port: number): Promise<{ fullId: string; ip: string; port: number } | null> {
    const cached = ipCache.get(shortId);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      // Must also run on cache hits — see resolveTarget in previewRoutes.
      await ensureContainerRunning(containerManager, cached.fullId, sessionRegistry);
      return { fullId: cached.fullId, ip: cached.ip, port };
    }
    const fullId = await containerManager.resolveContainerId(shortId);
    if (!fullId) return null;
    await ensureContainerRunning(containerManager, fullId, sessionRegistry); // idle-paused → resume (issue #333)
    const ip = await containerManager.getContainerIp(fullId);
    if (!ip) return null;
    ipCache.set(shortId, { fullId, ip, ts: Date.now() });
    return { fullId, ip, port };
  }

  server.addHook("onRequest", async (request, reply) => {
    const host = request.hostname;
    if (!host || !host.endsWith(`.${previewDomain}`)) return;
    // Don't intercept the main domain itself (e.g. vonzio.localhost)
    const subdomain = host.slice(0, -(`.${previewDomain}`.length));
    if (!subdomain || subdomain === "traefik") return;

    const dashIdx = subdomain.lastIndexOf("-");
    if (dashIdx === -1) return;

    const shortId = subdomain.slice(0, dashIdx);
    const port = parseInt(subdomain.slice(dashIdx + 1), 10);
    if (!shortId || isNaN(port)) return;

    const target = await resolveTarget(shortId, port);
    if (!target) {
      reply.code(404).header("Content-Type", "text/html").send(notFoundHtml(dashboardUrl));
      return;
    }

    // Public previews skip auth entirely (per-port, or legacy container-wide)
    if (authChecker.isPublic(target.fullId, target.port)) {
      await proxyToContainer(request, reply, target.ip, target.port, request.url || "/");
      return;
    }

    // Code-protected port: shared-viewer flow (cookie / minted token / raw code
    // share link / gate). Owners still fall through to the session/_pvt flow.
    if (authChecker.portMode(target.fullId, target.port) === "code"
        && !(await authChecker.checkSession(request.headers, target.fullId))) {
      const q2 = request.query as Record<string, string>;
      const codeCookie = readCookie(request.headers.cookie, CODE_COOKIE_NAME);
      if (codeCookie && authChecker.checkCodeToken(codeCookie, target.fullId, target.port)) {
        await proxyToContainer(request, reply, target.ip, target.port, request.url || "/");
        return;
      }
      // Signed token from the unlock redirect → same-origin cookie, clean URL.
      if (q2?.__vzc && authChecker.checkCodeToken(q2.__vzc, target.fullId, target.port)) {
        const url = new URL(request.url, `http://${host}`);
        url.searchParams.delete("__vzc");
        const cleanPath = url.pathname + (url.search || "");
        await proxyToContainer(request, reply, target.ip, target.port, cleanPath, {
          "set-cookie": `${CODE_COOKIE_NAME}=${encodeURIComponent(q2.__vzc)}; Path=/; Max-Age=${7 * 24 * 3600}; HttpOnly; SameSite=Lax`,
        });
        return;
      }
      // Convenience share link carrying the raw code → mint, set cookie, clean.
      const rlKey = `${target.fullId}:${target.port}:${request.ip}`;
      if (q2?.__vzc_code && !codeRateLimited(rlKey) && authChecker.checkCode(target.fullId, target.port, q2.__vzc_code)) {
        clearCodeAttempts(rlKey);
        const token = authChecker.signCodeToken(target.fullId, target.port);
        if (token) {
          const url = new URL(request.url, `http://${host}`);
          url.searchParams.delete("__vzc_code");
          const cleanPath = url.pathname + (url.search || "");
          reply.header("set-cookie", `${CODE_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${7 * 24 * 3600}; HttpOnly; SameSite=Lax`);
          reply.redirect(cleanPath);
          return;
        }
      }
      // A present-but-wrong inline code counts against the brute-force budget.
      if (q2?.__vzc_code) recordCodeFailure(rlKey);
      const accept = (request.headers.accept ?? "") as string;
      if (accept.includes("text/html")) {
        const protocol = dashboardUrl.startsWith("https") ? "https" : "http";
        const returnUrl = `${protocol}://${host}${request.url}`;
        reply.code(401).header("Content-Type", "text/html").send(
          previewCodeGateHtml({ action: `${dashboardUrl}/api/preview-unlock`, container: target.fullId, port: String(target.port), returnUrl }),
        );
      } else {
        reply.code(401).header("Content-Type", "text/plain").send("preview code required");
      }
      return;
    }

    // Auth: check signed token in query string
    const query = request.query as Record<string, string>;
    const queryToken = query?._pvt;
    // Same-origin cookie set on the preview subdomain after a successful
    // _pvt exchange. Subsequent asset / fetch / AJAX requests on the same
    // host carry this without needing to bounce through /api/preview-auth.
    const cookieToken = readPreviewCookie(request.headers.cookie);

    if (queryToken && authChecker.checkToken(queryToken, target.fullId)) {
      // Strip _pvt from the proxied path so the upstream sees clean URLs.
      const url = new URL(request.url, `http://${host}`);
      url.searchParams.delete("_pvt");
      const cleanPath = url.pathname + (url.search || "");

      // Hand the token off to the subdomain via a same-origin cookie so the
      // browser can authenticate follow-up requests on its own. Passed via
      // extraHeaders because writeHead inside proxyToContainer replaces all
      // headers — reply.header() would be clobbered.
      await proxyToContainer(request, reply, target.ip, target.port, cleanPath, {
        "set-cookie": `vonzio_preview=${encodeURIComponent(queryToken)}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax`,
      });
      return;
    }

    if (cookieToken && authChecker.checkToken(cookieToken, target.fullId)) {
      await proxyToContainer(request, reply, target.ip, target.port, request.url || "/");
      return;
    }

    // Try session cookie (works if crossSubDomainCookies is enabled, e.g. production)
    const user = await authChecker.checkSession(request.headers, target.fullId);
    if (user) {
      await proxyToContainer(request, reply, target.ip, target.port, request.url || "/");
      return;
    }

    // No auth — redirect to main domain to mint a token. Browsers won't
    // follow this redirect as a subresource (Lax cookies + cross-site), so
    // for non-document requests we 401 instead of 30x to avoid wedged
    // assets that show a redirected HTML body.
    const accept = (request.headers.accept ?? "") as string;
    const isDocumentRequest = accept.includes("text/html");
    if (!isDocumentRequest) {
      reply.code(401).header("Content-Type", "text/plain").send("preview token expired");
      return;
    }

    const protocol = dashboardUrl.startsWith("https") ? "https" : "http";
    const returnUrl = `${protocol}://${host}${request.url}`;
    const authUrl = `${dashboardUrl}/api/preview-auth?return=${encodeURIComponent(returnUrl)}&container=${encodeURIComponent(target.fullId)}`;
    reply.redirect(authUrl);
  });

  function proxyToContainer(
    request: FastifyRequest,
    reply: FastifyReply,
    ip: string,
    port: number,
    path: string,
    extraHeaders?: Record<string, string>,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const proxyReq = httpRequest(
        {
          hostname: ip,
          port,
          path,
          method: request.method as string,
          headers: { ...request.headers, host: `${ip}:${port}` },
        },
        (proxyRes) => {
          // Merge any extra headers (e.g. our Set-Cookie handoff) into the
          // upstream response headers. Plain reply.header() before this call
          // would be clobbered by writeHead, which replaces all headers.
          const merged: Record<string, string | string[] | undefined> = { ...proxyRes.headers };
          if (extraHeaders) {
            for (const [k, v] of Object.entries(extraHeaders)) {
              const existing = merged[k];
              if (k.toLowerCase() === "set-cookie") {
                // Set-Cookie may already be present from upstream — keep both.
                merged[k] = Array.isArray(existing) ? [...existing, v]
                  : existing ? [existing as string, v]
                  : v;
              } else {
                merged[k] = v;
              }
            }
          }
          reply.raw.writeHead(proxyRes.statusCode ?? 502, merged);
          proxyRes.pipe(reply.raw);
          proxyRes.on("end", resolve);
        },
      );
      proxyReq.on("error", (err) => {
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(502, { "content-type": "text/html; charset=utf-8" });
          reply.raw.end(proxyErrorHtml(err.message, dashboardUrl));
        }
        resolve();
      });
      request.raw.pipe(proxyReq);
    });
  }
}

/**
 * Set up WebSocket proxying for preview URLs.
 * Must be called on the raw http.Server (not Fastify) to intercept the 'upgrade' event.
 */
export function setupPreviewWebSocketProxy(
  httpServer: import("node:http").Server,
  containerManager: ContainerManager,
  previewMode: "path" | "hostname",
  previewDomain: string | undefined,
  auth: Auth,
  sessionRegistry: SessionRegistry,
  secret: string,
  encryptionKey: string,
): void {
  const authChecker = createPreviewAuthChecker(auth, sessionRegistry, secret, encryptionKey);
  const ipCache = new Map<string, { fullId: string; ip: string; ts: number }>();
  const CACHE_TTL = 30_000;

  async function resolve(shortId: string): Promise<{ fullId: string; ip: string } | null> {
    const cached = ipCache.get(shortId);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      // Must also run on cache hits — see resolveTarget in previewRoutes.
      await ensureContainerRunning(containerManager, cached.fullId, sessionRegistry);
      return { fullId: cached.fullId, ip: cached.ip };
    }

    const fullId = await containerManager.resolveContainerId(shortId);
    if (!fullId) return null;
    await ensureContainerRunning(containerManager, fullId, sessionRegistry); // idle-paused → resume (issue #333)
    const ip = await containerManager.getContainerIp(fullId);
    if (!ip) return null;
    ipCache.set(shortId, { fullId, ip, ts: Date.now() });
    return { fullId, ip };
  }

  function parsePreviewUrl(url: string, host?: string): { shortId: string; port: number; path: string; token?: string } | null {
    // Path-based: /preview/<shortId>/<port>/...
    const pathMatch = url.match(/^\/preview\/([a-f0-9]+)\/(\d+)(\/.*)?$/);
    if (pathMatch) {
      return { shortId: pathMatch[1], port: parseInt(pathMatch[2], 10), path: pathMatch[3] || "/" };
    }

    // Hostname-based: <shortId>-<port>.vonzio.localhost
    if (previewMode === "hostname" && previewDomain && host?.endsWith(`.${previewDomain}`)) {
      const subdomain = host.slice(0, -(`.${previewDomain}`.length));
      const dashIdx = subdomain.lastIndexOf("-");
      if (dashIdx !== -1) {
        const shortId = subdomain.slice(0, dashIdx);
        const port = parseInt(subdomain.slice(dashIdx + 1), 10);
        if (shortId && !isNaN(port)) {
          // Extract _pvt token from query string
          const urlObj = new URL(url, `http://${host}`);
          const token = urlObj.searchParams.get("_pvt") ?? undefined;
          return { shortId, port, path: url, token };
        }
      }
    }

    return null;
  }

  httpServer.on("upgrade", async (req, socket, head) => {
    const parsed = parsePreviewUrl(req.url ?? "", req.headers.host);
    if (!parsed) return; // Not a preview request — let Fastify/ws handle it

    const resolved = await resolve(parsed.shortId);
    if (!resolved) {
      socket.destroy();
      return;
    }

    // Auth: public (per-port) skips auth; else owner session / _pvt token; else a
    // code-mode viewer carrying the unlock cookie (so WS apps — Vite HMR, live
    // reload — keep working behind a shared code once the HTTP gate is passed).
    if (!authChecker.isPublic(resolved.fullId, parsed.port)) {
      const headers = req.headers as Record<string, string | string[] | undefined>;
      const user = await authChecker.checkSession(headers, resolved.fullId);
      if (!user) {
        const codeCookie = readCookie(req.headers.cookie, CODE_COOKIE_NAME);
        const codeOk = authChecker.portMode(resolved.fullId, parsed.port) === "code"
          && !!codeCookie && authChecker.checkCodeToken(codeCookie, resolved.fullId, parsed.port);
        if (!codeOk && (!parsed.token || !authChecker.checkToken(parsed.token, resolved.fullId))) {
          socket.destroy();
          return;
        }
      }
    }

    // Proxy WebSocket upgrade to the container
    const proxyReq = httpRequest({
      hostname: resolved.ip,
      port: parsed.port,
      path: parsed.path,
      method: "GET",
      headers: {
        ...req.headers,
        host: `${resolved.ip}:${parsed.port}`,
      },
    });

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
        Object.entries(proxyRes.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n",
      );
      if (proxyHead.length) socket.write(proxyHead);

      proxySocket.pipe(socket);
      socket.pipe(proxySocket);

      proxySocket.on("error", () => socket.destroy());
      socket.on("error", () => proxySocket.destroy());
    });

    proxyReq.on("error", () => socket.destroy());
    proxyReq.end();
  });
}
