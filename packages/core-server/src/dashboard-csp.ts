// Dashboard Content-Security-Policy + per-request nonce injection.
//
// The dashboard ships with a strict CSP so that BUNDLING is the only path code
// reaches the dashboard origin: `script-src`
// has no `'self'`, only a per-request nonce + `'strict-dynamic'`. The bundled
// entry script carries the nonce; it loads its chunks via import() (trust
// propagates under strict-dynamic). Any OTHER script — one served from a
// plugin's Fastify route, an injected `<script src>` — lacks the nonce and the
// browser refuses it.
//
// Per-request nonce (vs the spec's per-build nonce, by decision): core-server
// generates a fresh nonce on every index.html response and substitutes the
// build-time placeholder the Vite plugin stamped onto each <script> tag. The
// nonce is unguessable and never reused, so it can't be read from page source
// and replayed.

import { randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";

/** Must match the placeholder the dashboard Vite plugin stamps onto script
 *  tags (packages/dashboard/vite-vonzio-plugins.ts NONCE_PLACEHOLDER). */
export const NONCE_PLACEHOLDER = "__VONZIO_NONCE__";

/**
 * Build the CSP header value for a given nonce. `script-src` is nonce +
 * strict-dynamic + `'wasm-unsafe-eval'` (the dashboard compiles WebAssembly —
 * shiki/mermaid — which CSP otherwise blocks). `style-src`/`font-src` admit the
 * Google Fonts the built `index.html` references; everything else is `'self'`.
 */
export function buildCsp(nonce: string, frameAncestors = "'none'"): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    `frame-ancestors ${frameAncestors}`,
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

/**
 * CSP `frame-ancestors` value for the dashboard/chat surface. Always allows
 * `'self'` (same-origin embedding — the widget on the vonzio origin's own
 * pages) plus any operator-listed external origins (WIDGET_ALLOWED_ORIGINS).
 * No external origins → `'self'` only, so a third-party site can't iframe the
 * chat (and thus can't reuse a leaked widget key from its page) unless the
 * operator explicitly lists it.
 */
export function widgetFrameAncestors(allowedOrigins: string[]): string {
  return ["'self'", ...allowedOrigins].join(" ");
}

/**
 * Baseline CSP for a dashboard build that did NOT run the vonzio Vite plugin
 * (no nonce placeholder — e.g. the SaaS cp-dashboard). It can't use the strict
 * nonce policy (its scripts carry no nonce), but it must NOT fail open to zero
 * CSP: this keeps frame-ancestors/object-src/base-uri lockdown and only relaxes
 * script-src to `'self'`.
 */
export function buildBaselineCsp(frameAncestors = "'none'"): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    `frame-ancestors ${frameAncestors}`,
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

/**
 * Serve the dashboard index.html with a fresh per-request nonce + strict CSP.
 * A template with no nonce placeholder (a downstream build) gets the baseline
 * CSP — degraded but not absent, so the most security-sensitive deployment
 * isn't served with no policy at all.
 */
export function serveDashboardIndex(
  reply: FastifyReply,
  template: string,
  frameAncestors = "'none'",
): FastifyReply {
  reply.header("cache-control", "no-cache");
  reply.type("text/html");
  if (!template.includes(NONCE_PLACEHOLDER)) {
    reply.header("content-security-policy", buildBaselineCsp(frameAncestors));
    return reply.send(template);
  }
  const nonce = randomBytes(16).toString("base64url");
  reply.header("content-security-policy", buildCsp(nonce, frameAncestors));
  return reply.send(template.split(NONCE_PLACEHOLDER).join(nonce));
}
