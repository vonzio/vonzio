import { describe, it, expect } from "vitest";
import { __test, safeWebhookFetch, SsrfBlockedError } from "./safe-webhook-fetch.js";

const { isBlockedIp, isAllowlisted } = __test;

describe("isBlockedIp", () => {
  it("blocks IPv4 loopback", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("127.255.255.254")).toBe(true);
    // 127.0.0.0/8 — full range
    expect(isBlockedIp("127.5.5.5")).toBe(true);
  });

  it("blocks IPv4 RFC 1918 ranges", () => {
    expect(isBlockedIp("10.0.0.1")).toBe(true);
    expect(isBlockedIp("10.255.255.255")).toBe(true);
    expect(isBlockedIp("172.16.0.1")).toBe(true);
    expect(isBlockedIp("172.31.255.255")).toBe(true);
    expect(isBlockedIp("172.15.0.1")).toBe(false); // just outside the range
    expect(isBlockedIp("172.32.0.1")).toBe(false);
    expect(isBlockedIp("192.168.1.1")).toBe(true);
    expect(isBlockedIp("192.168.0.0")).toBe(true);
  });

  it("blocks link-local + cloud metadata (169.254/16)", () => {
    // AWS / GCP / Azure / DO metadata services all live here.
    expect(isBlockedIp("169.254.169.254")).toBe(true);
    expect(isBlockedIp("169.254.0.1")).toBe(true);
  });

  it("blocks CGNAT (100.64/10)", () => {
    expect(isBlockedIp("100.64.0.1")).toBe(true);
    expect(isBlockedIp("100.127.255.254")).toBe(true);
    expect(isBlockedIp("100.63.255.255")).toBe(false); // just outside
    expect(isBlockedIp("100.128.0.0")).toBe(false);
  });

  it("blocks 0.0.0.0/8 (current-network) + multicast/reserved", () => {
    expect(isBlockedIp("0.0.0.0")).toBe(true);
    expect(isBlockedIp("0.1.2.3")).toBe(true);
    expect(isBlockedIp("224.0.0.1")).toBe(true); // multicast
    expect(isBlockedIp("239.255.255.250")).toBe(true);
    expect(isBlockedIp("255.255.255.255")).toBe(true); // broadcast
  });

  it("allows public IPv4", () => {
    expect(isBlockedIp("1.1.1.1")).toBe(false);
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedIp("142.250.190.46")).toBe(false); // google.com
  });

  it("blocks IPv6 loopback + link-local + ULA + multicast", () => {
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("::")).toBe(true);
    expect(isBlockedIp("fe80::1")).toBe(true);
    expect(isBlockedIp("fe80::a00:27ff:fe4e:66a1")).toBe(true);
    expect(isBlockedIp("fc00::1")).toBe(true);
    expect(isBlockedIp("fd12:3456:789a::1")).toBe(true);
    expect(isBlockedIp("ff02::1")).toBe(true);
  });

  it("blocks IPv4-mapped IPv6 that resolves to a private v4", () => {
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedIp("::ffff:192.168.1.1")).toBe(true);
    // public v4 wrapped — allow
    expect(isBlockedIp("::ffff:1.1.1.1")).toBe(false);
  });

  it("blocks IPv4-mapped IPv6 in CANONICALIZED hex form (regression)", () => {
    // Node's WHATWG URL parser rewrites `[::ffff:127.0.0.1]` to
    // `[::ffff:7f00:1]`. Before the fix, `isIP("7f00:1") === 0` made
    // the check fall through and the address was treated as public —
    // an SSRF bypass for any host that submits the bracketed form.
    expect(isBlockedIp("::ffff:7f00:1")).toBe(true);         // canon 127.0.0.1
    expect(isBlockedIp("::ffff:7f00:0001")).toBe(true);      // padded variant
    expect(isBlockedIp("::ffff:a9fe:a9fe")).toBe(true);      // canon 169.254.169.254
    expect(isBlockedIp("::ffff:c0a8:101")).toBe(true);       // canon 192.168.1.1
    expect(isBlockedIp("::ffff:a00:1")).toBe(true);          // canon 10.0.0.1
    // public v4 in canon form — still allow
    expect(isBlockedIp("::ffff:101:101")).toBe(false);       // canon 1.1.1.1
    expect(isBlockedIp("::ffff:808:808")).toBe(false);       // canon 8.8.8.8
    // single trailing group: ::ffff:1 = 0.0.0.1 (in 0.0.0.0/8 → blocked)
    expect(isBlockedIp("::ffff:1")).toBe(true);
  });

  it("allows public IPv6", () => {
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false); // cloudflare DNS
    expect(isBlockedIp("2001:4860:4860::8888")).toBe(false); // google DNS
  });

  it("rejects invalid IP strings", () => {
    // Defense in depth -- anything that doesn't parse should be
    // refused, not silently treated as public.
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("")).toBe(true);
    expect(isBlockedIp("256.256.256.256")).toBe(true);
  });
});

