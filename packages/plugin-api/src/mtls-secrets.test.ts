import { describe, it, expect } from "vitest";
import { validateManifest, validatePolicy } from "./manifest-validate.js";
import { crossCheckPolicy } from "./policy.js";
import type { PluginManifest, PolicyEntry } from "./manifest.js";

// ── Manifest: mtlsSecrets ↔ secrets.mtls coupling + name validation ─────────

describe("validateManifest mtlsSecrets", () => {
  const base = { apiVersion: "1.0", backendEntry: "./index.js" };

  it("accepts secrets.mtls + a non-empty mtlsSecrets list", () => {
    const r = validateManifest({ ...base, capabilities: ["secrets.mtls"], mtlsSecrets: ["teller-client"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.mtlsSecrets).toEqual(["teller-client"]);
  });

  it("refuses secrets.mtls without mtlsSecrets", () => {
    const r = validateManifest({ ...base, capabilities: ["secrets.mtls"] });
    expect(r).toMatchObject({ ok: false });
  });

  it("refuses mtlsSecrets without the secrets.mtls capability", () => {
    const r = validateManifest({ ...base, capabilities: [], mtlsSecrets: ["teller-client"] });
    expect(r).toMatchObject({ ok: false });
  });

  it("refuses a name that violates the pattern", () => {
    const r = validateManifest({ ...base, capabilities: ["secrets.mtls"], mtlsSecrets: ["Teller_Client"] });
    expect(r).toMatchObject({ ok: false });
  });

  it("refuses duplicate names", () => {
    const r = validateManifest({ ...base, capabilities: ["secrets.mtls"], mtlsSecrets: ["a", "a"] });
    expect(r).toMatchObject({ ok: false });
  });
});

// ── Policy: mtls_secrets shape ──────────────────────────────────────────────

describe("validatePolicy mtls_secrets", () => {
  const wrap = (entry: Record<string, unknown>) =>
    validatePolicy({ policy_version: "1", plugins: { "@x/p": { version: "1.0.0", approved_hash_sha256: "h", approved_capabilities: ["secrets.mtls"], approved_outbound_hosts: [], ...entry } } });

  it("accepts cert + key, with optional ca + passphraseEnv", () => {
    const p = wrap({ mtls_secrets: { "teller-client": { cert: "/c.pem", key: "/k.pem", ca: "/ca.pem", passphraseEnv: "PASS" } } });
    expect(p.plugins["@x/p"].mtls_secrets).toEqual({ "teller-client": { cert: "/c.pem", key: "/k.pem", ca: "/ca.pem", passphraseEnv: "PASS" } });
  });

  it("rejects a missing key path", () => {
    expect(() => wrap({ mtls_secrets: { "teller-client": { cert: "/c.pem" } } })).toThrow();
  });

  it("rejects an unknown field inside a secret entry", () => {
    expect(() => wrap({ mtls_secrets: { "teller-client": { cert: "/c", key: "/k", inline: "-----BEGIN" } } })).toThrow();
  });

  it("rejects a name violating the pattern", () => {
    expect(() => wrap({ mtls_secrets: { "BAD NAME": { cert: "/c", key: "/k" } } })).toThrow();
  });
});

// ── Cross-check: drift + grant ──────────────────────────────────────────────

describe("crossCheckPolicy mtls drift", () => {
  const manifest: PluginManifest = {
    apiVersion: "1.0",
    backendEntry: "./index.js",
    capabilities: ["secrets.mtls"],
    mtlsSecrets: ["teller-client"],
  };
  const entry = (mtls?: PolicyEntry["mtls_secrets"]): PolicyEntry => ({
    version: "1.0.0",
    approved_hash_sha256: "h",
    approved_capabilities: ["secrets.mtls"],
    approved_outbound_hosts: [],
    ...(mtls ? { mtls_secrets: mtls } : {}),
  });
  const args = (e: PolicyEntry) => ({ packageName: "@x/p", manifest, entry: e, installedVersion: "1.0.0", installedHash: "h", source: "builtin" as const });

  it("grants the provisioned secret paths", () => {
    const r = crossCheckPolicy(args(entry({ "teller-client": { cert: "/c", key: "/k" } })));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.grantedMtlsSecrets).toEqual({ "teller-client": { cert: "/c", key: "/k" } });
  });

  it("refuses when a declared secret is not provisioned in policy", () => {
    const r = crossCheckPolicy(args(entry(undefined)));
    expect(r).toMatchObject({ ok: false, reason: "policy_mtls_secret_drift" });
  });
});
