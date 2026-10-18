/**
 * Egress. Under enforcement the agent sits on a no-direct-internet network and
 * reaches the model only through the egress proxy. Node's http/https and the
 * built-in fetch both ignore HTTP(S)_PROXY, so the gateway, the one component
 * that talks to a real provider, routes through the proxy itself:
 *
 * - byok's calls use the global `fetch`; `installProxyFetch()` swaps in
 *   undici's fetch with a ProxyAgent (CONNECT for https) when a proxy is set.
 * - passthrough uses node http; `makeUpstreamReq()` tunnels by hand.
 *
 * The proxy token rides in the proxy URL's userinfo and is replayed as
 * Proxy-Authorization. NO_PROXY isn't consulted: the gateway only ever dials
 * external provider hosts (the SDK→gateway hop is localhost).
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { fetch as undiciFetch, ProxyAgent, type RequestInit as UndiciRequestInit } from "undici";

export function proxyForUrl(u: URL): URL | null {
  const env = u.protocol === "https:"
    ? (process.env.HTTPS_PROXY || process.env.https_proxy)
    : (process.env.HTTP_PROXY || process.env.http_proxy);
  return env ? new URL(env) : null;
}

export function proxyAuthHeader(p: URL): string | null {
  if (!p.username) return null;
  // username = signed token, password empty (Basic user:pass form).
  return "Basic " + Buffer.from(`${decodeURIComponent(p.username)}:`).toString("base64");
}

/**
 * Make byok's `fetch` proxy-aware. Returns true when a proxy was installed.
 * Both proxies are read at boot: the orchestrator restarts the daemon when
 * the routing env changes.
 */
export function installProxyFetch(): boolean {
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!httpsProxy) return false;
  const p = new URL(httpsProxy);
  const token = proxyAuthHeader(p);
  const uri = `${p.protocol}//${p.host}`;
  const dispatcher = new ProxyAgent(token ? { uri, token } : { uri });
  const proxied = (input: unknown, init?: unknown) =>
    undiciFetch(input as string, { ...(init as UndiciRequestInit), dispatcher });
  (globalThis as { fetch: unknown }).fetch = proxied;
  return true;
}

/**
 * Build an outbound ClientRequest to `fullUrl`, transparently routed through the
 * egress proxy when one is configured. Returns the ClientRequest so the caller
 * can either write a buffered body or pipe a stream.
 */
export function makeUpstreamReq(
  method: string,
  fullUrl: string,
  headers: Record<string, string | string[] | number | undefined>,
  cb: (res: http.IncomingMessage) => void,
): http.ClientRequest {
  const u = new URL(fullUrl);
  const hdrs: Record<string, string | string[] | number | undefined> = { ...headers, host: u.host };
  const proxy = proxyForUrl(u);

  if (proxy && u.protocol === "https:") {
    const port = Number(u.port) || 443;
    const proxyPort = Number(proxy.port) || 8080;
    const auth = proxyAuthHeader(proxy);
    return https.request(fullUrl, {
      method,
      headers: hdrs,
      // Defer the dial: open a TCP socket to the proxy, CONNECT, then TLS over
      // the tunnel. The established TLS socket is handed back via `oncreate`.
      createConnection(_opts: unknown, oncreate: (err: Error | null, socket?: tls.TLSSocket) => void) {
        const proxyTimeout = Number(process.env.LLM_GATEWAY_PROXY_TIMEOUT || 15000);
        const sock = net.connect({ host: proxy.hostname, port: proxyPort });
        let settled = false;
        // oncreate must fire exactly once: a blackholed proxy, a CONNECT error,
        // and a TLS-handshake failure are all funneled here under the guard.
        const fail = (err: unknown) => {
          if (settled) return;
          settled = true;
          sock.destroy();
          oncreate(err instanceof Error ? err : new Error(String(err)));
        };
        const onProxyError = (err: Error) => fail(err);
        sock.setTimeout(proxyTimeout, () => fail(new Error("proxy CONNECT timeout")));
        sock.once("error", onProxyError);
        const chunks: Buffer[] = [];
        const onData = (chunk: Buffer) => {
          chunks.push(chunk);
          const buf = Buffer.concat(chunks);
          const sep = buf.indexOf("\r\n\r\n");
          if (sep === -1) return; // CONNECT reply headers not complete yet
          sock.removeListener("data", onData);
          sock.removeListener("error", onProxyError);
          sock.setTimeout(0);
          const status = buf.subarray(0, buf.indexOf("\r\n")).toString("latin1");
          if (!/^HTTP\/1\.[01] 200\b/.test(status)) {
            fail(new Error("proxy CONNECT failed: " + status.trim()));
            return;
          }
          // Bytes after the header terminator belong to the TLS stream; push
          // them back so the TLS socket reads them.
          const remainder = buf.subarray(sep + 4);
          if (remainder.length) sock.unshift(remainder);
          const tlsSock = tls.connect({ socket: sock, servername: u.hostname });
          const onTlsErr = (err: Error) => fail(err);
          tlsSock.once("error", onTlsErr);
          tlsSock.once("secureConnect", () => {
            if (settled) {
              tlsSock.destroy();
              return;
            }
            settled = true;
            tlsSock.removeListener("error", onTlsErr); // post-handshake errors go to http
            oncreate(null, tlsSock);
          });
        };
        sock.on("data", onData);
        sock.once("connect", () => {
          let h = `CONNECT ${u.hostname}:${port} HTTP/1.1\r\nHost: ${u.hostname}:${port}\r\n`;
          if (auth) h += `Proxy-Authorization: ${auth}\r\n`;
          sock.write(h + "\r\n");
        });
        return undefined as unknown as net.Socket; // socket delivered via oncreate
      },
    } as https.RequestOptions, cb);
  }

  if (proxy && u.protocol === "http:") {
    const auth = proxyAuthHeader(proxy);
    if (auth) hdrs["proxy-authorization"] = auth;
    return http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 8080,
      method,
      path: fullUrl, // absolute-form for a forward proxy
      headers: hdrs,
    }, cb);
  }

  const lib = u.protocol === "https:" ? https : http;
  return lib.request(fullUrl, { method, headers: hdrs }, cb);
}
