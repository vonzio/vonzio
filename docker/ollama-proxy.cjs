/**
 * Ollama auth proxy — rewrites x-api-key to Authorization: Bearer.
 * The Anthropic SDK sends x-api-key, but Ollama Cloud expects Bearer auth.
 * Delete this file to remove Ollama support.
 *
 * Under egress enforcement (feature 0005) the agent has no direct internet, so
 * the upstream call to Ollama Cloud must traverse the egress proxy. Node's
 * http/https ignore HTTP(S)_PROXY env, so this proxy dials through it itself
 * (CONNECT-tunnel for https) — same approach as docker/llm-gateway.cjs.
 */
const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");

const TARGET = process.env.OLLAMA_TARGET_URL || "https://ollama.com";
const PORT = parseInt(process.env.OLLAMA_PROXY_PORT || "11434", 10);
const { hostname, protocol } = new URL(TARGET);

function proxyForUrl(u) {
  const env = u.protocol === "https:"
    ? (process.env.HTTPS_PROXY || process.env.https_proxy)
    : (process.env.HTTP_PROXY || process.env.http_proxy);
  return env ? new URL(env) : null;
}

function proxyAuthHeader(p) {
  if (!p.username) return null;
  return "Basic " + Buffer.from(`${decodeURIComponent(p.username)}:`).toString("base64");
}

/** Build an outbound ClientRequest, routed through the egress proxy when set. */
function makeUpstreamReq(method, fullUrl, headers, cb) {
  const u = new URL(fullUrl);
  const hdrs = { ...headers, host: u.host };
  const proxy = proxyForUrl(u);

  if (proxy && u.protocol === "https:") {
    const port = Number(u.port) || 443;
    const proxyPort = Number(proxy.port) || 8080;
    const auth = proxyAuthHeader(proxy);
    return https.request(fullUrl, {
      method,
      headers: hdrs,
      createConnection(_opts, oncreate) {
        const proxyTimeout = Number(process.env.OLLAMA_PROXY_TIMEOUT || 15000);
        const sock = net.connect({ host: proxy.hostname, port: proxyPort });
        let settled = false;
        const fail = (err) => { if (settled) return; settled = true; sock.destroy(); oncreate(err instanceof Error ? err : new Error(String(err))); };
        const onProxyError = (err) => fail(err);
        sock.setTimeout(proxyTimeout, () => fail(new Error("proxy CONNECT timeout")));
        sock.once("error", onProxyError);
        const chunks = [];
        const onData = (chunk) => {
          chunks.push(chunk);
          const buf = Buffer.concat(chunks);
          const sep = buf.indexOf("\r\n\r\n");
          if (sep === -1) return;
          sock.removeListener("data", onData);
          sock.removeListener("error", onProxyError);
          sock.setTimeout(0);
          const status = buf.slice(0, buf.indexOf("\r\n")).toString("latin1");
          if (!/^HTTP\/1\.[01] 200\b/.test(status)) {
            return fail(new Error("proxy CONNECT failed: " + status.trim()));
          }
          const remainder = buf.slice(sep + 4);
          if (remainder.length) sock.unshift(remainder);
          const tlsSock = tls.connect({ socket: sock, servername: u.hostname });
          const onTlsErr = (err) => fail(err);
          tlsSock.once("error", onTlsErr);
          tlsSock.once("secureConnect", () => {
            if (settled) { tlsSock.destroy(); return; }
            settled = true;
            tlsSock.removeListener("error", onTlsErr);
            oncreate(null, tlsSock);
          });
        };
        sock.on("data", onData);
        sock.once("connect", () => {
          let h = `CONNECT ${u.hostname}:${port} HTTP/1.1\r\nHost: ${u.hostname}:${port}\r\n`;
          if (auth) h += `Proxy-Authorization: ${auth}\r\n`;
          sock.write(h + "\r\n");
        });
        return undefined;
      },
    }, cb);
  }

  if (proxy && u.protocol === "http:") {
    const auth = proxyAuthHeader(proxy);
    if (auth) hdrs["proxy-authorization"] = auth;
    return http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 8080,
      method,
      path: fullUrl,
      headers: hdrs,
    }, cb);
  }

  const lib = u.protocol === "https:" ? https : http;
  return lib.request(fullUrl, { method, headers: hdrs }, cb);
}

const server = http.createServer((req, res) => {
  const apiKey = req.headers["x-api-key"] || "";
  const headers = { ...req.headers, authorization: `Bearer ${apiKey}`, host: hostname };
  delete headers["x-api-key"];

  const proxyReq = makeUpstreamReq(req.method, `${TARGET}${req.url}`, headers, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (e) => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: e.message }));
  });
  req.pipe(proxyReq);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") process.exit(0);
  throw e;
});
server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`ollama-proxy listening on 127.0.0.1:${PORT} -> ${TARGET}\n`);
});

if (protocol !== "https:" && protocol !== "http:") {
  process.stderr.write(`ollama-proxy: unsupported TARGET protocol ${protocol}\n`);
}
