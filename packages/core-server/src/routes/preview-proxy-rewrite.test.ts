import { describe, it, expect, afterEach } from "vitest";
import { createServer, request, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import type { FastifyReply } from "fastify";
import { bufferAndRewrite } from "./preview.js";
import { rewriterFor } from "./preview-rewrite.js";

const P = "/preview/abc123/8000";
const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

function listen(s: Server): Promise<number> {
  servers.push(s);
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));
}

/** Upstream serves `body` with `headers`; the front server runs it through bufferAndRewrite. */
async function roundTrip(body: Buffer, headers: Record<string, string>) {
  const upstreamPort = await listen(createServer((_q, res) => { res.writeHead(200, headers); res.end(body); }));
  const frontPort = await listen(createServer((_q, res) => {
    request({ host: "127.0.0.1", port: upstreamPort, path: "/" }, (up) => {
      const rewrite = rewriterFor(up.headers["content-type"])!;
      bufferAndRewrite(up, { raw: res } as unknown as FastifyReply, { ...up.headers }, rewrite, P, () => {});
    }).end();
  }));
  return new Promise<{ headers: Record<string, unknown>; text: string }>((resolve) => {
    request({ host: "127.0.0.1", port: frontPort, path: "/" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    }).end();
  });
}

describe("bufferAndRewrite", () => {
  it("decompresses gzip HTML, rewrites it, and fixes the headers", async () => {
    const html = '<link href="/static/style.css"><p>café</p>';
    const { headers, text } = await roundTrip(gzipSync(Buffer.from(html)), {
      "content-type": "text/html; charset=utf-8",
      "content-encoding": "gzip",
    });
    expect(text).toBe(`<link href="${P}/static/style.css"><p>café</p>`);
    expect(headers["content-encoding"]).toBeUndefined();
    expect(headers["content-length"]).toBe(String(Buffer.byteLength(text)));
  });

  it("passes an undecodable encoding through untouched", async () => {
    const raw = Buffer.from("not really zstd");
    const { headers, text } = await roundTrip(raw, { "content-type": "text/css", "content-encoding": "zstd" });
    expect(text).toBe("not really zstd");
    expect(headers["content-encoding"]).toBe("zstd");
  });
});
