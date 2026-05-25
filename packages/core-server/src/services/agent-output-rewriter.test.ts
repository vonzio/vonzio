import { describe, it, expect } from "vitest";
import { rewriteAgentImages, type RewriteContext } from "./agent-output-rewriter.js";

const baseCtx: RewriteContext = {
  fullContainerId: "abc123def456",
  userId: "usr_test",
  containerName: "hardcorewright",
  previewUrlTemplate: "http://{container_id}-{port}.vonz.localhost",
  signToken: (cid, uid) => `${cid}:${uid}:9999999999:deadbeef`,
};

describe("rewriteAgentImages", () => {
  it("returns input unchanged when no images present", () => {
    const out = rewriteAgentImages("Hello world.", baseCtx);
    expect(out.textWithUrls).toBe("Hello world.");
    expect(out.textWithoutImages).toBe("Hello world.");
    expect(out.images).toHaveLength(0);
  });

  it("injects _pvt token into preview-URL markdown images", () => {
    const text = "Here's the butterfly:\n\n![Butterfly](http://hardcorewright-8000.vonz.localhost/butterfly.png)";
    const out = rewriteAgentImages(text, baseCtx);
    expect(out.textWithUrls).toContain("_pvt=abc123def456%3Ausr_test%3A9999999999%3Adeadbeef");
    expect(out.images).toHaveLength(1);
    expect(out.images[0].alt).toBe("Butterfly");
    expect(out.images[0].url).toContain("?_pvt=");
  });

  it("rewrites raw HTML <img> tags with src attribute", () => {
    const text = `Here it is: <img alt="Foo" src="http://hardcorewright-8000.vonz.localhost/foo.png">`;
    const out = rewriteAgentImages(text, baseCtx);
    expect(out.textWithUrls).toContain("_pvt=");
    expect(out.images).toHaveLength(1);
    expect(out.images[0].alt).toBe("Foo");
  });

  it("ignores non-preview URLs (external CDNs, wikipedia, etc.)", () => {
    const text = "![Wikipedia](https://upload.wikimedia.org/butterfly.jpg)";
    const out = rewriteAgentImages(text, baseCtx);
    expect(out.textWithUrls).toBe(text);
    expect(out.images).toHaveLength(0);
  });

  it("ignores preview URLs for OTHER containers (different name)", () => {
    const text = "![Sneaky](http://attacker-8000.vonz.localhost/secret.png)";
    const out = rewriteAgentImages(text, baseCtx);
    expect(out.textWithUrls).toBe(text);
    expect(out.images).toHaveLength(0);
  });

  it("ignores relative paths (agent didn't use the full URL template)", () => {
    const text = "![X](butterfly.png)";
    const out = rewriteAgentImages(text, baseCtx);
    expect(out.textWithUrls).toBe(text);
    expect(out.images).toHaveLength(0);
  });

  it("strips matched image refs from textWithoutImages but keeps surrounding text", () => {
    const text = "Here's a butterfly:\n\n![Butterfly](http://hardcorewright-8000.vonz.localhost/butterfly.png)\n\nIt's pretty.";
    const out = rewriteAgentImages(text, baseCtx);
    expect(out.textWithoutImages).toBe("Here's a butterfly:\n\nIt's pretty.");
    expect(out.images).toHaveLength(1);
  });

  it("deduplicates images appearing twice in the same text", () => {
    const text = "First ![A](http://hardcorewright-8000.vonz.localhost/a.png) then ![A again](http://hardcorewright-8000.vonz.localhost/a.png)";
    const out = rewriteAgentImages(text, baseCtx);
    expect(out.images).toHaveLength(1);
  });

  it("handles multiple distinct preview images", () => {
    const text = "![One](http://hardcorewright-8000.vonz.localhost/a.png) and ![Two](http://hardcorewright-8000.vonz.localhost/b.jpg)";
    const out = rewriteAgentImages(text, baseCtx);
    expect(out.images).toHaveLength(2);
    expect(out.images.map((i) => i.alt)).toEqual(["One", "Two"]);
  });

  it("matches any port on the preview subdomain (4-5 digits)", () => {
    const text = "![dev](http://hardcorewright-5173.vonz.localhost/preview.png)";
    const out = rewriteAgentImages(text, baseCtx);
    expect(out.images).toHaveLength(1);
  });

  it("supports https + prod preview templates", () => {
    const prodCtx: RewriteContext = {
      ...baseCtx,
      previewUrlTemplate: "https://{container_id}-{port}.app.vonz.io",
    };
    const text = "![pic](https://hardcorewright-8000.app.vonz.io/pic.png)";
    const out = rewriteAgentImages(text, prodCtx);
    expect(out.images).toHaveLength(1);
    expect(out.images[0].url).toContain("https://");
    expect(out.images[0].url).toContain("?_pvt=");
  });

  it("replaces existing _pvt query param rather than appending a second one", () => {
    const text = "![pic](http://hardcorewright-8000.vonz.localhost/pic.png?_pvt=stale)";
    const out = rewriteAgentImages(text, baseCtx);
    // Should contain exactly one ?_pvt= (not stale; refreshed)
    const matches = out.textWithUrls.match(/_pvt=/g) ?? [];
    expect(matches.length).toBe(1);
    expect(out.textWithUrls).not.toContain("stale");
  });

  it("preserves alt text when stripping HTML <img>", () => {
    const text = `<img alt="Tower" src="http://hardcorewright-8000.vonz.localhost/tower.png">`;
    const out = rewriteAgentImages(text, baseCtx);
    expect(out.images[0].alt).toBe("Tower");
    expect(out.textWithoutImages).toBe("");
  });

  it("only signs the token once even with multiple matched images", () => {
    let signCalls = 0;
    const ctx: RewriteContext = {
      ...baseCtx,
      signToken: () => { signCalls++; return "token-value"; },
    };
    const text = "![A](http://hardcorewright-8000.vonz.localhost/a.png) ![B](http://hardcorewright-8000.vonz.localhost/b.png)";
    rewriteAgentImages(text, ctx);
    expect(signCalls).toBe(1);
  });

  it("strips refs even when URL.toString normalizes the original (uppercase host, default port)", () => {
    // URL constructor lowercases the host and may drop default ports.
    // The single-pass strip uses the ORIGINAL raw URL so this still works.
    const text = "Look at this: ![Up](http://Hardcorewright-8000.vonz.localhost/up.png)";
    const out = rewriteAgentImages(text, baseCtx);
    expect(out.images).toHaveLength(1);
    expect(out.textWithoutImages).toBe("Look at this:");
    // textWithUrls keeps the alt and uses the normalized signed URL.
    expect(out.textWithUrls).toContain("?_pvt=");
  });

  it("does not sign a token when no images match", () => {
    let signCalls = 0;
    const ctx: RewriteContext = {
      ...baseCtx,
      signToken: () => { signCalls++; return "x"; },
    };
    rewriteAgentImages("Plain text. ![External](https://example.com/x.png)", ctx);
    expect(signCalls).toBe(0);
  });
});
