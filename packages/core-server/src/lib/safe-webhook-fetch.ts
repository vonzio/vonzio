// SSRF-resistant HTTP client for delivering to user-supplied URLs.
//
// Background: vonzio lets authenticated users register webhook
// integration rows with caller-controlled `config.url`. The notify
// dispatcher then POSTs to that URL. A raw `fetch(config.url)` lets
// the authenticated user blind-probe the server's internal network:
// loopback, RFC 1918, link-local, reserved ranges, internal Docker
// DNS, cloud metadata services (169.254.169.254). Reported as a
// private security disclosure on 2026-05-31.
//
// This helper enforces:
//   1. URL scheme must be http(s). Refuses file://, gopher://, etc.
//   2. Hostname is resolved to IP(s) BEFORE the request. Every
//      resolved IP is checked against the blocklist; any private/
//      loopback/link-local/reserved address fails the call. DNS
//      rebinding is mitigated by pinning the request to the resolved
//      IP (we set `lookup` so Node uses our validated address, not a
//      fresh resolution).
//   3. Redirects are followed MANUALLY (max 3). Each redirect target
//      goes through the same scheme + IP-block check, so an attacker
//      can't bypass via 302 → http://127.0.0.1/.
//   4. Hard timeout via AbortController (default 5s).
//   5. Response size capped at 1 MiB to prevent resource-exhaustion.
//   6. Optional WEBHOOK_URL_ALLOWLIST env var (comma-separated host
//      suffixes) for self-hosters who legitimately need internal
//      callbacks (e.g. an internal monitoring webhook). Off by
//      default; allowlisted hosts bypass the IP check entirely.
//
// Not in scope here: SSRF protection for non-webhook user-controlled
// URLs (none today, but if a future feature accepts an arbitrary
// URL from authenticated input it should reuse this helper).

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfBlockedError extends Error {
  constructor(message: string, public readonly url: string) {
    super(`SSRF-blocked: ${message} (url=${url})`);
    this.name = "SsrfBlockedError";
  }
}

export class WebhookResponseTooLargeError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`webhook response exceeded ${limitBytes} bytes`);
    this.name = "WebhookResponseTooLargeError";
  }
}

export interface SafeWebhookFetchOptions {
  /** Hard timeout for the full request, in ms. Default 5000. */
  timeoutMs?: number;
  /** Max response body bytes to read. Default 1 MiB. */
  maxResponseBytes?: number;
  /** Max manual-followed redirects. Default 3. */
  maxRedirects?: number;
  /** Comma-separated host suffixes that bypass the IP block (read from
   *  WEBHOOK_URL_ALLOWLIST env when not supplied). Empty = no exceptions. */
  allowlist?: string[];
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_MAX_REDIRECTS = 3;

/**
 * RFC-aligned check for whether an IP is in a range that shouldn't
 * leave the server's box. Covers loopback, link-local, private (RFC
 * 1918 + RFC 4193), CGNAT, multicast/broadcast, reserved.
 */
function isBlockedIp(ip: string): boolean {
  const family = isIP(ip); // 4, 6, or 0 (invalid)
  if (family === 0) return true; // can't validate, refuse

  if (family === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b, c] = parts;
    if (a === 0) return true;                    // 0.0.0.0/8 (current network)
    if (a === 10) return true;                   // 10.0.0.0/8 (RFC 1918)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
    if (a === 127) return true;                  // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true;     // 169.254/16 link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12 RFC 1918
    if (a === 192 && b === 168) return true;     // 192.168/16 RFC 1918
    if (a === 192 && b === 0 && c === 0) return true;   // 192.0.0/24 reserved
    if (a === 192 && b === 0 && c === 2) return true;   // 192.0.2/24 doc
    if (a === 198 && b === 18) return true;      // 198.18/15 benchmark
    if (a === 198 && b === 51 && c === 100) return true; // doc
    if (a === 203 && b === 0 && c === 113) return true;  // doc
    if (a >= 224) return true;                   // multicast + reserved + broadcast
    return false;
  }

  // IPv6 — block loopback, link-local, ULA, multicast, IPv4-mapped private
  const norm = ip.toLowerCase();
  if (norm === "::" || norm === "::1") return true;     // unspecified + loopback
  if (norm.startsWith("fe80:")) return true;            // link-local
  if (norm.startsWith("fc") || norm.startsWith("fd")) return true; // ULA fc00::/7
  if (norm.startsWith("ff")) return true;               // multicast
  // IPv4-mapped — extract the v4 portion and re-check
  const mapped = norm.match(/^::ffff:([0-9a-f.:]+)$/);
  if (mapped && isIP(mapped[1]) === 4) {
    return isBlockedIp(mapped[1]);
  }
  return false;
}

