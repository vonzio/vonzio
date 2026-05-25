import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { request as httpRequest } from "node:http";
import { basename, extname } from "node:path";
import type { ContainerManager } from "@vonzio/shared";
import type { SessionRegistry } from "../container/session-registry.js";
import type { Auth } from "../auth/better-auth.js";
import { createPreviewAuthChecker, unauthorizedHtml, brandedErrorHtml, type PreviewAuthChecker } from "../auth/preview-auth.js";
import { ErrorCodes, errorResponse } from "../errors.js";

// Read the `vonzio_preview` cookie value. Same-origin cookie set on the
// preview subdomain after a successful _pvt exchange.
function readPreviewCookie(cookieHeader: string | string[] | undefined): string | null {
  const raw = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "vonzio_preview") {
      try { return decodeURIComponent(rest.join("=")); }
      catch { return rest.join("="); }
    }
  }
  return null;
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

export interface PreviewRoutesOptions {
  containerManager: ContainerManager;
  previewMode: "path" | "hostname";
  previewDomain?: string; // e.g. "vonzio.localhost"
  auth: Auth;
  sessionRegistry: SessionRegistry;
  dashboardUrl: string;
  secret: string;
}

export const previewRoutes: FastifyPluginAsync<PreviewRoutesOptions> = async (server, opts) => {
  const { containerManager, previewMode, previewDomain, auth, sessionRegistry, dashboardUrl, secret } = opts;
  const authChecker = createPreviewAuthChecker(auth, sessionRegistry, secret);

  // Cache: short container ID → { fullId, ip }
  const ipCache = new Map<string, { fullId: string; ip: string; ts: number }>();
  const CACHE_TTL = 30_000; // 30 seconds

  async function resolveTarget(shortId: string, port: number): Promise<{ fullId: string; ip: string; port: number } | null> {
    // Check cache
    const cached = ipCache.get(shortId);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      return { fullId: cached.fullId, ip: cached.ip, port };
    }

    // Resolve short ID → full ID
    const fullId = await containerManager.resolveContainerId(shortId);
    if (!fullId) return null;

    // Get container IP
    const ip = await containerManager.getContainerIp(fullId);
    if (!ip) return null;

    // Cache it
    ipCache.set(shortId, { fullId, ip, ts: Date.now() });
    return { fullId, ip, port };
  }

  /** Check auth via session cookie, token, or public_preview flag. */
  async function checkAuth(request: FastifyRequest, reply: FastifyReply, fullContainerId: string): Promise<boolean> {
    // Public previews skip auth
    if (authChecker.isPublic(fullContainerId)) return true;

    // Try session cookie first
    const user = await authChecker.checkSession(request.headers, fullContainerId);
    if (user) return true;

    // Try _pvt token (used by hostname-based redirect flow)
    const query = request.query as Record<string, string>;
    if (query?._pvt && authChecker.checkToken(query._pvt, fullContainerId)) return true;

    reply.code(403).header("Content-Type", "text/html").send(unauthorizedHtml(dashboardUrl));
    return false;
  }

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

    if (!(await checkAuth(request, reply, target.fullId))) return;

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

    if (!(await checkAuth(request, reply, target.fullId))) return;

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

    try {
      const content = await containerManager.readFile(fullId, filePath);
      const name = basename(filePath);
      const ext = extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

      reply
        .header("Content-Type", contentType)
        .header("Content-Disposition", `attachment; filename="${name}"`)
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
          reply.raw.writeHead(502);
          reply.raw.end(`Proxy error: ${err.message}`);
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
): void {
  const authChecker = createPreviewAuthChecker(auth, sessionRegistry, secret);
  const ipCache = new Map<string, { fullId: string; ip: string; ts: number }>();
  const CACHE_TTL = 30_000;

  async function resolveTarget(shortId: string, port: number): Promise<{ fullId: string; ip: string; port: number } | null> {
    const cached = ipCache.get(shortId);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return { fullId: cached.fullId, ip: cached.ip, port };
    const fullId = await containerManager.resolveContainerId(shortId);
    if (!fullId) return null;
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

    // Public previews skip auth entirely
    if (authChecker.isPublic(target.fullId)) {
      await proxyToContainer(request, reply, target.ip, target.port, request.url || "/");
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
          reply.raw.writeHead(502);
          reply.raw.end(`Proxy error: ${err.message}`);
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
): void {
  const authChecker = createPreviewAuthChecker(auth, sessionRegistry, secret);
  const ipCache = new Map<string, { fullId: string; ip: string; ts: number }>();
  const CACHE_TTL = 30_000;

  async function resolve(shortId: string): Promise<{ fullId: string; ip: string } | null> {
    const cached = ipCache.get(shortId);
    if (cached && Date.now() - cached.ts < CACHE_TTL) return { fullId: cached.fullId, ip: cached.ip };

    const fullId = await containerManager.resolveContainerId(shortId);
    if (!fullId) return null;
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

    // Auth: public previews skip auth, then try session cookie, then token
    if (!authChecker.isPublic(resolved.fullId)) {
      const headers = req.headers as Record<string, string | string[] | undefined>;
      const user = await authChecker.checkSession(headers, resolved.fullId);
      if (!user) {
        if (!parsed.token || !authChecker.checkToken(parsed.token, resolved.fullId)) {
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
