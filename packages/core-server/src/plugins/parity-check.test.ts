import { describe, it, expect } from "vitest";
import { checkDashboardParity, type DashboardPluginsJson } from "./parity-check.js";
import type { LoadedPolicies } from "./policy.js";
import type { PolicyEntry } from "@vonzio/plugin-api";

function policies(entries: Record<string, Partial<PolicyEntry>>, builtins: string[] = []): LoadedPolicies {
  const full: Record<string, PolicyEntry> = {};
  for (const [name, e] of Object.entries(entries)) {
    full[name] = {
      version: "1.0.0",
      approved_hash_sha256: e.approved_hash_sha256 ?? "hash",
      approved_capabilities: [],
      approved_outbound_hosts: [],
      ...e,
    };
  }
  return {
    builtins: { policy_version: "1", plugins: {} },
    operator: null,
    operatorPath: null,
    builtinNames: new Set(builtins),
    entryFor: (name: string) => full[name] ?? null,
  };
}

const bundled = (plugins: DashboardPluginsJson["plugins"], policyHash: string | null = null): DashboardPluginsJson => ({
  plugins,
  policyPath: null,
  policyHash,
});

describe("checkDashboardParity", () => {
  it("passes when bundle and policy agree (builtins skip hash)", () => {
    const r = checkDashboardParity({
      data: bundled([{ name: "@v/slack", source: "builtin", hash: "anything" }]),
      policies: policies({ "@v/slack": { approved_frontend: true } }, ["@v/slack"]),
      runtimePolicyHash: null,
    });
    expect(r.ok).toBe(true);
  });

  it("fails when a bundled frontend is not approved in the runtime policy", () => {
    const r = checkDashboardParity({
      data: bundled([{ name: "@v/evil", source: "external", hash: "h" }]),
      policies: policies({ "@v/evil": { approved_frontend: false, approved_hash_sha256: "h" } }),
      runtimePolicyHash: null,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/not approved_frontend/);
  });

  it("fails on external hash drift", () => {
    const r = checkDashboardParity({
      data: bundled([{ name: "@v/ext", source: "external", hash: "BUILD" }]),
      policies: policies({ "@v/ext": { approved_frontend: true, approved_hash_sha256: "RUNTIME" } }),
      runtimePolicyHash: null,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/hash/);
  });

  it("enforces external hash even if the artifact mislabels it 'builtin'", () => {
    // Runtime builtinNames is authoritative — a forged source:"builtin" must
    // NOT skip the hash check for a plugin the runtime treats as external.
    const r = checkDashboardParity({
      data: bundled([{ name: "@v/ext", source: "builtin", hash: "FORGED" }]),
      policies: policies({ "@v/ext": { approved_frontend: true, approved_hash_sha256: "REAL" } }), // not in builtinNames
      runtimePolicyHash: null,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/hash/);
  });

  it("fails when an approved built-in is missing from the bundle (forgot to rebuild)", () => {
    const r = checkDashboardParity({
      data: bundled([]),
      policies: policies({ "@v/slack": { approved_frontend: true } }, ["@v/slack"]),
      runtimePolicyHash: null,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/missing from the dashboard bundle/);
  });

  it("fails when the operator policy changed since the build", () => {
    const r = checkDashboardParity({
      data: bundled([], "BUILD_POLICY_HASH"),
      policies: policies({}),
      runtimePolicyHash: "RUNTIME_POLICY_HASH",
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/operator policy changed/);
  });
});
