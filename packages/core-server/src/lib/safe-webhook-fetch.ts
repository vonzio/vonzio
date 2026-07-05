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
// Use undici's OWN fetch (not Node's global fetch) so the custom Agent
// dispatcher below is the same undici version — passing an undici@8 Agent to
// Node's bundled-undici global fetch fails with "invalid onRequestStart method".
import { fetch as undiciFetch, Agent } from "undici";

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
  /**
   * Called with the resolved target URL of every REDIRECT hop, before it is
   * followed. Throw to abort (e.g. the plugin HTTP surface re-checks its
   * outboundHosts allowlist here so a 302 to an un-allowlisted host cannot
   * bypass the per-plugin allowlist). The initial URL is the caller's
   * responsibility; this fires only for redirect targets.
   */
  onRedirectHop?: (url: string) => void;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_MAX_REDIRECTS = 3;

/**
 * An undici dispatcher that pins every connection to a PRE-VALIDATED IP via a
 * custom `lookup`, while leaving the request URL's hostname intact. This closes
 * the DNS-rebinding window (the connection only ever goes to the IP we
 * validated) WITHOUT breaking HTTPS: TLS SNI, certificate validation, and the
 * Host header all still use the real hostname. (The previous approach
 * substituted the IP literal into the URL, which made TLS validate the cert
 * against the IP and fail with "does not match certificate's altnames".)
 */
/** Client-cert material for a mutual-TLS connection (PEM bytes, already read
 *  from the operator-provisioned files by the caller). */
export interface MtlsMaterial {
  cert: string | Buffer;
  key: string | Buffer;
  /** PEM CA bundle to trust the server cert (private mTLS endpoints). */
  ca?: string | Buffer;
  passphrase?: string;
}

/**
 * Build an undici dispatcher with two independent, composable `connect`
 * options:
 *  - `pin`: a custom `lookup` that forces the connection to a pre-validated IP
 *    (DNS-rebind defense) while leaving the request URL hostname intact, so TLS
 *    SNI + cert validation + the Host header still use the real hostname.
 *  - `mtls`: a client certificate + key presented during the TLS handshake.
 * Both live on the same `connect` object and coexist without interference.
 */
