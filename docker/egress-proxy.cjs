/**
 * Egress proxy — the network enforcement point for agent egress allowlists.
 *
 * Agent containers run on an `internal: true` docker network with NO direct
 * route to the internet and NO external DNS. The ONLY way out is this proxy,
 * which is dual-homed (internal network + an external network). Agents are
 * given HTTP_PROXY/HTTPS_PROXY pointing here, so:
 *   - HTTPS arrives as `CONNECT host:443` — we read the host directly (NO MITM,
 *     no TLS termination, no SNI parsing).
 *   - plain HTTP arrives as an absolute-form request — we read the Host.
 * The proxy resolves the host ITSELF (agents have no external resolver, which
 * also kills DNS-tunnel exfil), checks every resolved IP against a private/
 * reserved blocklist (defeats DNS-rebinding to an internal address even via an
 * allowlisted name), and only then tunnels/forwards. Anything not on the
 * caller's allowlist is refused — fail-closed.
 *
 * Per-caller allowlist WITHOUT any shared state: the orchestrator injects a
 * stateless HMAC-signed token as the proxy Basic-auth username
 * (HTTP_PROXY=http://<token>@egress-proxy:PORT). The token's payload IS the
 * allowlist (+ the auto-allowed model host). The proxy verifies the signature
 * with EGRESS_PROXY_SECRET; an agent can read its own token but cannot forge a
 * broader one. No registration round-trip, no source-IP map, restart-safe.
 *
 * Env:
 *   EGRESS_PROXY_SECRET   HMAC secret for token verification (REQUIRED)
 *   EGRESS_PROXY_PORT     listen port                 (default 8080)
 *   EGRESS_PROXY_PORTS    allowed dst ports, csv      (default "80,443")
 *   EGRESS_PROXY_TIMEOUT  upstream connect timeout ms (default 10000)
 *
 * Known v1 limitation (documented, accepted): HTTPS is filtered on the CONNECT
 * target host — the standard explicit-proxy model — NOT on the inner TLS SNI
 * (no MITM). An agent could therefore CONNECT to an allowlisted host and, IF a
 * disallowed host is co-hosted on the very same IP, negotiate TLS with a
 * different SNI to reach it. Closing this requires transparent interception +
 * ClientHello parsing (v2). The private-IP/metadata block is independent of
 * this and always applies.
 *
 * The pure functions are exported for unit testing; the server only starts when
 * this file is run directly. Delete this file + the orchestrator wiring to
 * disable network egress enforcement.
 *
 * NOTE: isBlockedIp / hostMatches mirror `safe-webhook-fetch.ts` (isBlockedIp /
 * isAllowlisted). This file runs in a separate minimal container image and
 * cannot import the server's TypeScript, so the logic is intentionally
 * duplicated — keep the two in sync if the IP ranges or match semantics change.
 */
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const dns = require("dns").promises;
const { isIP } = require("net");

// ---------------------------------------------------------------------------
// Token: payload_b64url "." hmac_b64url. payload = JSON { d: string[] }.
// `d` is the resolved allowlist (profile defaults ∪ task overrides ∪ model
// host). A literal "*" means allow any HOSTNAME (private-IP block still
// applies); in practice "*" agents bypass the proxy entirely upstream.
// ---------------------------------------------------------------------------

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Sign an allowlist into a token. `ttlSeconds` (optional) stamps an absolute
 * `exp` (unix seconds) so a leaked token can't be replayed forever — the
 * orchestrator signs one per task, whose lifetime is bounded.
 */
