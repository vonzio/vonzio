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

/**
 * Ollama's Anthropic-compatible /v1/messages rejects an image block nested
 * inside a tool_result ("Input should be a valid string") — unlike the real
 * Anthropic API, which the Claude Agent SDK targets (its Read tool returns an
 * image as tool_result content). Relocate any such image OUT of the tool_result
 * (leaving a text placeholder) and append it to the SAME user message as a
 * normal image block, which Ollama accepts. Returns true if anything changed.
 */
function relocateToolResultImages(body) {
  if (!body || !Array.isArray(body.messages)) return false;
  let changed = false;
  for (const msg of body.messages) {
    if (!msg || msg.role !== "user" || !Array.isArray(msg.content)) continue;
    const relocated = [];
    for (const block of msg.content) {
      if (!block || block.type !== "tool_result" || !Array.isArray(block.content)) continue;
      const images = block.content.filter((b) => b && b.type === "image");
      if (images.length === 0) continue;
      const text = block.content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
      block.content = (text ? text + "\n" : "") + `[${images.length} image(s) from this tool result are attached below]`;
      relocated.push(...images);
      changed = true;
    }
    if (relocated.length > 0) {
      msg.content.push({ type: "text", text: "Image(s) from the tool result above:" }, ...relocated);
    }
  }
  return changed;
}

function forward(req, res, headers, bodyBuf) {
  const hdrs = { ...headers };
  if (bodyBuf != null) {
    hdrs["content-length"] = Buffer.byteLength(bodyBuf);
    delete hdrs["transfer-encoding"];
  }
  const proxyReq = makeUpstreamReq(req.method, `${TARGET}${req.url}`, hdrs, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (e) => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: e.message }));
  });
  if (bodyBuf != null) { proxyReq.end(bodyBuf); } else { req.pipe(proxyReq); }
}

const server = http.createServer((req, res) => {
  const apiKey = req.headers["x-api-key"] || "";
  const headers = { ...req.headers, authorization: `Bearer ${apiKey}`, host: hostname };
  delete headers["x-api-key"];

  // Only the messages endpoint needs body rewriting; everything else streams
  // through untouched (the original dumb-proxy behavior).
  const isMessages = req.method === "POST" && typeof req.url === "string" && req.url.startsWith("/v1/messages");
  if (!isMessages) {
    forward(req, res, headers, null);
    return;
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("error", () => { res.writeHead(502); res.end(JSON.stringify({ error: "request stream error" })); });
  req.on("end", () => {
    let bodyBuf = Buffer.concat(chunks);
    try {
      const json = JSON.parse(bodyBuf.toString("utf8"));
      if (relocateToolResultImages(json)) bodyBuf = Buffer.from(JSON.stringify(json), "utf8");
    } catch { /* not JSON / unparsable — forward original bytes unchanged */ }
    forward(req, res, headers, bodyBuf);
  });
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