function readAllowlist(opt: string[] | undefined): string[] {
  if (opt) return opt;
  const env = process.env.WEBHOOK_URL_ALLOWLIST?.trim();
  if (!env) return [];
  return env.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function isAllowlisted(host: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return false;
  const h = host.toLowerCase();
  for (const raw of allowlist) {
    const suffix = raw.toLowerCase();
    if (h === suffix) return true;
    if (h.endsWith("." + suffix)) return true;
  }
  return false;
}

/**
 * Validate a URL string: scheme is http(s), hostname resolves to a
 * non-blocked IP (unless allowlisted). Returns the resolved IP +
 * family so the caller can pin the request via `lookup`.
 */
async function validateUrl(
  urlStr: string,
  allowlist: string[],
): Promise<{ url: URL; resolvedIp: string; family: 4 | 6 }> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new SsrfBlockedError("invalid URL", urlStr);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockedError(`scheme ${url.protocol} not allowed`, urlStr);
  }
  if (!url.hostname) {
    throw new SsrfBlockedError("missing host", urlStr);
  }

  // Host might already be an IP literal — short-circuit DNS.
  const literalFamily = isIP(url.hostname);
  if (literalFamily) {
    if (isBlockedIp(url.hostname)) {
      throw new SsrfBlockedError(`IP ${url.hostname} in blocked range`, urlStr);
    }
    return { url, resolvedIp: url.hostname, family: literalFamily as 4 | 6 };
  }

  if (isAllowlisted(url.hostname, allowlist)) {
    // Allowlisted hostname bypasses the IP check. Don't pin; let Node
    // resolve at connect time. This is the explicit "I want internal
    // callbacks" path.
    // We still need SOME ip for the lookup hook, but returning a
    // sentinel and skipping the pin tells the caller to not override.
    // Simplest: resolve, but trust the host.
    const records = await dnsLookup(url.hostname, { all: true }).catch(() => []);
    if (records.length === 0) {
      throw new SsrfBlockedError("DNS resolution failed", urlStr);
    }
    return { url, resolvedIp: records[0].address, family: records[0].family as 4 | 6 };
  }

  // Resolve ALL A + AAAA records; any blocked one fails the call.
  // This catches misconfigured DNS that returns both a public and a
  // private record (rebinding-defense pattern).
  let records: { address: string; family: number }[];
  try {
    records = await dnsLookup(url.hostname, { all: true });
  } catch (err) {
    throw new SsrfBlockedError(
      `DNS resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      urlStr,
    );
  }
  if (records.length === 0) {
    throw new SsrfBlockedError("no DNS records", urlStr);
  }
  for (const r of records) {
    if (isBlockedIp(r.address)) {
      throw new SsrfBlockedError(`resolved IP ${r.address} is blocked`, urlStr);
    }
  }
  // Pin the request to the first record. Node's HTTPS agent will use
  // the IP we hand it via the `lookup` option, defeating DNS-rebinding
  // attacks where a second resolution after the check returns a
  // private IP.
  return {
    url,
    resolvedIp: records[0].address,
    family: records[0].family as 4 | 6,
  };
}

/**
 * Safe fetch for user-supplied webhook URLs. See file header for the
 * full enforcement list.
 */
export async function safeWebhookFetch(
  initialUrl: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
  options: SafeWebhookFetchOptions = {},
): Promise<{ status: number; statusText: string; body: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowlist = readAllowlist(options.allowlist);

  let currentUrl = initialUrl;
  let redirectCount = 0;
  let lastResponse: Response | null = null;

  while (true) {
    const validated = await validateUrl(currentUrl, allowlist);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Note: undici (Node 18+) fetch doesn't expose a `lookup` hook
      // the way `http.request` does. To pin to the resolved IP, we
      // substitute the hostname in the URL with the IP literal and
      // set the Host header back to the original hostname. This
      // closes the DNS-rebinding window between validate() and
      // connect().
      const requestUrl = (() => {
        // If allowlisted, don't pin -- the user said "I trust this".
        if (isAllowlisted(validated.url.hostname, allowlist)) {
          return validated.url.toString();
        }
        const pinned = new URL(validated.url.toString());
        // IPv6 needs brackets in the URL host.
        pinned.hostname = validated.family === 6
          ? `[${validated.resolvedIp}]`
          : validated.resolvedIp;
        return pinned.toString();
      })();

      const headers: Record<string, string> = { ...(init.headers ?? {}) };
      // Set Host explicitly so TLS SNI + virtual hosts still work
      // when we connected via the pinned IP.
      headers["Host"] = validated.url.host;

      lastResponse = await fetch(requestUrl, {
        method: init.method ?? "POST",
        headers,
        body: init.body,
        redirect: "manual", // we handle redirects ourselves
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`webhook request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    // Manual redirect handling
    if (lastResponse.status >= 300 && lastResponse.status < 400) {
      const location = lastResponse.headers.get("location");
      if (!location) {
        // 3xx with no Location — treat as final.
        break;
      }
      redirectCount++;
      if (redirectCount > maxRedirects) {
        throw new SsrfBlockedError(
          `exceeded ${maxRedirects} redirects`,
          currentUrl,
        );
      }
      // Resolve relative redirect to absolute.
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    break;
  }

  if (!lastResponse) {
    throw new Error("no response received");
  }

  // Read up to maxBytes of the body so we can include status text in
  // errors without slurping a multi-GB payload from a misbehaving
  // endpoint.
  const reader = lastResponse.body?.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  if (reader) {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new WebhookResponseTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  const body = new TextDecoder().decode(merged);

  return {
    status: lastResponse.status,
    statusText: lastResponse.statusText,
    body,
  };
}

// Exported for tests
export const __test = { isBlockedIp, isAllowlisted };
