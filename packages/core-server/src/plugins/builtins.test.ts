import { describe, it, expect } from "vitest";
import { dryRunValidate } from "./cli.js";
import { findRepoRoot } from "./policy.js";

// End-to-end validation of the REAL built-in plugins through the §3 pipeline
// (resolve via import.meta.resolve -> validate the package.json vonzio manifest
// -> classify -> hash -> cross-check against the shipped builtins policy).
// No services / DB needed: this is the validation half, exercising the actual
// slack + telegram manifests + vonzio-plugins.builtins.json.
const repoRoot = findRepoRoot();

describe("built-in plugins validate through the loader pipeline", () => {
  it("@vonzio/plugin-slack loads as a builtin with its declared capabilities", () => {
    const r = dryRunValidate("@vonzio/plugin-slack", repoRoot);
    expect(r.ok, JSON.stringify(r.refusal)).toBe(true);
    expect(r.source).toBe("builtin");
    expect(r.capabilities).toContain("db.access");
    expect(r.capabilities).toContain("http.outbound");
    expect(r.outboundHosts).toEqual(expect.arrayContaining(["slack.com", "*.slack.com", "api.anthropic.com"]));
    expect(r.frontend).toBe(true);
  });

  it("@vonzio/plugin-telegram loads as a builtin (with api.anthropic.com host)", () => {
    const r = dryRunValidate("@vonzio/plugin-telegram", repoRoot);
    expect(r.ok, JSON.stringify(r.refusal)).toBe(true);
    expect(r.source).toBe("builtin");
    expect(r.capabilities).toContain("images.rewrite");
    // deviation #6: telegram also hits Anthropic for title generation
    expect(r.outboundHosts).toEqual(expect.arrayContaining(["api.telegram.org", "api.anthropic.com"]));
    expect(r.frontend).toBe(true);
  });
});
