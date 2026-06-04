import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { dryRunValidate } from "./cli.js";
import { findRepoRoot } from "./policy.js";
import { CAPABILITY_SURFACE_MAP, type PluginCapability } from "@vonzio/plugin-api";

// End-to-end validation of the REAL built-in plugins through the §3 pipeline
// (resolve via import.meta.resolve -> validate the package.json vonzio manifest
// -> classify -> hash -> cross-check against the shipped builtins policy).
// No services / DB needed: this is the validation half, exercising the actual
// slack + telegram manifests + vonzio-plugins.builtins.json.
const repoRoot = findRepoRoot();

// Reverse the capability->surface map: core surface property name (e.g.
// "imageRewriter") -> the set of capabilities that grant it. A plugin that
// accesses ctx.core.<prop> must declare AT LEAST ONE of those capabilities, or
// the membrane throws at init() and the plugin's routes never register.
function coreSurfaceToCaps(): Map<string, Set<PluginCapability>> {
  const m = new Map<string, Set<PluginCapability>>();
  for (const [cap, s] of Object.entries(CAPABILITY_SURFACE_MAP)) {
    if (!s.surface.startsWith("core.")) continue;
    const prop = s.surface.slice("core.".length);
    if (!m.has(prop)) m.set(prop, new Set());
    m.get(prop)!.add(cap as PluginCapability);
  }
  return m;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(abs));
    else if (e.isFile() && /\.tsx?$/.test(e.name)) out.push(abs);
  }
  return out;
}

/** ctx.core.<prop> surfaces actually accessed across a plugin's source. */
function accessedCoreSurfaces(pluginDir: string): Set<string> {
  const found = new Set<string>();
  const re = /ctx\.core\.([a-zA-Z]+)/g;
  for (const f of tsFiles(path.join(pluginDir, "src"))) {
    const src = readFileSync(f, "utf8");
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(src)) !== null) found.add(mm[1]);
  }
  return found;
}

describe("built-in plugins declare every capability their code uses", () => {
  // The static guard for the class of bug the membrane caught at runtime:
  // slack used ctx.core.imageRewriter without declaring images.rewrite, so its
  // routes silently failed to register. This fails CI instead.
  const rev = coreSurfaceToCaps();
  for (const name of ["slack", "telegram"]) {
    it(`@vonzio/plugin-${name}: declared capabilities cover its ctx.core.* usage`, () => {
      const dir = path.join(repoRoot, "packages", "plugins", name);
      const declared = new Set<PluginCapability>(
        JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).vonzio.capabilities,
      );
      const missing: string[] = [];
      for (const prop of accessedCoreSurfaces(dir)) {
        const grantingCaps = rev.get(prop);
        if (!grantingCaps) continue; // not a gated core surface
        if (![...grantingCaps].some((c) => declared.has(c))) {
          missing.push(`ctx.core.${prop} needs one of [${[...grantingCaps].join(", ")}]`);
        }
      }
      expect(missing, missing.join("; ")).toEqual([]);
    });
  }
});

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
