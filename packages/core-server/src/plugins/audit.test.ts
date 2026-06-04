import { describe, it, expect } from "vitest";
import {
  emitPluginLoaded,
  emitPluginRefused,
  pathFingerprint,
  snapshotIntrinsics,
  diffIntrinsics,
  withIntrinsicsCheck,
  type PluginLoadAudit,
  type AuditLogger,
} from "./audit.js";

function fakeLog(): AuditLogger & { calls: Array<{ level: string; obj: Record<string, unknown>; msg?: string }> } {
  const calls: Array<{ level: string; obj: Record<string, unknown>; msg?: string }> = [];
  return {
    calls,
    info: (obj, msg) => calls.push({ level: "info", obj, msg }),
    warn: (obj, msg) => calls.push({ level: "warn", obj, msg }),
    error: (obj, msg) => calls.push({ level: "error", obj, msg }),
  };
}

const audit: PluginLoadAudit = {
  name: "@vonzio/plugin-hello",
  version: "0.1.0",
  source: "external",
  realPath: "/srv/app/node_modules/@vonzio/plugin-hello",
  packageHashSha256: "9a7f3e",
  apiVersion: "1.0",
  capabilitiesDeclared: ["storage.kv", "http.outbound"],
  capabilitiesGranted: ["storage.kv", "http.outbound"],
  outboundHostsDeclared: ["hello.example.com"],
  outboundHostsGranted: ["hello.example.com"],
  mtlsSecrets: [],
  schemaPrefix: null,
  routePrefix: { kind: "auto" },
  frontendApproved: false,
};

describe("pathFingerprint", () => {
  it("abridges to last two segments + version by default", () => {
    expect(pathFingerprint("/srv/app/node_modules/@vonzio/plugin-hello", "0.1.0")).toBe(
      "@vonzio/plugin-hello@0.1.0",
    );
  });
  it("returns the full path when fullPaths=true", () => {
    expect(pathFingerprint("/srv/app/x/plugin", "0.1.0", true)).toBe("/srv/app/x/plugin");
  });
});

describe("emit events", () => {
  it("emits a plugin loaded event with declared+granted split", () => {
    const log = fakeLog();
    emitPluginLoaded(log, audit);
    expect(log.calls[0].msg).toBe("plugin loaded");
    const p = log.calls[0].obj.plugin as Record<string, unknown>;
    expect(p.capabilities_declared).toEqual(["storage.kv", "http.outbound"]);
    expect(p.capabilities_granted).toEqual(["storage.kv", "http.outbound"]);
    expect(p.resolved_path_fingerprint).toBe("@vonzio/plugin-hello@0.1.0");
  });

  it("emits a refusal event with reason + remediation", () => {
    const log = fakeLog();
    emitPluginRefused(log, {
      pluginName: "@vonzio/plugin-foo",
      reason: "unapproved_frontend",
      message: "frontend not approved",
      remediation: "vonzio plugin approve --frontend @vonzio/plugin-foo",
    });
    expect(log.calls[0].level).toBe("warn");
    expect(log.calls[0].obj).toMatchObject({ reason: "unapproved_frontend" });
    expect(log.calls[0].msg).toBe("plugin refused");
  });
});

describe("intrinsics snapshot", () => {
  it("detects prototype pollution", () => {
    const before = snapshotIntrinsics();
    (Object.prototype as Record<string, unknown>).__vonzioEvil = 1;
    try {
      const diffs = diffIntrinsics(before, snapshotIntrinsics());
      expect(diffs).toContain("Object.prototype mutated");
    } finally {
      delete (Object.prototype as Record<string, unknown>).__vonzioEvil;
    }
  });

  it("detects new env keys", () => {
    const before = snapshotIntrinsics();
    process.env.__VONZIO_TEST_KEY = "1";
    try {
      const diffs = diffIntrinsics(before, snapshotIntrinsics());
      expect(diffs.some((d) => d.includes("__VONZIO_TEST_KEY"))).toBe(true);
    } finally {
      delete process.env.__VONZIO_TEST_KEY;
    }
  });

  it("reports no diff for an honest plugin", () => {
    const before = snapshotIntrinsics();
    const diffs = diffIntrinsics(before, snapshotIntrinsics());
    expect(diffs).toEqual([]);
  });

  it("withIntrinsicsCheck logs loudly but does NOT throw on tamper", async () => {
    const log = fakeLog();
    const result = await withIntrinsicsCheck(log, "p", () => {
      (Array.prototype as unknown as Record<string, unknown>).__vonzioEvil = 1;
      return 42;
    });
    delete (Array.prototype as unknown as Record<string, unknown>).__vonzioEvil;
    expect(result).toBe(42); // did not throw
    expect(log.calls.some((c) => c.level === "error" && /intrinsics tampering/.test(c.msg ?? ""))).toBe(true);
  });
});
