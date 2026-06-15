import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

/**
 * The egress proxy runs in-container as a standalone CommonJS file (no build
 * step), so we require it directly and exercise its pure functions. The HTTP
 * server only starts under `require.main === module`, so requiring it here is
 * side-effect-free.
 */
const require = createRequire(import.meta.url);
const proxy = require("../../../../docker/egress-proxy.cjs") as {
  signToken: (domains: string[], secret: string, ttlSeconds?: number) => string;
  verifyToken: (token: string | null, secret: string, nowSeconds?: number) => { domains: string[] } | null;
  hostMatches: (host: string, domains: string[]) => boolean;
  isBlockedIp: (ip: string) => boolean;
  parseConnectTarget: (t: string) => { host: string; port: number } | null;
  tokenFromProxyAuth: (h: string | undefined) => string | null;
};

const SECRET = "test-secret-key";

describe("egress-proxy token sign/verify", () => {
  it("round-trips the allowlist", () => {
    const t = proxy.signToken(["api.github.com", "registry.npmjs.org"], SECRET);
    expect(proxy.verifyToken(t, SECRET)).toEqual({ domains: ["api.github.com", "registry.npmjs.org"] });
  });

  it("rejects a token signed with a different secret", () => {
    const t = proxy.signToken(["api.github.com"], "other-secret");
    expect(proxy.verifyToken(t, SECRET)).toBeNull();
  });

  it("rejects a tampered payload (forging a broader allowlist)", () => {
    const t = proxy.signToken(["api.github.com"], SECRET);
    const forgedPayload = Buffer.from(JSON.stringify({ d: ["*"] }))
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const tampered = `${forgedPayload}.${t.slice(t.indexOf(".") + 1)}`;
    expect(proxy.verifyToken(tampered, SECRET)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(proxy.verifyToken("", SECRET)).toBeNull();
    expect(proxy.verifyToken("no-dot", SECRET)).toBeNull();
    expect(proxy.verifyToken(".sig", SECRET)).toBeNull();
    expect(proxy.verifyToken(null, SECRET)).toBeNull();
  });

  it("rejects any token when no secret is configured", () => {
    const t = proxy.signToken(["api.github.com"], SECRET);
    expect(proxy.verifyToken(t, "")).toBeNull();
  });

  it("honors an expiry claim", () => {
    const t = proxy.signToken(["api.github.com"], SECRET, 3600);
    // valid "now"
    expect(proxy.verifyToken(t, SECRET, 1000)?.domains).toEqual(["api.github.com"]);
    // far-future "now" → expired
    expect(proxy.verifyToken(t, SECRET, Math.floor(Date.now() / 1000) + 7200)).toBeNull();
  });

  it("treats a token without exp as non-expiring", () => {
    const t = proxy.signToken(["api.github.com"], SECRET);
    expect(proxy.verifyToken(t, SECRET, 9_999_999_999)?.domains).toEqual(["api.github.com"]);
  });
});

describe("egress-proxy hostMatches", () => {
  it("matches an exact host", () => {
    expect(proxy.hostMatches("api.github.com", ["api.github.com"])).toBe(true);
  });

  it("allows subdomains of an entry", () => {
    expect(proxy.hostMatches("api.github.com", ["github.com"])).toBe(true);
    expect(proxy.hostMatches("github.com", ["github.com"])).toBe(true);
  });

  it("does not match a parent or sibling domain", () => {
    expect(proxy.hostMatches("evil.com", ["github.com"])).toBe(false);
    expect(proxy.hostMatches("notgithub.com", ["github.com"])).toBe(false);
    // suffix must be on a dot boundary
    expect(proxy.hostMatches("evilgithub.com", ["github.com"])).toBe(false);
  });

  it("supports leading *. wildcards", () => {
    expect(proxy.hostMatches("api.example.com", ["*.example.com"])).toBe(true);
    expect(proxy.hostMatches("example.com", ["*.example.com"])).toBe(true);
  });

  it("treats '*' as allow-any-host", () => {
    expect(proxy.hostMatches("anything.io", ["*"])).toBe(true);
  });

  it("fails closed on an empty allowlist", () => {
    expect(proxy.hostMatches("api.github.com", [])).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(proxy.hostMatches("API.GitHub.com", ["github.com"])).toBe(true);
  });
});

describe("egress-proxy isBlockedIp (metadata + private ranges)", () => {
  it("blocks the cloud metadata address", () => {
    expect(proxy.isBlockedIp("169.254.169.254")).toBe(true);
  });

  it("blocks RFC1918 + loopback + CGNAT", () => {
    for (const ip of ["10.0.0.1", "172.16.5.5", "192.168.1.1", "127.0.0.1", "100.64.0.1", "0.0.0.0"]) {
      expect(proxy.isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("blocks IPv6 loopback/ULA/link-local and IPv4-mapped private", () => {
    for (const ip of ["::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
      expect(proxy.isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("blocks non-canonical IPv6 forms that reach internal/metadata", () => {
    for (const ip of [
      "0:0:0:0:0:0:0:1",            // uncompressed loopback
      "0:0:0:0:0:ffff:7f00:1",      // uncompressed IPv4-mapped 127.0.0.1
      "::ffff:169.254.169.254",     // mapped metadata
      "::a9fe:a9fe",                // IPv4-compatible metadata (169.254.169.254)
      "64:ff9b::a9fe:a9fe",         // NAT64 metadata
      "64:ff9b::169.254.169.254",   // NAT64 metadata, dotted
      "fec0::1",                    // deprecated site-local
      "198.19.0.1",                 // 198.18/15 benchmark, upper half
    ]) {
      expect(proxy.isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public IPs (v4 + v6)", () => {
    for (const ip of ["140.82.112.3", "8.8.8.8", "1.1.1.1", "2606:4700::1111", "64:ff9b::808:808"]) {
      // 64:ff9b::808:808 = NAT64 of 8.8.8.8 (public) → allowed
      expect(proxy.isBlockedIp(ip), ip).toBe(false);
    }
  });

  it("refuses unparseable input", () => {
    expect(proxy.isBlockedIp("not-an-ip")).toBe(true);
  });
});

describe("egress-proxy parseConnectTarget", () => {
  it("parses host:port", () => {
    expect(proxy.parseConnectTarget("api.github.com:443")).toEqual({ host: "api.github.com", port: 443 });
  });

  it("parses bracketed IPv6", () => {
    expect(proxy.parseConnectTarget("[2606:4700::1]:443")).toEqual({ host: "2606:4700::1", port: 443 });
  });

  it("rejects missing/invalid ports", () => {
    expect(proxy.parseConnectTarget("api.github.com")).toBeNull();
    expect(proxy.parseConnectTarget("api.github.com:notaport")).toBeNull();
    expect(proxy.parseConnectTarget("")).toBeNull();
  });
});

describe("egress-proxy tokenFromProxyAuth", () => {
  it("extracts the token (username) from Basic auth", () => {
    const header = "Basic " + Buffer.from("the-token:").toString("base64");
    expect(proxy.tokenFromProxyAuth(header)).toBe("the-token");
  });

  it("returns null for non-Basic or missing headers", () => {
    expect(proxy.tokenFromProxyAuth(undefined)).toBeNull();
    expect(proxy.tokenFromProxyAuth("Bearer xyz")).toBeNull();
  });
});
