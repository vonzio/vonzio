import { describe, it, expect } from "vitest";
import {
  PLUGIN_CAPABILITIES,
  CAPABILITY_SURFACE_MAP,
  isPluginCapability,
  ROOT_EQUIVALENT_COMBINATIONS,
  BUILTIN_ONLY_CAPABILITIES,
} from "./capabilities.js";

describe("capability enum", () => {
  it("has exactly 31 capabilities (the §5 enumerated union)", () => {
    // The enumerated union in capabilities.ts is authoritative.
    expect(PLUGIN_CAPABILITIES).toHaveLength(31);
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

  it("secrets.mtls is external-allowed and not root-equivalent", () => {
    // External plugins (e.g. Teller) must be able to declare it: the opaque-ref
    // design means the key bytes never reach plugin memory, so it's safe even
    // alongside integrations.read.decrypted.
    expect(BUILTIN_ONLY_CAPABILITIES.has("secrets.mtls")).toBe(false);
    for (const combo of ROOT_EQUIVALENT_COMBINATIONS) {
      expect(combo).not.toContain("secrets.mtls");
    }
  });
});