function makeConnectDispatcher(opts: {
  pin?: { ip: string; family: 4 | 6 };
  mtls?: MtlsMaterial;
}): Agent {
  const connect: Record<string, unknown> = {};
  if (opts.pin) {
    const { ip, family } = opts.pin;
    // net/tls `lookup` shape: (hostname, options, callback). With options.all the
    // callback wants an array; otherwise (address, family). Typed loosely at this
    // node/undici interop boundary.
    connect.lookup = ((
      _hostname: string,
      options: { all?: boolean },
      cb: (...args: unknown[]) => void,
    ): void => {
      if (options && options.all) cb(null, [{ address: ip, family }]);
      else cb(null, ip, family);
    }) as never;
  }
  if (opts.mtls) {
    connect.cert = opts.mtls.cert;
    connect.key = opts.mtls.key;
    if (opts.mtls.ca) connect.ca = opts.mtls.ca;
    if (opts.mtls.passphrase) connect.passphrase = opts.mtls.passphrase;
  }
  return new Agent({ connect });
}

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
  // IPv4-mapped (::ffff:0:0/96) — extract the v4 portion and re-check.
  // Two surface forms reach us:
  //   - preserved dotted form:  ::ffff:127.0.0.1
  //   - hex form, after Node's URL parser canonicalizes:  ::ffff:7f00:1
  // Both must resolve to the same v4 block decision.
  const mapped = norm.match(/^::ffff:([0-9a-f.:]+)$/);
  if (mapped) {
    const inner = mapped[1];
    if (isIP(inner) === 4) {
      return isBlockedIp(inner);
    }
    // Hex form: XXXX:YYYY where each group is 1-4 hex chars and together
    // they encode 32 bits of IPv4 address.
    const hex = inner.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isBlockedIp(v4);
    }
    // Lone trailing group form: ::ffff:1 (= 0.0.0.1 — part of 0.0.0.0/8).
    const single = inner.match(/^([0-9a-f]{1,4})$/);
    if (single) {
      const lo = parseInt(single[1], 16);
      const v4 = `0.0.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isBlockedIp(v4);
    }
    // Anything else under the ::ffff: prefix that we couldn't parse:
    // refuse rather than allow a bypass.
    return true;
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

interface ValidatedUrl {
  url: URL;
  /** The plain hostname with any IPv6 brackets stripped. */
  bareHost: string;
  /** Resolved IP for connect-time pinning. Empty when allowlisted. */
  resolvedIp: string;
  family: 4 | 6;
  /** True iff the host matched the allowlist — pin is skipped. */
  allowlisted: boolean;
}

/**
 * Strip the surrounding brackets that WHATWG URL keeps around IPv6
 * hostnames. Without this, isIP("[::1]") returns 0 and the literal
 * path is bypassed.
 */
function bareHostname(host: string): string {
  if (host.length >= 2 && host.startsWith("[") && host.endsWith("]")) {
    return host.slice(1, -1);
  }
  return host;
}

/**
 * Validate a URL string: scheme is http(s), hostname resolves to a
 * non-blocked IP (unless allowlisted). Returns the resolved IP +
 * family so the caller can pin the request.
 */
async function validateUrl(
  urlStr: string,
  allowlist: string[],
): Promise<ValidatedUrl> {
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

  const bareHost = bareHostname(url.hostname);

  // Host might already be an IP literal — short-circuit DNS.
  const literalFamily = isIP(bareHost);
  if (literalFamily) {
    if (isBlockedIp(bareHost)) {
      throw new SsrfBlockedError(`IP ${bareHost} in blocked range`, urlStr);
    }
    return {
      url,
      bareHost,
      resolvedIp: bareHost,
      family: literalFamily as 4 | 6,
      allowlisted: false,
    };
  }

  if (isAllowlisted(bareHost, allowlist)) {
    // Allowlisted hostname bypasses the IP check. We don't pin — let
    // Node resolve at connect time. This is the explicit "I want
    // internal callbacks" path.
    return {
      url,
      bareHost,
      resolvedIp: "",
      family: 4,
      allowlisted: true,
    };
  }

  // Resolve ALL A + AAAA records; any blocked one fails the call.
  // This catches misconfigured DNS that returns both a public and a
  // private record (rebinding-defense pattern).
  let records: { address: string; family: number }[];
  try {
    records = await dnsLookup(bareHost, { all: true });
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
  // Pin the request to the first record by substituting it into the
  // URL host. Defeats DNS-rebinding where a second resolution after
  // the check returns a private IP.
  return {
    url,
    bareHost,
    resolvedIp: records[0].address,
    family: records[0].family as 4 | 6,
    allowlisted: false,
  };
}

/** Body shapes accepted by the safe fetch helpers. `string` is the original
 *  contract; `Uint8Array` / `FormData` are additive (binary uploads, multipart
 *  — used by the plugin HTTP surface, e.g. Telegram sendDocument). */
export type SafeFetchBody = string | Uint8Array | FormData;

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: SafeFetchBody;
  /** Present a client certificate for mutual TLS. The cert/key bytes are read
   *  server-side (never by plugin code). Composes with the IP pin. */
  mtls?: MtlsMaterial;
}

/** Raw result of {@link safeFetchCore}: bytes + headers preserved so callers
 *  can build a WHATWG Response (text OR binary) without re-decoding. */
export interface SafeFetchResult {
  status: number;
  statusText: string;
  /** ArrayBuffer-backed (not SharedArrayBuffer) so it is a valid BodyInit. */
  bytes: Uint8Array<ArrayBuffer>;
  headers: Headers;
}

/**
 * Safe fetch for user-supplied webhook URLs. Returns the body as a UTF-8
 * string (the original contract — existing callers unchanged). Internally
 * delegates to {@link safeFetchCore}.
 */
export async function safeWebhookFetch(
  initialUrl: string,
  init: SafeFetchInit,
  options: SafeWebhookFetchOptions = {},
): Promise<{ status: number; statusText: string; body: string }> {
  const { status, statusText, bytes } = await safeFetchCore(initialUrl, init, options);
  return { status, statusText, body: new TextDecoder("utf-8").decode(bytes) };
}

/**
 * SSRF-resistant fetch returning the raw response bytes + headers. Same
 * enforcement as {@link safeWebhookFetch} (scheme, IP block, DNS-rebind pin,
 * manual redirects, timeout, size cap). The plugin HTTP surface (§10) wraps
 * the result in a real Response so plugins keep `.json()` / `.ok` /
 * `.arrayBuffer()`.
 */
export async function safeFetchCore(
  initialUrl: string,
  init: SafeFetchInit,
  options: SafeWebhookFetchOptions = {},
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowlist = readAllowlist(options.allowlist);

  // Single timer + AbortController for the WHOLE call (validation +
  // every redirect hop + body streaming). A per-hop timer would let
  // an attacker stall N × timeoutMs by chaining 3xx responses, and a
  // pre-stream-only timer (clearTimeout in finally before body read)
  // would let a slow endpoint dribble bytes forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let currentUrl = initialUrl;
  let currentMethod = init.method ?? "POST";
  let currentBody: SafeFetchBody | undefined = init.body;
  let redirectCount = 0;
  // Host the mTLS client cert is bound to (the ORIGINAL target). The cert is
  // presented only to this host; a redirect to a different host — even another
  // allowlisted one — does NOT get the client cert, so the credential can't
  // spill across hosts. Captured on the first validated hop.
  let mtlsHost: string | undefined;
  let lastResponse: Response | null = null;
  // The dispatcher pinning the CURRENT hop's connection to its validated IP.
  // Kept open until its response body is read; closed in the outer finally.
  let currentDispatcher: Agent | undefined;

  try {
    while (true) {
      const validated = await validateUrl(currentUrl, allowlist);

      // Keep the ORIGINAL hostname in the request URL so TLS SNI + cert
      // validation + the Host header all use the real host; pin the connection
      // to the pre-validated IP via the dispatcher's custom lookup (closes the
      // DNS-rebinding window without breaking HTTPS).
      const requestUrl = validated.url.toString();
      const headers: Record<string, string> = { ...(init.headers ?? {}) };

      // Release the previous 3xx response body + its dispatcher before issuing
      // the next hop, otherwise undici holds the socket open until GC.
      if (lastResponse) {
        await lastResponse.body?.cancel().catch(() => {});
        lastResponse = null;
      }
      if (currentDispatcher) {
        await currentDispatcher.close().catch(() => {});
        currentDispatcher = undefined;
      }
      // Bind the client cert to the original target host: present it only when
      // this hop's host matches the first hop's. A cross-host redirect drops the
      // cert (and likely fails at the new host, which is the safe outcome).
      if (mtlsHost === undefined) mtlsHost = validated.bareHost;
      const hopMtls = init.mtls && validated.bareHost === mtlsHost ? init.mtls : undefined;

      // Allowlisted hosts skip IP pinning (the explicit "internal callback"
      // path). A dispatcher is still needed when this call carries an mTLS
      // client cert, so build one whenever pinning OR mTLS applies.
      const needPin = !validated.allowlisted;
      if (needPin || hopMtls) {
        currentDispatcher = makeConnectDispatcher({
          pin: needPin ? { ip: validated.resolvedIp, family: validated.family } : undefined,
          mtls: hopMtls,
        });
      }

      try {
        lastResponse = (await undiciFetch(requestUrl, {
          method: currentMethod,
          headers,
          // string | Uint8Array | FormData are all valid BodyInit at runtime.
          body: currentBody as never,
          redirect: "manual",
          signal: controller.signal,
          dispatcher: currentDispatcher,
        })) as unknown as Response;
      } catch (err) {
        if (controller.signal.aborted) {
          throw new Error(`webhook request timed out after ${timeoutMs}ms`);
        }
        throw err;
      }

      // Manual redirect handling
      if (lastResponse.status >= 300 && lastResponse.status < 400) {
        const location = lastResponse.headers.get("location");
        if (!location) break; // 3xx with no Location — treat as final.
        redirectCount++;
        if (redirectCount > maxRedirects) {
          throw new SsrfBlockedError(
            `exceeded ${maxRedirects} redirects`,
            currentUrl,
          );
        }
        const status = lastResponse.status;
        currentUrl = new URL(location, currentUrl).toString();
        // Per the fetch spec, 303 (and, as browsers do, 301/302 for a
        // non-idempotent method) drops the request body and switches to GET —
        // this also stops a secret-bearing POST body being forwarded to the
        // redirect target.
        if (status === 303 || ((status === 301 || status === 302) && currentMethod !== "GET" && currentMethod !== "HEAD")) {
          currentMethod = "GET";
          currentBody = undefined;
        }
        // Re-check the caller's per-hop policy (the plugin HTTP surface
        // re-validates its outboundHosts allowlist here) BEFORE following —
        // closes the "allowlisted host 302s to an un-allowlisted host" bypass.
        options.onRedirectHop?.(currentUrl);
        continue;
      }
      break;
    }

    if (!lastResponse) throw new Error("no response received");

    // Read up to maxBytes of the body as raw bytes. The reader's lock +
    // underlying socket are released on EVERY exit path via the inner finally —
    // including read() throwing mid-stream and the size-cap throw. Raw bytes
    // (not incremental string decode) so binary downloads are not corrupted;
    // safeWebhookFetch decodes to UTF-8 for its text callers.
    const reader = lastResponse.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      let truncated = false;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          // Cap BEFORE accumulating so an oversized chunk can't sit
          // in memory next to the already-buffered body.
          if (total + value.byteLength > maxBytes) {
            truncated = true;
            break;
          }
          total += value.byteLength;
          chunks.push(value);
        }
      } finally {
        // releaseLock alone wouldn't close the socket on early exit;
        // cancel does. Safe to call after a successful drain too.
        await reader.cancel().catch(() => {});
      }
      if (truncated) {
        throw new WebhookResponseTooLargeError(maxBytes);
      }
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }

    return {
      status: lastResponse.status,
      statusText: lastResponse.statusText,
      bytes: merged,
      headers: lastResponse.headers,
    };
  } catch (err) {
    // If we throw partway through the redirect loop, the in-flight
    // response body still needs to be released.
    if (lastResponse) {
      await lastResponse.body?.cancel().catch(() => {});
    }
    if (controller.signal.aborted && err instanceof Error && err.name === "AbortError") {
      throw new Error(`webhook request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (currentDispatcher) await currentDispatcher.close().catch(() => {});
  }
}

