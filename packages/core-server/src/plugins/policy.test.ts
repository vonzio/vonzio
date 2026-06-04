import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hashPackageDir,
  classifySource,
  crossCheckPolicy,
  type CrossCheckArgs,
} from "./policy.js";
import type { PluginManifest, PolicyEntry } from "@vonzio/plugin-api";

describe("hashPackageDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vonzio-pkg-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is stable across calls and ignores node_modules", () => {
    writeFileSync(path.join(dir, "index.ts"), "export const x = 1;\n");
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "a.ts"), "a\n");
    const h1 = hashPackageDir(dir);

    // Adding junk under node_modules must not change the hash.
    mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "dep", "index.js"), "module.exports = {}\n");
    const h2 = hashPackageDir(dir);
    expect(h2).toBe(h1);
  });

  it("changes when a tracked file changes", () => {
    writeFileSync(path.join(dir, "index.ts"), "v1\n");
    const h1 = hashPackageDir(dir);
    writeFileSync(path.join(dir, "index.ts"), "v2\n");
    const h2 = hashPackageDir(dir);
    expect(h2).not.toBe(h1);
  });
});

describe("classifySource", () => {
  const repoRoot = "/repo";
  const builtins = new Set(["@vonzio/plugin-slack"]);

  it("builtin: inside packages/ AND in builtins policy", () => {
    expect(
      classifySource("/repo/packages/plugins/slack", repoRoot, builtins, "@vonzio/plugin-slack"),
    ).toBe("builtin");
  });

  it("external: installed under node_modules", () => {
    expect(
      classifySource("/repo/node_modules/@vonzio/plugin-gmail", repoRoot, builtins, "@vonzio/plugin-gmail"),
    ).toBe("external");
  });

  it("external: inside packages/ but NOT in builtins (npm-link footgun)", () => {
    expect(
      classifySource("/repo/packages/evil", repoRoot, builtins, "evil-plugin"),
    ).toBe("external");
  });
});

describe("crossCheckPolicy", () => {
  const manifest: PluginManifest = {
    apiVersion: "1.0",
    backendEntry: "./src/index.ts",
    capabilities: ["storage.kv", "http.outbound"],
    outboundHosts: ["api.example.com"],
  };
  const entry: PolicyEntry = {
    version: "0.3.1",
    approved_hash_sha256: "abc123",
    approved_capabilities: ["storage.kv", "http.outbound", "events.read"],
    approved_outbound_hosts: ["api.example.com", "other.example.com"],
  };
  const baseArgs: CrossCheckArgs = {
    packageName: "@vonzio/plugin-x",
    manifest,
    entry,
    installedVersion: "0.3.1",
    installedHash: "abc123",
  };

  it("passes when hash/version/caps/hosts all match", () => {
    const r = crossCheckPolicy(baseArgs);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.grantedCapabilities).toEqual(["storage.kv", "http.outbound"]);
  });

  it("refuses on missing entry", () => {
    expect(crossCheckPolicy({ ...baseArgs, entry: null })).toMatchObject({
      ok: false,
      reason: "policy_missing",
    });
  });

  it("refuses on hash mismatch", () => {
    expect(crossCheckPolicy({ ...baseArgs, installedHash: "deadbeef" })).toMatchObject({
      ok: false,
      reason: "policy_hash_mismatch",
    });
  });

  it("refuses on version mismatch (strict) but allows loose", () => {
    expect(crossCheckPolicy({ ...baseArgs, installedVersion: "0.4.0" })).toMatchObject({
      ok: false,
      reason: "policy_version_mismatch",
    });
    expect(crossCheckPolicy({ ...baseArgs, installedVersion: "0.4.0", trackVersions: "loose" }).ok).toBe(true);
  });

  it("refuses on capability drift", () => {
    const m: PluginManifest = { ...manifest, capabilities: [...manifest.capabilities, "db.access"] };
    expect(crossCheckPolicy({ ...baseArgs, manifest: m })).toMatchObject({
      ok: false,
      reason: "policy_capability_drift",
    });
  });

  it("refuses on outbound host drift", () => {
    const m: PluginManifest = { ...manifest, outboundHosts: ["api.example.com", "evil.com"] };
    expect(crossCheckPolicy({ ...baseArgs, manifest: m })).toMatchObject({
      ok: false,
      reason: "policy_outbound_host_drift",
    });
  });

  it("refuses an unapproved frontend with the approve --frontend hint", () => {
    const m: PluginManifest = { ...manifest, frontendEntry: "./dist/frontend.js" };
    const r = crossCheckPolicy({ ...baseArgs, manifest: m });
    expect(r).toMatchObject({ ok: false, reason: "unapproved_frontend" });
    if (!r.ok) expect(r.remediation).toContain("--frontend");
  });

  it("passes an approved frontend", () => {
    const m: PluginManifest = { ...manifest, frontendEntry: "./dist/frontend.js" };
    const e: PolicyEntry = { ...entry, approved_frontend: true };
    const r = crossCheckPolicy({ ...baseArgs, manifest: m, entry: e });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.frontendApproved).toBe(true);
  });
});
