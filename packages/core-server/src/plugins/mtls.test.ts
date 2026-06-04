// Real mutual-TLS integration test for the ctx.secrets → ctx.http.fetch path.
// No mocking: we generate a self-signed cert/key with openssl, stand up a real
// HTTPS server that REQUIRES a client cert (requestCert + rejectUnauthorized),
// and drive it through the actual plugin HTTP surface. Proves the client cert
// is presented during a genuine handshake and that the plugin never holds the
// key bytes (it only passes an opaque ref).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { CapabilityViolationError } from "@vonzio/plugin-api";
import { makePluginSecrets } from "./secrets.js";
import { makePluginHttp } from "./http.js";
import { safeFetchCore } from "../lib/safe-webhook-fetch.js";

let dir: string;
let cert: Buffer;
let key: Buffer;
let server: https.Server;
let baseUrl: string;
let prevAllowlist: string | undefined;

beforeAll(async () => {
  // One self-signed cert (SAN=localhost) serves triple duty: server identity,
  // client cert, and the CA that trusts both.
  dir = mkdtempSync(path.join(tmpdir(), "vonzio-mtls-"));
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-nodes", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"],
    { stdio: "ignore" },
  );
  cert = readFileSync(certPath);
  key = readFileSync(keyPath);

  server = https.createServer(
    { key, cert, ca: [cert], requestCert: true, rejectUnauthorized: true },
    (req, res) => {
      const peer = (req.socket as TLSSocket).getPeerCertificate();
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`peer=${peer && peer.subject ? peer.subject.CN : "none"}`);
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `https://localhost:${port}/`;

  // safeFetchCore SSRF-blocks loopback IPs; allowlist the localhost HOSTNAME so
  // the test server is reachable (the IP literal would still be blocked).
  prevAllowlist = process.env.WEBHOOK_URL_ALLOWLIST;
  process.env.WEBHOOK_URL_ALLOWLIST = "localhost";
});

afterAll(() => {
  server?.close();
  if (prevAllowlist === undefined) delete process.env.WEBHOOK_URL_ALLOWLIST;
  else process.env.WEBHOOK_URL_ALLOWLIST = prevAllowlist;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("ctx.secrets.mtls (opaque ref)", () => {
  const secrets = () => makePluginSecrets({ pluginName: "@x/teller", declaredNames: new Set(["teller-client"]) });

  it("returns a frozen ref carrying only the name — no cert/key bytes", () => {
    const ref = secrets().mtls("teller-client");
    expect(ref).toEqual({ __vonzioMtls: true, name: "teller-client" });
    expect(Object.isFrozen(ref)).toBe(true);
    expect((ref as unknown as Record<string, unknown>).cert).toBeUndefined();
    expect((ref as unknown as Record<string, unknown>).key).toBeUndefined();
  });

  it("throws CapabilityViolationError for an undeclared name", () => {
    expect(() => secrets().mtls("not-declared")).toThrow(CapabilityViolationError);
  });

  it("fires the audit hook on resolution", () => {
    const seen: Array<{ plugin: string; name: string }> = [];
    const s = makePluginSecrets({ pluginName: "@x/teller", declaredNames: new Set(["teller-client"]), onResolve: (i) => seen.push(i) });
    s.mtls("teller-client");
    expect(seen).toEqual([{ plugin: "@x/teller", name: "teller-client" }]);
  });
});

describe("ctx.http.fetch with mTLS — real handshake", () => {
  const material = () => new Map([["teller-client", { cert, key, ca: cert }]]);
  // Production wires a shared registry so ctx.http only accepts refs minted by
  // the audited ctx.secrets.mtls().
  const wire = () => {
    const issued = new WeakSet<object>();
    return {
      http: makePluginHttp({ pluginName: "@x/teller", grantedHosts: ["localhost"], mtlsMaterial: material(), issuedMtlsRefs: issued }),
      secrets: makePluginSecrets({ pluginName: "@x/teller", declaredNames: new Set(["teller-client"]), issued }),
    };
  };

  it("presents the client cert; the server validates and echoes its CN", async () => {
    const { http, secrets } = wire();
    const res = await http.fetch(baseUrl, { mtls: secrets.mtls("teller-client") });
    expect(res.status).toBe(200);
    // The server only reaches the handler if the client cert validated; the
    // body carries the peer cert CN it observed.
    expect(await res.text()).toBe("peer=localhost");
  });

  it("refuses a ref for an unprovisioned name BEFORE any network call", async () => {
    const { http } = wire();
    const forged = { __vonzioMtls: true, name: "evil" } as never;
    await expect(http.fetch(baseUrl, { mtls: forged })).rejects.toBeInstanceOf(CapabilityViolationError);
  });

  it("refuses a forged ref even with a valid provisioned name (not minted by ctx.secrets)", async () => {
    const { http } = wire();
    // Valid, provisioned name — but the plugin hand-built the object instead of
    // calling ctx.secrets.mtls(), so it's not in the issued registry → refused.
    const forged = { __vonzioMtls: true, name: "teller-client" } as never;
    await expect(http.fetch(baseUrl, { mtls: forged })).rejects.toBeInstanceOf(CapabilityViolationError);
  });

  it("a plain (non-mTLS) call to the client-cert-required server fails", async () => {
    // Direct safeFetchCore (allowlisted) with no client cert: the server
    // requires one (rejectUnauthorized), so the handshake cannot complete.
    await expect(
      safeFetchCore(baseUrl, {}, { allowlist: ["localhost"] }),
    ).rejects.toThrow();
  });
});
