import { describe, it, expect } from "vitest";
import type { FastifyReply } from "fastify";
import { buildCsp, serveDashboardIndex, previewFrameSrc, NONCE_PLACEHOLDER } from "./dashboard-csp.js";

function mockReply() {
  const headers: Record<string, string> = {};
  let sent: string | undefined;
  let contentType: string | undefined;
  const reply = {
    header: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
      return reply;
    },
    type: (t: string) => {
      contentType = t;
      return reply;
    },
    send: (body: string) => {
      sent = body;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, get headers() { return headers; }, get sent() { return sent; }, get contentType() { return contentType; } };
}

describe("buildCsp", () => {
  it("has no 'self' in script-src — only nonce + strict-dynamic (+ wasm)", () => {
    const csp = buildCsp("ABC123");
    const scriptSrc = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("script-src"))!;
    expect(scriptSrc).toContain("'nonce-ABC123'");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toMatch(/script-src[^;]*'self'/);
  });

  it("locks down framing, objects, base-uri and admits Google Fonts", () => {
    const csp = buildCsp("x");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
    expect(csp).toContain("https://fonts.googleapis.com");
  });

  it("frame-src defaults to 'self' but admits preview subdomains when given", () => {
    expect(buildCsp("x")).toContain("frame-src 'self'");
    const csp = buildCsp("x", "'none'", previewFrameSrc("vonz.localhost"));
    expect(csp).toContain("frame-src 'self' http://*.vonz.localhost https://*.vonz.localhost");
  });
});

describe("previewFrameSrc", () => {
  it("is 'self' when no preview domain (path mode / unset)", () => {
    expect(previewFrameSrc()).toBe("'self'");
  });
  it("adds both schemes of the wildcard preview domain", () => {
    expect(previewFrameSrc("app.vonz.io")).toBe("'self' http://*.app.vonz.io https://*.app.vonz.io");
  });
});

describe("serveDashboardIndex", () => {
  const template = `<!doctype html><script nonce="${NONCE_PLACEHOLDER}">a</script><script nonce="${NONCE_PLACEHOLDER}" src="/x.js"></script>`;

  it("substitutes the placeholder with a nonce that matches the CSP header", () => {
    const m = mockReply();
    serveDashboardIndex(m.reply, template);
    const csp = m.headers["content-security-policy"];
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    expect(m.sent).not.toContain(NONCE_PLACEHOLDER);
    expect(m.sent!.match(new RegExp(`nonce="${nonce}"`, "g"))!.length).toBe(2);
    expect(m.contentType).toBe("text/html");
    expect(m.headers["cache-control"]).toBe("no-cache");
  });

  it("issues a different nonce on each request", () => {
    const a = mockReply();
    const b = mockReply();
    serveDashboardIndex(a.reply, template);
    serveDashboardIndex(b.reply, template);
    expect(a.headers["content-security-policy"]).not.toBe(b.headers["content-security-policy"]);
  });

  it("serves a non-stamped template with a BASELINE CSP (degraded, not absent)", () => {
    const m = mockReply();
    serveDashboardIndex(m.reply, "<!doctype html><script src=/x.js></script>");
    const csp = m.headers["content-security-policy"];
    // Not the strict nonce policy, but not fail-open either: still locks down
    // framing/objects/base-uri, relaxes script-src to 'self'.
    expect(csp).toBeDefined();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("nonce-");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(m.sent).toContain("<script src=/x.js>");
  });
});
