import { describe, it, expect } from "vitest";
import { buildApprovalEntry, diffApproval } from "./cli.js";
import type { PluginManifest, PolicyEntry } from "@vonzio/plugin-api";

const manifest: PluginManifest = {
  apiVersion: "1.0",
  backendEntry: "./dist/index.js",
  capabilities: ["storage.kv", "http.outbound"],
  outboundHosts: ["api.example.com"],
};

describe("buildApprovalEntry", () => {
  it("builds an entry from manifest + hash", () => {
    const e = buildApprovalEntry({ manifest, version: "0.1.0", hash: "abc", frontend: false });
    expect(e).toMatchObject({
      version: "0.1.0",
      approved_hash_sha256: "abc",
      approved_capabilities: ["storage.kv", "http.outbound"],
      approved_outbound_hosts: ["api.example.com"],
    });
    expect(e.approved_frontend).toBeUndefined();
  });

  it("sets approved_frontend only when frontend declared AND granted", () => {
    const m = { ...manifest, frontendEntry: "./dist/frontend.js" };
    expect(buildApprovalEntry({ manifest: m, version: "0.1.0", hash: "a", frontend: true }).approved_frontend).toBe(true);
    expect(buildApprovalEntry({ manifest: m, version: "0.1.0", hash: "a", frontend: false }).approved_frontend).toBeUndefined();
  });

  it("refuses db.access (built-in only)", () => {
    const m: PluginManifest = { ...manifest, capabilities: ["db.access"], schemaPrefix: "x" };
    expect(() => buildApprovalEntry({ manifest: m, version: "0.1.0", hash: "a", frontend: false })).toThrow(
      /built-in-only/,
    );
  });

  it("refuses the root-equivalent combination", () => {
    const m: PluginManifest = {
      ...manifest,
      capabilities: ["integrations.read.decrypted", "db.scoped"],
      schemaPrefix: "x",
    };
    expect(() => buildApprovalEntry({ manifest: m, version: "0.1.0", hash: "a", frontend: false })).toThrow(
      /root-equivalent/,
    );
  });

  it("records reason + approvedBy when provided", () => {
    const e = buildApprovalEntry({
      manifest,
      version: "0.1.0",
      hash: "a",
      frontend: false,
      reason: "audited 2026-06-03",
      approvedBy: "amen",
    });
    expect(e.approval_reason).toBe("audited 2026-06-03");
    expect(e.approved_by).toBe("amen");
  });
});

describe("diffApproval", () => {
  const prev: PolicyEntry = {
    version: "0.1.0",
    approved_hash_sha256: "aaaa1111",
    approved_capabilities: ["storage.kv"],
    approved_outbound_hosts: [],
  };

  it("reports version, hash, capability, and host deltas", () => {
    const next = {
      manifest: { ...manifest, capabilities: ["storage.kv", "http.outbound"] as PluginManifest["capabilities"] },
      version: "0.2.0",
      hash: "bbbb2222",
    };
    const d = diffApproval(prev, next);
    expect(d.some((l) => l.includes("version: 0.1.0 -> 0.2.0"))).toBe(true);
    expect(d.some((l) => l.includes("hash:"))).toBe(true);
    expect(d.some((l) => l.includes("+ http.outbound"))).toBe(true);
    expect(d.some((l) => l.includes("+ api.example.com"))).toBe(true);
  });

  it("returns no lines when nothing changed", () => {
    const next = {
      manifest: { ...manifest, capabilities: ["storage.kv"] as PluginManifest["capabilities"], outboundHosts: [] },
      version: "0.1.0",
      hash: "aaaa1111",
    };
    expect(diffApproval(prev, next)).toEqual([]);
  });
});
