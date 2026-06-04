import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  makePluginHttp,
  runInPluginContext,
  installGlobalFetchGuard,
  __resetFetchGuardForTest,
  type PluginHttpCallLog,
} from "./http.js";
import { OutboundHostViolationError } from "@vonzio/plugin-api";
import { SsrfBlockedError } from "../lib/safe-webhook-fetch.js";

describe("makePluginHttp — allowlist enforcement", () => {
  it("throws OutboundHostViolationError for a host not in the granted set", async () => {
    const http = makePluginHttp({ pluginName: "p", grantedHosts: ["api.example.com"] });
    await expect(http.fetch("https://evil.com/x")).rejects.toBeInstanceOf(OutboundHostViolationError);
  });

  it("throws for a malformed URL", async () => {
    const http = makePluginHttp({ pluginName: "p", grantedHosts: ["api.example.com"] });
    await expect(http.fetch("not a url")).rejects.toBeInstanceOf(OutboundHostViolationError);
  });

  it("emits onViolation before the request", async () => {
    const onViolation = vi.fn();
    const http = makePluginHttp({ pluginName: "p", grantedHosts: ["api.example.com"], onViolation });
    await expect(http.fetch("https://evil.com")).rejects.toThrow();
    expect(onViolation).toHaveBeenCalledWith({ plugin: "p", host: "evil.com" });
  });

  it("SSRF-blocks a granted-but-private host", async () => {
    const http = makePluginHttp({ pluginName: "p", grantedHosts: ["169.254.169.254"] });
    await expect(http.fetch("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });

  it("re-checks the allowlist on a redirect to an un-allowlisted host", async () => {
    const prev = process.env.WEBHOOK_URL_ALLOWLIST;
    const server = createServer((req, res) => {
      // localhost is allowlisted; it 302s to example.com which is NOT granted.
      res.writeHead(302, { location: "https://example.com/exfil" });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, () => r()));
    const port = (server.address() as AddressInfo).port;
    process.env.WEBHOOK_URL_ALLOWLIST = "localhost";
    try {
      const http = makePluginHttp({ pluginName: "p", grantedHosts: ["localhost"] });
      await expect(http.fetch(`http://localhost:${port}/start`)).rejects.toBeInstanceOf(
        OutboundHostViolationError,
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      if (prev === undefined) delete process.env.WEBHOOK_URL_ALLOWLIST;
      else process.env.WEBHOOK_URL_ALLOWLIST = prev;
    }
  });
});

describe("makePluginHttp — happy path returns a real Response", () => {
  let server: Server | undefined;
  const prevAllowlist = process.env.WEBHOOK_URL_ALLOWLIST;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    if (prevAllowlist === undefined) delete process.env.WEBHOOK_URL_ALLOWLIST;
    else process.env.WEBHOOK_URL_ALLOWLIST = prevAllowlist;
  });

  it("reconstructs JSON + binary bodies and logs the call", async () => {
    const payload = { hello: "world", n: 42 };
    const binary = Uint8Array.from([0, 1, 2, 250, 255]);
    server = createServer((req, res) => {
      if (req.url === "/json") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(payload));
      } else {
        res.setHeader("content-type", "application/octet-stream");
        res.end(Buffer.from(binary));
      }
    });
    await new Promise<void>((r) => server!.listen(0, () => r()));
    const port = (server!.address() as AddressInfo).port;

    // Loopback IPs are SSRF-blocked even when allowlisted (the IP-literal check
    // runs first). The env allowlist only bypasses for HOSTNAMES, so use
    // `localhost` — the documented operator escape for internal callbacks.
    process.env.WEBHOOK_URL_ALLOWLIST = "localhost";
    const logs: PluginHttpCallLog[] = [];
    const http = makePluginHttp({
      pluginName: "p",
      grantedHosts: ["localhost"],
      onCall: (l) => logs.push(l),
    });

    const jsonRes = await http.fetch(`http://localhost:${port}/json`);
    expect(jsonRes.ok).toBe(true);
    expect(jsonRes.status).toBe(200);
    expect(await jsonRes.json()).toEqual(payload);
    expect(logs.at(-1)).toMatchObject({ plugin: "p", host: "localhost", method: "GET", status: 200 });

    const binRes = await http.fetch(`http://localhost:${port}/bin`);
    const buf = new Uint8Array(await binRes.arrayBuffer());
    expect([...buf]).toEqual([...binary]);
  });
});

describe("raw-fetch guard (best-effort)", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
    __resetFetchGuardForTest();
  });

  it("logs an anomaly when a plugin without http.outbound calls global fetch", async () => {
    const stub = vi.fn(async () => new Response("ok"));
    globalThis.fetch = stub as unknown as typeof fetch;
    const anomalies: Array<{ plugin: string; url: string }> = [];
    installGlobalFetchGuard((info) => anomalies.push(info));

    await runInPluginContext({ plugin: "p", hasHttpOutbound: false }, () =>
      globalThis.fetch("https://example.com/x"),
    );
    expect(anomalies).toEqual([{ plugin: "p", url: "https://example.com/x" }]);
    expect(stub).toHaveBeenCalled(); // not blocked, just logged
  });

  it("does NOT log when the plugin declared http.outbound", async () => {
    globalThis.fetch = (async () => new Response("ok")) as unknown as typeof fetch;
    const anomalies: unknown[] = [];
    installGlobalFetchGuard((info) => anomalies.push(info));
    await runInPluginContext({ plugin: "p", hasHttpOutbound: true }, () =>
      globalThis.fetch("https://example.com/x"),
    );
    expect(anomalies).toHaveLength(0);
  });

  it("does NOT log outside any plugin context", async () => {
    globalThis.fetch = (async () => new Response("ok")) as unknown as typeof fetch;
    const anomalies: unknown[] = [];
    installGlobalFetchGuard((info) => anomalies.push(info));
    await globalThis.fetch("https://example.com/x");
    expect(anomalies).toHaveLength(0);
  });
});
