// Attack corpus. Each test is named after a
// corpus case and asserts its DOCUMENTED OUTCOME: a refusal where the gate
// refuses, the audit/observability signal where the gate is informational, or
// the documented limitation where the loader cannot prevent the attack. The
// informational/limitation cases are NOT security guarantees — they are the
// loader's honest contract (§2).
//
// The worked "good" example plugin lives at examples/plugin-hello/; the attack
// source modules (illustrative) at examples/plugin-hello-attacks/. This file is
// the RUNNABLE regression suite that drives the real gate functions — any
// future loader refactor must keep every assertion below green.

import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import pg from "pg";
import { assembleCore } from "./membrane.js";
import { scopedDb } from "./scoped-db.js";
import { makePluginHttp } from "./http.js";
import { crossCheckPolicy } from "./policy.js";
import { snapshotIntrinsics, diffIntrinsics } from "./audit.js";
import { validateManifest } from "@vonzio/plugin-api";
import {
  CapabilityViolationError,
  DbScopeViolationError,
  OutboundHostViolationError,
  ROOT_EQUIVALENT_COMBINATIONS,
  type PluginCapability,
  type PluginCore,
  type PluginManifest,
  type PolicyEntry,
} from "@vonzio/plugin-api";
import { SsrfBlockedError } from "../lib/safe-webhook-fetch.js";

const grant = (...c: PluginCapability[]) => new Set<PluginCapability>(c);
const fullCore = () =>
  ({
    db: { __raw: true },
    tasks: { submit: async () => ({ task_id: "t", status: "ok", created_at: "" }) },
    integrations: { get: async () => null },
  }) as unknown as PluginCore;

describe("attack corpus §12 — membrane", () => {
  it("attempt-undeclared-capability: reading core.db with only storage.kv throws", () => {
    const { core } = assembleCore(fullCore(), { pluginName: "atk", granted: grant("tasks.submit") });
    expect(() => (core as unknown as { db: unknown }).db).toThrow(CapabilityViolationError);
  });

  it("attempt-membrane-bypass-reflect: Reflect.ownKeys exposes only declared surfaces", () => {
    const { core } = assembleCore(fullCore(), { pluginName: "atk", granted: grant("tasks.submit") });
    expect(Reflect.ownKeys(core)).toEqual(["tasks"]);
  });

  it("attempt-membrane-bypass-spread: {...core} leaks only declared surfaces", () => {
    const { core } = assembleCore(fullCore(), { pluginName: "atk", granted: grant("tasks.submit") });
    expect(Object.keys({ ...core })).toEqual(["tasks"]);
  });

  it("attempt-membrane-bypass-bind: a granted method works; undeclared stays blocked", () => {
    const { core } = assembleCore(fullCore(), { pluginName: "atk", granted: grant("tasks.submit") });
    const bound = core.tasks.submit.bind(null);
    expect(typeof bound).toBe("function");
    expect(() => (core as unknown as { db: unknown }).db).toThrow(CapabilityViolationError);
  });
});

describe("attack corpus §12 — scoped DB", () => {
  const helloT = pgTable("hello_items", { id: text("id").primaryKey() });
  const usersT = pgTable("users", { id: text("id").primaryKey() });
  const pool = new pg.Pool({ connectionString: "postgres://u:u@127.0.0.1:1/none" });
  const db = scopedDb(drizzle(pool), "hello", "hello");

  it("attempt-db-cross-schema: .from(users) throws DbScopeViolationError", () => {
    expect(() => db.select().from(usersT)).toThrow(DbScopeViolationError);
  });
  it("attempt-db-raw-sql: db.execute refused for db.scoped", () => {
    expect(() => (db as unknown as { execute: () => void }).execute()).toThrow(DbScopeViolationError);
  });
  it("attempt-db-cross-schema-via-join: leftJoin(users) throws", () => {
    expect(() => db.select().from(helloT).leftJoin(usersT, eq(helloT.id, usersT.id))).toThrow(
      DbScopeViolationError,
    );
  });
  it("attempt-db-cross-schema-via-cte: a CTE selecting another schema throws at build", () => {
    const cte = (db as unknown as { $with: (n: string) => { as: (q: unknown) => unknown } }).$with("c");
    expect(() => cte.as(db.select().from(usersT))).toThrow(DbScopeViolationError);
  });
});

