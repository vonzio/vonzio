import { describe, it, expect } from "vitest";
import {
  PLUGIN_CAPABILITIES,
  CAPABILITY_SURFACE_MAP,
  isPluginCapability,
  ROOT_EQUIVALENT_COMBINATIONS,
  BUILTIN_ONLY_CAPABILITIES,
} from "./capabilities.js";

describe("capability enum", () => {
  it("has exactly 30 capabilities (the §5 enumerated union)", () => {
    // NOTE: docs/PLUGIN_LOADER_SPEC.md §5 prose says "Total: 28" but the
    // enumerated union directly above it lists 30 members. The enumerated
    // list is authoritative; the "28" is a stale count in the prose.
    expect(PLUGIN_CAPABILITIES).toHaveLength(30);
  });

  it("has no duplicate members", () => {
    expect(new Set(PLUGIN_CAPABILITIES).size).toBe(PLUGIN_CAPABILITIES.length);
  });

  it("isPluginCapability accepts known and rejects unknown", () => {
    expect(isPluginCapability("storage.kv")).toBe(true);
    expect(isPluginCapability("http.outbound")).toBe(true);
    expect(isPluginCapability("capabilites.typo")).toBe(false);
    expect(isPluginCapability("fs.read")).toBe(false);
  });
});

describe("CAPABILITY_SURFACE_MAP completeness", () => {
  it("maps every capability — no member ships ungated", () => {
    const mapKeys = Object.keys(CAPABILITY_SURFACE_MAP).sort();
    const enumKeys = [...PLUGIN_CAPABILITIES].sort();
    expect(mapKeys).toEqual(enumKeys);
  });

  it("every entry names a core.* or ctx.* surface", () => {
    for (const cap of PLUGIN_CAPABILITIES) {
      const s = CAPABILITY_SURFACE_MAP[cap];
      expect(s.surface).toMatch(/^(core|ctx)\./);
      expect(["property", "method", "argument"]).toContain(s.kind);
      if (s.kind !== "property") {
        expect(s.methods && s.methods.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("root-equivalent + builtin-only sets", () => {
  it("root-equivalent combos reference real capabilities", () => {
    for (const combo of ROOT_EQUIVALENT_COMBINATIONS) {
      for (const cap of combo) expect(isPluginCapability(cap)).toBe(true);
    }
  });

  it("db.access is builtin-only", () => {
    expect(BUILTIN_ONLY_CAPABILITIES.has("db.access")).toBe(true);
  });
});