// Exported for tests
export const __test = { isBlockedIp, isAllowlisted };


/**
 * SSRF guard for raw-socket protocols (IMAP/SMTP — feature 0035) that
 * can't go through safeFetch. Resolves `host` and rejects if it is an
 * IP literal in, or resolves to, a blocked range. Returns the pinned IP
 * so the caller connects to THAT (defeating rebinding) while presenting
 * the original hostname as the TLS servername for cert validation.
 * Throws SsrfBlockedError on any blocked/invalid host.
 */
export async function assertSocketHostAllowed(host: string): Promise<{ pinnedIp: string; family: 4 | 6 }> {
  const bare = bareHostname(host);
  if (!bare) throw new SsrfBlockedError("missing host", host);
  const literal = isIP(bare);
  if (literal) {
    if (isBlockedIp(bare)) throw new SsrfBlockedError(`IP ${bare} in blocked range`, host);
    return { pinnedIp: bare, family: literal as 4 | 6 };
  }
  let records: { address: string; family: number }[];
  try {
    records = await dnsLookup(bare, { all: true });
  } catch (err) {
    throw new SsrfBlockedError(`DNS resolution failed: ${err instanceof Error ? err.message : String(err)}`, host);
  }
  if (records.length === 0) throw new SsrfBlockedError("no DNS records", host);
  for (const r of records) {
    if (isBlockedIp(r.address)) throw new SsrfBlockedError(`resolved IP ${r.address} is blocked`, host);
  }
  return { pinnedIp: records[0].address, family: records[0].family as 4 | 6 };
}