function signToken(domains, secret, ttlSeconds) {
  const claims = { d: domains };
  if (ttlSeconds && ttlSeconds > 0) {
    claims.exp = Math.floor(Date.now() / 1000) + Math.floor(ttlSeconds);
  }
  const payload = b64url(JSON.stringify(claims));
  const sig = b64url(crypto.createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

/**
 * Verify + decode a token. Returns { domains } on success or null on any
 * failure (bad shape, bad signature, unparseable payload, expired). Constant-
 * time signature comparison. `nowSeconds` is injectable for tests.
 */
function verifyToken(token, secret, nowSeconds) {
  if (typeof token !== "string" || !secret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(crypto.createHmac("sha256", secret).update(payload).digest());
  // timingSafeEqual requires equal-length buffers.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof (parsed && parsed.exp) === "number") {
    const now = typeof nowSeconds === "number" ? nowSeconds : Math.floor(Date.now() / 1000);
    if (now >= parsed.exp) return null; // expired
  }
  const domains = Array.isArray(parsed && parsed.d) ? parsed.d.filter((x) => typeof x === "string") : [];
  return { domains };
}

// ---------------------------------------------------------------------------
// Host allowlist matching. An entry allows itself AND its subdomains
// (`github.com` permits `api.github.com`), matching safe-webhook-fetch's
// isAllowlisted. A leading "*." is accepted and stripped to the same suffix.
// "*" allows any hostname.
// ---------------------------------------------------------------------------

function hostMatches(host, domains) {
  if (!host) return false;
  const h = host.toLowerCase();
  for (const raw of domains) {
    if (raw === "*") return true;
    let suffix = String(raw).toLowerCase().trim();
    if (!suffix) continue;
    if (suffix.startsWith("*.")) suffix = suffix.slice(2);
    if (h === suffix) return true;
    if (h.endsWith("." + suffix)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Private/reserved IP blocklist — mirrors safe-webhook-fetch.ts isBlockedIp.
// ---------------------------------------------------------------------------

/**
 * Expand any textual IPv6 address (compressed, with embedded IPv4, with a zone
 * id) into 8 16-bit groups, or null if unparseable. Robust expansion is what
 * lets isBlockedIp catch the non-canonical forms an attacker controls via a
 * crafted AAAA record (NAT64, IPv4-compatible/mapped, uncompressed loopback).
 */
function expandIPv6(ip) {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct); // strip zone id

  // Fold a trailing embedded IPv4 (::ffff:1.2.3.4, 64:ff9b::1.2.3.4, ::1.2.3.4)
  // into two hex groups so the rest of the parse is uniform.
  const lastColon = s.lastIndexOf(":");
  const tail = lastColon >= 0 ? s.slice(lastColon + 1) : "";
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return null;
    const p = tail.split(".").map(Number);
    if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const g1 = ((p[0] << 8) | p[1]).toString(16);
    const g2 = ((p[2] << 8) | p[3]).toString(16);
    s = s.slice(0, lastColon + 1) + g1 + ":" + g2;
  }

  let groups;
  const dbl = s.indexOf("::");
  if (dbl >= 0) {
    if (s.indexOf("::", dbl + 1) >= 0) return null; // more than one "::"
    const head = s.slice(0, dbl).split(":").filter((x) => x !== "");
    const rest = s.slice(dbl + 2).split(":").filter((x) => x !== "");
    const missing = 8 - head.length - rest.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...rest];
  } else {
    groups = s.split(":");
  }
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function isBlockedIp(ip) {
  const family = isIP(ip);
  if (family === 0) return true; // can't validate, refuse

  if (family === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b, c] = parts;
    if (a === 0) return true;                            // 0.0.0.0/8
    if (a === 10) return true;                           // 10/8 RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64/10 CGNAT
    if (a === 127) return true;                          // 127/8 loopback
    if (a === 169 && b === 254) return true;             // 169.254/16 link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16/12 RFC1918
    if (a === 192 && b === 168) return true;             // 192.168/16 RFC1918
    if (a === 192 && b === 0 && c === 0) return true;     // 192.0.0/24
    if (a === 192 && b === 0 && c === 2) return true;     // 192.0.2/24 doc
    if (a === 198 && b >= 18 && b <= 19) return true;    // 198.18/15 benchmark
    if (a === 198 && b === 51 && c === 100) return true; // doc
    if (a === 203 && b === 0 && c === 113) return true;  // doc
    if (a >= 224) return true;                           // multicast + reserved
    return false;
  }

  const g = expandIPv6(ip);
  if (!g) return true; // unparseable v6 — refuse

  const embeddedV4 = () =>
    `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
  const hi6Zero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;

  // ::  and  ::1   (unspecified + loopback, any textual form)
  if (hi6Zero && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true;
  // IPv4-mapped ::ffff:a.b.c.d  → re-check the embedded v4
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isBlockedIp(embeddedV4());
  }
  // IPv4-compatible ::a.b.c.d (deprecated) — treat the embedded v4 as the dest
  if (hi6Zero) return isBlockedIp(embeddedV4());
  // NAT64 well-known prefix 64:ff9b::/96 → embedded v4 (defeats metadata via NAT64)
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isBlockedIp(embeddedV4());
  }
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local fec0::/10 (deprecated)
  if ((g[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

/** Parse a CONNECT target ("host:port" — host may be a bracketed IPv6). */
function parseConnectTarget(target) {
  if (typeof target !== "string" || !target) return null;
  // [ipv6]:port
  const v6 = target.match(/^\[([^\]]+)\]:(\d+)$/);
  if (v6) return { host: v6[1], port: Number(v6[2]) };
  const idx = target.lastIndexOf(":");
  if (idx <= 0) return null;
  const host = target.slice(0, idx);
  const port = Number(target.slice(idx + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

/**
 * Resolve a hostname to a single connectable IP, refusing if it resolves to a
 * blocked range (rebind defense — ALL records are checked). IP literals are
 * checked directly. Returns { ip, family } or throws.
 */
async function resolveSafe(host) {
  const literal = isIP(host);
  if (literal) {
    if (isBlockedIp(host)) throw new Error(`blocked IP ${host}`);
    return { ip: host, family: literal };
  }
  const records = await dns.lookup(host, { all: true });
  if (!records.length) throw new Error(`no DNS records for ${host}`);
  for (const r of records) {
    if (isBlockedIp(r.address)) throw new Error(`${host} resolves to blocked IP ${r.address}`);
  }
  return { ip: records[0].address, family: records[0].family };
}

// ---------------------------------------------------------------------------
// HTTP server (started only under require.main === module)
// ---------------------------------------------------------------------------

/** Pull the signed token out of a Proxy-Authorization: Basic header. */
function tokenFromProxyAuth(header) {
  if (!header || typeof header !== "string") return null;
  const m = header.match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  // username:password — the token is the username (password empty/ignored).
  const colon = decoded.indexOf(":");
  return colon === -1 ? decoded : decoded.slice(0, colon);
}

function startServer() {
  const secret = process.env.EGRESS_PROXY_SECRET;
  if (!secret) {
    console.error("[egress-proxy] EGRESS_PROXY_SECRET is required");
    process.exit(1);
  }
  const port = Number(process.env.EGRESS_PROXY_PORT || 8080);
  const allowedPorts = new Set(
    (process.env.EGRESS_PROXY_PORTS || "80,443").split(",").map((s) => Number(s.trim())).filter(Boolean),
  );
  const connectTimeout = Number(process.env.EGRESS_PROXY_TIMEOUT || 10000);

  const server = http.createServer((req, res) => {
    // Absolute-form plain-HTTP request (HTTP_PROXY path).
    handleHttp(req, res, { secret, allowedPorts, connectTimeout }).catch((err) => {
      deny(res, 502, `proxy error: ${err && err.message}`);
    });
  });

  server.on("connect", (req, clientSocket, head) => {
    handleConnect(req, clientSocket, head, { secret, allowedPorts, connectTimeout }).catch((err) => {
      writeConnectError(clientSocket, 502, `proxy error: ${err && err.message}`);
    });
  });

  server.listen(port, () => {
    console.error(`[egress-proxy] listening on :${port}, allowed ports ${[...allowedPorts].join(",")}`);
  });
  return server;
}

/** Strip CR/LF so an error message can never split the HTTP response. */
function oneLine(msg) {
  return String(msg).replace(/[\r\n]+/g, " ").slice(0, 200);
}

function deny(res, code, msg) {
  if (res.headersSent) { try { res.end(); } catch {} return; }
  const headers = { "content-type": "text/plain" };
  // RFC7235: a 407 MUST carry a challenge so well-behaved clients retry w/ creds.
  if (code === 407) headers["proxy-authenticate"] = "Basic realm=\"egress\"";
  res.writeHead(code, headers);
  res.end(`egress denied: ${oneLine(msg)}\n`);
}

function writeConnectError(socket, code, msg) {
  try {
    const reason = oneLine(msg);
    const challenge = code === 407 ? "Proxy-Authenticate: Basic realm=\"egress\"\r\n" : "";
    socket.write(`HTTP/1.1 ${code} ${reason}\r\n${challenge}Content-Length: 0\r\n\r\n`);
    socket.end();
  } catch { /* socket already gone */ }
}

function authorize(headerValue, host, port, ctx) {
  const token = tokenFromProxyAuth(headerValue);
  const verified = verifyToken(token, ctx.secret);
  if (!verified) return { ok: false, code: 407, msg: "missing or invalid proxy credentials" };
  if (!ctx.allowedPorts.has(port)) return { ok: false, code: 403, msg: `port ${port} not allowed` };
  if (!hostMatches(host, verified.domains)) return { ok: false, code: 403, msg: `${host} not in egress allowlist` };
  return { ok: true };
}

async function handleConnect(req, clientSocket, head, ctx) {
  const target = parseConnectTarget(req.url);
  if (!target) return writeConnectError(clientSocket, 400, "bad CONNECT target");
  const auth = authorize(req.headers["proxy-authorization"], target.host, target.port, ctx);
  if (!auth.ok) {
    return writeConnectError(clientSocket, auth.code, auth.msg);
  }
  let resolved;
  try {
    resolved = await resolveSafe(target.host);
  } catch (err) {
    return writeConnectError(clientSocket, 403, err.message);
  }
  // Tear down BOTH sockets when either ends/errors — covers graceful FIN
  // (half-open leak) as well as errors. Idempotent destroy() is safe.
  const cleanup = () => { upstream.destroy(); clientSocket.destroy(); };
  const upstream = net.connect({ host: resolved.ip, port: target.port }, () => {
    // Connection established — clear the connect-phase deadline. We do NOT arm
    // an idle timeout: legitimate tunnels (SSE, long polls) idle for minutes.
    upstream.setTimeout(0);
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  // Bound only the CONNECT phase — a blackholed SYN must not pin an FD for the
  // OS default (~75s). setTimeout fires on inactivity; before connect that's
  // the connect attempt itself.
  upstream.setTimeout(ctx.connectTimeout, () => {
    if (upstream.connecting) { upstream.destroy(); writeConnectError(clientSocket, 504, "upstream connect timeout"); }
  });
  upstream.on("error", () => { writeConnectError(clientSocket, 502, "upstream error"); cleanup(); });
  upstream.on("close", cleanup);
  clientSocket.on("error", cleanup);
  clientSocket.on("close", cleanup);
}

// Hop-by-hop headers (RFC 7230 §6.1) + proxy creds — never forwarded upstream.
// Stripping these closes request-smuggling via client-controlled
// Transfer-Encoding/Connection and prevents leaking the proxy token.
const HOP_BY_HOP = new Set([
  "proxy-authorization", "proxy-connection", "connection", "keep-alive",
  "transfer-encoding", "te", "trailer", "upgrade",
]);

async function handleHttp(req, res, ctx) {
  // Absolute-form URI required for forward-proxy HTTP requests.
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return deny(res, 400, "expected absolute-form request URI (use this as an HTTP proxy)");
  }
  if (url.protocol !== "http:") return deny(res, 400, `scheme ${url.protocol} not proxied`);
  const port = url.port ? Number(url.port) : 80;
  const auth = authorize(req.headers["proxy-authorization"], url.hostname, port, ctx);
  if (!auth.ok) return deny(res, auth.code, auth.msg);
  let resolved;
  try {
    resolved = await resolveSafe(url.hostname);
  } catch (err) {
    return deny(res, 403, err.message);
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
  }
  // Keep the real Host so name-based vhosts work (connection is pinned to IP).
  headers.host = url.host;
  const upstream = http.request({
    host: resolved.ip,
    port,
    method: req.method,
    path: url.pathname + url.search,
    headers,
    timeout: ctx.connectTimeout,
  }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", (err) => deny(res, 502, err.message));
  // If the client goes away mid-flight, don't keep streaming upstream→nowhere.
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

module.exports = {
  signToken,
  verifyToken,
  hostMatches,
  isBlockedIp,
  parseConnectTarget,
  tokenFromProxyAuth,
  resolveSafe,
  startServer,
};

if (require.main === module) {
  startServer();
}
