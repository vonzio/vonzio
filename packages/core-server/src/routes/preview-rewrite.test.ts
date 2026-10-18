import { describe, it, expect } from "vitest";
import {
  prefixRootRelative,
  rewriteCss,
  rewriteHtml,
  rewriteLocation,
  rewriterFor,
  previewRefererRedirect,
} from "./preview-rewrite.js";

const P = "/preview/abc123/8000";

describe("prefixRootRelative", () => {
  it("prefixes root-relative URLs", () => {
    expect(prefixRootRelative("/static/style.css", P)).toBe(`${P}/static/style.css`);
    expect(prefixRootRelative("/", P)).toBe(`${P}/`);
  });
  it("leaves protocol-relative, absolute, relative and fragment URLs alone", () => {
    for (const u of ["//cdn.example.com/x.js", "https://example.com/x", "static/x.css", "./x", "#top", "mailto:a@b.c"]) {
      expect(prefixRootRelative(u, P)).toBe(u);
    }
  });
  it("is idempotent on already-prefixed URLs", () => {
    expect(prefixRootRelative(`${P}/static/x.css`, P)).toBe(`${P}/static/x.css`);
    expect(prefixRootRelative(P, P)).toBe(P);
    expect(prefixRootRelative(`${P}?a=1`, P)).toBe(`${P}?a=1`);
  });
  it("does not treat a longer sibling prefix as already prefixed", () => {
    expect(prefixRootRelative("/preview/abc123/80001/x", P)).toBe(`${P}/preview/abc123/80001/x`);
  });
});

describe("rewriteHtml", () => {
  it("fixes the Flask stylesheet case", () => {
    expect(rewriteHtml('<link rel="stylesheet" href="/static/style.css">', P))
      .toBe(`<link rel="stylesheet" href="${P}/static/style.css">`);
  });
  it("handles src, action, formaction, poster with double, single and no quotes", () => {
    const html = `<script src='/app.js'></script><form action=/login><button formaction="/go">x</button></form><video poster="/p.png">`;
    expect(rewriteHtml(html, P)).toBe(
      `<script src='${P}/app.js'></script><form action=${P}/login><button formaction="${P}/go">x</button></form><video poster="${P}/p.png">`,
    );
  });
  it("rewrites every srcset candidate and keeps descriptors", () => {
    expect(rewriteHtml('<img srcset="/a.png 1x, /b.png 2x, https://x.io/c.png 3x">', P))
      .toBe(`<img srcset="${P}/a.png 1x, ${P}/b.png 2x, https://x.io/c.png 3x">`);
  });
  it("rewrites url() in style attributes and <style> blocks", () => {
    const html = `<div style="background:url('/bg.png')"></div><style>body{background:url(/b.png)}</style>`;
    expect(rewriteHtml(html, P)).toBe(
      `<div style="background:url('${P}/bg.png')"></div><style>body{background:url(${P}/b.png)}</style>`,
    );
  });
  it("leaves external, protocol-relative and relative URLs untouched", () => {
    const html = '<a href="https://example.com/">x</a><script src="//cdn.x/y.js"></script><img src="img/a.png"><a href="#s">s</a>';
    expect(rewriteHtml(html, P)).toBe(html);
  });
  it("does not touch data-* attributes", () => {
    const html = '<div data-href="/x" data-src="/y"></div>';
    expect(rewriteHtml(html, P)).toBe(html);
  });
  it("is idempotent", () => {
    const once = rewriteHtml('<a href="/x">x</a>', P);
    expect(rewriteHtml(once, P)).toBe(once);
  });
});

describe("rewriteCss", () => {
  it("rewrites url() in all quote styles and @import", () => {
    const css = `@import "/base.css"; @import url(/more.css); a{b:url("/f.woff2")} c{d:url('/i.svg')} e{f:url( /g.png )}`;
    expect(rewriteCss(css, P)).toBe(
      `@import "${P}/base.css"; @import url(${P}/more.css); a{b:url("${P}/f.woff2")} c{d:url('${P}/i.svg')} e{f:url(${P}/g.png)}`,
    );
  });
  it("leaves data:, relative and external urls alone", () => {
    const css = `a{b:url(data:image/png;base64,AAA)} c{d:url(../x.png)} e{f:url(https://x.io/y.png)} g{h:url(//cdn/z.png)}`;
    expect(rewriteCss(css, P)).toBe(css);
  });
});

describe("rewriteLocation", () => {
  it("prefixes root-relative redirects", () => {
    expect(rewriteLocation("/login?next=/", P, "172.18.0.5:8000")).toBe(`${P}/login?next=/`);
  });
  it("maps absolute redirects back to the upstream onto the prefix", () => {
    expect(rewriteLocation("http://172.18.0.5:8000/done#ok", P, "172.18.0.5:8000")).toBe(`${P}/done#ok`);
  });
  it("leaves external and relative redirects alone", () => {
    expect(rewriteLocation("https://accounts.example.com/o", P, "172.18.0.5:8000")).toBe("https://accounts.example.com/o");
    expect(rewriteLocation("next", P, "172.18.0.5:8000")).toBe("next");
  });
});

describe("rewriterFor", () => {
  it("picks a rewriter for html and css only", () => {
    expect(rewriterFor("text/html; charset=utf-8")).toBe(rewriteHtml);
    expect(rewriterFor("TEXT/CSS")).toBe(rewriteCss);
    expect(rewriterFor("application/javascript")).toBeNull();
    expect(rewriterFor("image/png")).toBeNull();
    expect(rewriterFor(undefined)).toBeNull();
  });
});

describe("previewRefererRedirect", () => {
  const host = "localhost:3000";
  const ref = `http://${host}${P}/index.html`;
  it("redirects a stray root-relative GET from a preview page", () => {
    expect(previewRefererRedirect("GET", "/static/app.js?v=1", ref, host)).toBe(`${P}/static/app.js?v=1`);
    expect(previewRefererRedirect("HEAD", "/x", `http://${host}${P}`, host)).toBe(`${P}/x`);
  });
  it("ignores non-GET, missing or foreign referers, and preview paths", () => {
    expect(previewRefererRedirect("POST", "/api/x", ref, host)).toBeNull();
    expect(previewRefererRedirect("GET", "/x", undefined, host)).toBeNull();
    expect(previewRefererRedirect("GET", "/x", `http://evil.example${P}/`, host)).toBeNull();
    expect(previewRefererRedirect("GET", "/x", `http://${host}/chat/1`, host)).toBeNull();
    expect(previewRefererRedirect("GET", `${P}/x`, ref, host)).toBeNull();
    expect(previewRefererRedirect("GET", "//evil.example/x", ref, host)).toBeNull();
  });
});
