// Dashboard Content-Security-Policy + per-request nonce injection.
//
// The dashboard ships with a strict CSP so that BUNDLING is the only path code
// reaches the dashboard origin (docs/PLUGIN_LOADER_SPEC.md §16): `script-src`
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
export function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

/**
 * Serve the dashboard index.html with a fresh per-request nonce + CSP header.
 * If the template carries no nonce placeholder (a downstream dashboard build
 * that didn't run the vonzio Vite plugin — e.g. the SaaS cp-dashboard), serve
 * it as-is WITHOUT the strict CSP rather than break it (a strict CSP over
 * un-nonced scripts would blank the page).
 */
export function serveDashboardIndex(reply: FastifyReply, template: string): FastifyReply {
  reply.header("cache-control", "no-cache");
  reply.type("text/html");
  if (!template.includes(NONCE_PLACEHOLDER)) {
    return reply.send(template);
  }
  const nonce = randomBytes(16).toString("base64url");
  reply.header("content-security-policy", buildCsp(nonce));
  return reply.send(template.split(NONCE_PLACEHOLDER).join(nonce));
}