describe("isAllowlisted", () => {
  it("returns false on empty allowlist", () => {
    expect(isAllowlisted("internal.example.com", [])).toBe(false);
  });

  it("exact-match hostname", () => {
    expect(isAllowlisted("internal.example.com", ["internal.example.com"])).toBe(true);
    expect(isAllowlisted("other.example.com", ["internal.example.com"])).toBe(false);
  });

  it("matches subdomains via suffix", () => {
    expect(isAllowlisted("a.internal.corp", ["internal.corp"])).toBe(true);
    expect(isAllowlisted("a.b.internal.corp", ["internal.corp"])).toBe(true);
    // not a subdomain — should NOT match (no leading dot guarantees this)
    expect(isAllowlisted("xinternal.corp", ["internal.corp"])).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isAllowlisted("INTERNAL.EXAMPLE.COM", ["internal.example.com"])).toBe(true);
    expect(isAllowlisted("internal.example.com", ["INTERNAL.EXAMPLE.COM"])).toBe(true);
  });
});

describe("safeWebhookFetch", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(safeWebhookFetch("file:///etc/passwd", { method: "POST" }))
      .rejects.toThrow(SsrfBlockedError);
    await expect(safeWebhookFetch("gopher://localhost/", { method: "POST" }))
      .rejects.toThrow(SsrfBlockedError);
    await expect(safeWebhookFetch("javascript:alert(1)", { method: "POST" }))
      .rejects.toThrow(SsrfBlockedError);
  });

  it("rejects IP-literal URLs in blocked ranges (no DNS roundtrip)", async () => {
    await expect(safeWebhookFetch("http://127.0.0.1/x", { method: "POST" }))
      .rejects.toThrow(SsrfBlockedError);
    await expect(safeWebhookFetch("http://127.0.0.1/x", { method: "POST" }))
      .rejects.toThrow(/in blocked range/);
    await expect(safeWebhookFetch("http://169.254.169.254/latest/meta-data", { method: "POST" }))
      .rejects.toThrow(/in blocked range/);
    await expect(safeWebhookFetch("http://10.0.0.5/", { method: "POST" }))
      .rejects.toThrow(/in blocked range/);
  });

  it("rejects bracketed IPv6 literals in blocked ranges", async () => {
    // Regression: before the fix, validateUrl ran isIP("[::1]") which
    // returned 0 (brackets confuse it), so the literal branch was
    // skipped and the request fell through to DNS lookup which failed
    // for the wrong reason. Now bareHostname() strips the brackets so
    // we genuinely detect it as loopback.
    await expect(safeWebhookFetch("http://[::1]/", { method: "POST" }))
      .rejects.toThrow(SsrfBlockedError);
    await expect(safeWebhookFetch("http://[::1]/", { method: "POST" }))
      .rejects.toThrow(/in blocked range/);
    // The high-value bypass case: canonicalized IPv4-mapped form.
    await expect(safeWebhookFetch("http://[::ffff:7f00:1]/", { method: "POST" }))
      .rejects.toThrow(/in blocked range/);
    await expect(safeWebhookFetch("http://[::ffff:a9fe:a9fe]/latest/meta-data", { method: "POST" }))
      .rejects.toThrow(/in blocked range/);
  });

  it("rejects invalid URLs", async () => {
    await expect(safeWebhookFetch("not a url", { method: "POST" }))
      .rejects.toThrow(/invalid URL/);
    await expect(safeWebhookFetch("http://", { method: "POST" }))
      .rejects.toThrow(/invalid URL/);
  });
});