describe("attack corpus §12 — outbound HTTP", () => {
  it("attempt-outbound-undeclared-host: fetching evil.com throws OutboundHostViolationError", async () => {
    const http = makePluginHttp({ pluginName: "atk", grantedHosts: ["slack.com"] });
    await expect(http.fetch("https://evil.com")).rejects.toBeInstanceOf(OutboundHostViolationError);
  });
  it("attempt-outbound-private-ip: a declared-but-private host is SSRF-blocked", async () => {
    const http = makePluginHttp({ pluginName: "atk", grantedHosts: ["169.254.169.254"] });
    await expect(http.fetch("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
  });
});

describe("attack corpus §12 — policy / manifest gates", () => {
  const manifest: PluginManifest = {
    apiVersion: "1.0",
    backendEntry: "./dist/index.js",
    capabilities: ["storage.kv", "http.outbound"],
    outboundHosts: ["api.example.com"],
  };
  const entry: PolicyEntry = {
    version: "1.0.0",
    approved_hash_sha256: "hash1",
    approved_capabilities: ["storage.kv", "http.outbound"],
    approved_outbound_hosts: ["api.example.com"],
  };
  const args = { packageName: "x", manifest, entry, installedVersion: "1.0.0", installedHash: "hash1" as string };

  it("attempt-policy-missing-capability: capability drift is refused", () => {
    const m = { ...manifest, capabilities: [...manifest.capabilities, "db.scoped"] as PluginCapability[], schemaPrefix: "x" };
    expect(crossCheckPolicy({ ...args, manifest: m, source: "external" })).toMatchObject({
      ok: false,
      reason: "policy_capability_drift",
    });
  });
  it("attempt-policy-hash-mismatch: edited package after approval is refused (external)", () => {
    expect(crossCheckPolicy({ ...args, installedHash: "tampered", source: "external" })).toMatchObject({
      ok: false,
      reason: "policy_hash_mismatch",
    });
  });
  it("attempt-frontend-entry-external-unapproved: refused with approve --frontend hint", () => {
    const m = { ...manifest, frontendEntry: "./dist/frontend.js" };
    const r = crossCheckPolicy({ ...args, manifest: m, source: "external" });
    expect(r).toMatchObject({ ok: false, reason: "unapproved_frontend" });
    if (!r.ok) expect(r.remediation).toContain("--frontend");
  });
  it("attempt-frontend-entry-external-approved: loads when policy approves the frontend", () => {
    const m = { ...manifest, frontendEntry: "./dist/frontend.js" };
    const e = { ...entry, approved_frontend: true };
    expect(crossCheckPolicy({ ...args, manifest: m, entry: e, source: "external" }).ok).toBe(true);
  });
  it("attempt-root-combination: the root-equivalent pair is in the refusal set", () => {
    // The loader refuses this pre-import for external plugins; the rule itself:
    const rootPair = ["integrations.read.decrypted", "db.scoped"];
    expect(ROOT_EQUIVALENT_COMBINATIONS.some((c) => rootPair.every((x) => c.includes(x as PluginCapability)))).toBe(
      true,
    );
  });
  it("attempt-manifest-typo: an unknown manifest field is rejected (ungated-typo guard)", () => {
    expect(validateManifest({ ...manifest, capabilites: ["storage.kv"] })).toMatchObject({ ok: false });
  });
});

describe("attack corpus §12 — informational / documented limitations", () => {
  it("attempt-prototype-pollution: detected by the intrinsics snapshot; boot continues", () => {
    const before = snapshotIntrinsics();
    (Object.prototype as Record<string, unknown>).__atk = 1;
    try {
      expect(diffIntrinsics(before, snapshotIntrinsics())).toContain("Object.prototype mutated");
    } finally {
      delete (Object.prototype as Record<string, unknown>).__atk;
    }
    // No throw: the detection logs loudly but never refuses (§2.10, §14).
  });

  it("attempt-import-time-side-effect: NOT prevented (documented limitation §2, §12)", () => {
    // The loader's pre-import validation cannot stop top-level side effects in
    // an ACCEPTED plugin's entry — it only closes the window for REJECTED ones.
    // Asserting the honest contract: there is no gate here.
    expect(true).toBe(true);
  });

  // Deferred to PR 3J.2 (frontend bundling + CSP): attempt-dashboard-csp-bypass,
  // attempt-dev-server-unapproved-frontend. Not implemented in v1 backend:
  // attempt-outbound-websocket-undeclared (PluginHttp exposes fetch only).
});
