import { describe, it, expect } from "vitest";
import {
  validateManifest,
  validatePolicy,
  matchOutboundHost,
  normalizeHostPattern,
} from "./manifest-validate.js";
import { PolicyViolationError } from "./errors.js";

const base = {
  apiVersion: "1.0",
  backendEntry: "./src/index.ts",
  capabilities: ["storage.kv"],
};

describe("validateManifest", () => {
  it("accepts a minimal valid manifest", () => {
    const r = validateManifest(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.capabilities).toEqual(["storage.kv"]);
  });

  it("rejects unknown fields (typo guard)", () => {
    const r = validateManifest({ ...base, capabilites: ["storage.kv"] });
    expect(r).toMatchObject({ ok: false, reason: "manifest_invalid" });
  });

  it("rejects an unknown capability", () => {
    const r = validateManifest({ ...base, capabilities: ["storage.kv", "fs.read"] });
    expect(r.ok).toBe(false);
  });

  it("requires non-empty outboundHosts when http.outbound is declared", () => {
    const r = validateManifest({ ...base, capabilities: ["http.outbound"] });
    expect(r).toMatchObject({ ok: false });
    const r2 = validateManifest({
      ...base,
      capabilities: ["http.outbound"],
      outboundHosts: ["api.example.com"],
    });
    expect(r2.ok).toBe(true);
  });

  it("rejects outboundHosts without the http.outbound capability", () => {
    const r = validateManifest({ ...base, outboundHosts: ["api.example.com"] });
    expect(r.ok).toBe(false);
  });

  it("rejects outboundHosts entries with scheme/port/path", () => {
    for (const bad of ["https://api.x.com", "api.x.com:8080", "api.x.com/v1", "a@x.com"]) {
      const r = validateManifest({
        ...base,
        capabilities: ["http.outbound"],
        outboundHosts: [bad],
      });
      expect(r.ok, bad).toBe(false);
    }
  });

  it("rejects multi-level and mid-pattern globs", () => {
    for (const bad of ["**.x.com", "a.*.com", "fo*.x.com", "*"]) {
      const r = validateManifest({
        ...base,
        capabilities: ["http.outbound"],
        outboundHosts: [bad],
      });
      expect(r.ok, bad).toBe(false);
    }
  });

  it("normalizes IDNA + single-level glob", () => {
    const r = validateManifest({
      ...base,
      capabilities: ["http.outbound"],
      outboundHosts: ["*.münchen.de", "API.Example.COM."],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.outboundHosts).toContain("*.xn--mnchen-3ya.de");
      expect(r.manifest.outboundHosts).toContain("api.example.com");
    }
  });

  it("requires schemaPrefix for db.* and validates the identifier", () => {
    expect(validateManifest({ ...base, capabilities: ["db.access"] })).toMatchObject({
      ok: false,
      reason: "schema_prefix_invalid",
    });
    expect(
      validateManifest({ ...base, capabilities: ["db.access"], schemaPrefix: "1bad" }),
    ).toMatchObject({ ok: false, reason: "schema_prefix_invalid" });
    expect(
      validateManifest({ ...base, capabilities: ["db.access"], schemaPrefix: "slack" }).ok,
    ).toBe(true);
  });

  it("validates routePrefix shape", () => {
    expect(validateManifest({ ...base, routePrefix: { kind: "auto" } }).ok).toBe(true);
    expect(
      validateManifest({ ...base, routePrefix: { kind: "absolute", prefix: "/v1/slack" } }).ok,
    ).toBe(true);
    expect(
      validateManifest({ ...base, routePrefix: { kind: "absolute", prefix: ["/v1/x", "/api/x"] } }).ok,
    ).toBe(true);
    expect(validateManifest({ ...base, routePrefix: { kind: "weird" } }).ok).toBe(false);
    expect(
      validateManifest({ ...base, routePrefix: { kind: "absolute", prefix: "no-slash" } }).ok,
    ).toBe(false);
  });
});

describe("matchOutboundHost", () => {
  const patterns = [normalizeHostPattern("slack.com"), normalizeHostPattern("*.slack.com")];

  it("matches exact host", () => {
    expect(matchOutboundHost("slack.com", patterns)).toBe(true);
  });

  it("single-label glob matches one extra label only", () => {
    expect(matchOutboundHost("files.slack.com", patterns)).toBe(true);
    expect(matchOutboundHost("a.b.slack.com", patterns)).toBe(false);
  });

  it("apex is not matched by the glob alone", () => {
    expect(matchOutboundHost("slack.com", [normalizeHostPattern("*.slack.com")])).toBe(false);
  });

  it("is case-insensitive and strips trailing dot", () => {
    expect(matchOutboundHost("FILES.SLACK.COM.", patterns)).toBe(true);
  });

  it("does not match unrelated hosts", () => {
    expect(matchOutboundHost("evil.com", patterns)).toBe(false);
    expect(matchOutboundHost("notslack.com", patterns)).toBe(false);
  });
});

describe("validatePolicy", () => {
  const goodEntry = {
    version: "0.3.1",
    approved_hash_sha256: "9a7f",
    approved_capabilities: ["storage.kv", "http.outbound"],
    approved_outbound_hosts: ["api.example.com"],
    approved_frontend: true,
  };

  it("accepts a valid policy", () => {
    const p = validatePolicy({ policy_version: "1", plugins: { "@vonzio/plugin-x": goodEntry } });
    expect(p.plugins["@vonzio/plugin-x"].approved_frontend).toBe(true);
  });

  it("rejects wrong policy_version", () => {
    expect(() => validatePolicy({ policy_version: "2", plugins: {} })).toThrow(PolicyViolationError);
  });

  it("rejects unknown per-entry fields", () => {
    expect(() =>
      validatePolicy({ policy_version: "1", plugins: { x: { ...goodEntry, sneaky: 1 } } }),
    ).toThrow(PolicyViolationError);
  });

  it("rejects missing required entry fields", () => {
    const { approved_hash_sha256, ...missing } = goodEntry;
    void approved_hash_sha256;
    expect(() => validatePolicy({ policy_version: "1", plugins: { x: missing } })).toThrow(
      PolicyViolationError,
    );
  });
});
