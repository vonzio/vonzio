// Operator policy loading, package-directory hashing, builtin/external source
// classification, and the manifest<->policy cross-check. The loader (C9)
// composes these with the manifest validators from @vonzio/plugin-api to run
// the §3 validation pipeline. See docs/PLUGIN_LOADER_SPEC.md §3, §4.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  validatePolicy,
  type OperatorPolicy,
  type PluginCapability,
  type PluginManifest,
  type PluginSource,
  type PolicyEntry,
  type RefusalReason,
} from "@vonzio/plugin-api";

/**
 * Walk up from this module's location to the monorepo root — the nearest
 * ancestor package.json declaring a `workspaces` field. Robust to the
 * process cwd (operators may launch from a subdir). Falls back to cwd.
 */
export function findRepoRoot(startDir?: string): string {
  let dir = startDir ?? path.dirname(fileURLToPath(import.meta.url));
  // Bound the walk so a missing root can't loop to filesystem root forever.
  for (let i = 0; i < 12; i++) {
    const pkg = path.join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { workspaces?: unknown };
        if (parsed.workspaces) return dir;
      } catch {
        // ignore malformed package.json while walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * SHA-256 (hex) of a package directory, excluding any `node_modules` subtree.
 * Stable: files are visited in sorted relative-path order and each file's
 * path + bytes are folded into the digest with separators, so the hash is
 * insensitive to readdir ordering but sensitive to any content/path change.
 * This is the operator-attested hash recorded in the policy file (§4).
 */
export function hashPackageDir(root: string): string {
  const realRoot = path.resolve(root);
  const files: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === "node_modules") continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.isFile()) {
        files.push(path.relative(realRoot, abs));
      }
      // symlinks and other types are skipped (a package dir should not rely
      // on them for its hashed content)
    }
  };
  walk(realRoot);
  files.sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    // POSIX-normalize the path separator so the hash matches across OSes.
    hash.update(rel.split(path.sep).join("/"));
    hash.update("\0");
    hash.update(readFileSync(path.join(realRoot, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Classify a resolved (realpath'd) package as builtin or external.
 *
 * Builtin ⇔ the real package root is a child of `<repoRoot>/packages/` AND the
 * package name appears in the shipped builtins policy. Everything else is
 * external. The name-in-builtins requirement (not just "inside packages/") is
 * what stops an `npm link`/`file:` external whose realpath lands outside
 * node_modules from being misclassified as a trusted builtin (deviation #3).
 */
export function classifySource(
  realPackageRoot: string,
  repoRoot: string,
  builtinNames: ReadonlySet<string>,
  packageName: string,
): PluginSource {
  const packagesDir = path.join(path.resolve(repoRoot), "packages") + path.sep;
  const inPackages = path.resolve(realPackageRoot).startsWith(packagesDir);
  return inPackages && builtinNames.has(packageName) ? "builtin" : "external";
}

export interface LoadedPolicies {
  /** Shipped builtins policy (always present; empty if the file is absent). */
  builtins: OperatorPolicy;
  /** Operator policy (null when no file is configured/found). */
  operator: OperatorPolicy | null;
  /** Resolved policy-file path actually read (for audit/parity), or null. */
  operatorPath: string | null;
  /** Set of builtin package names (keys of the builtins policy). */
  builtinNames: ReadonlySet<string>;
  /** Look up the effective entry for a package: operator wins over builtins. */
  entryFor(packageName: string): PolicyEntry | null;
}

export interface LoadPoliciesOpts {
  repoRoot: string;
  /** Override for the operator policy path; defaults to $VONZIO_PLUGIN_POLICY
   *  then `<cwd>/vonzio-plugins.json`. */
  operatorPolicyPath?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Load + validate the shipped builtins policy and the operator policy. A
 * malformed file throws PolicyViolationError (operator-owned config — fail
 * loud). Absent files are tolerated (builtins → empty; operator → null).
 */
export function loadPolicies(opts: LoadPoliciesOpts): LoadedPolicies {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  const builtinsPath = path.join(opts.repoRoot, "vonzio-plugins.builtins.json");
  const builtins: OperatorPolicy = existsSync(builtinsPath)
    ? validatePolicy(JSON.parse(readFileSync(builtinsPath, "utf8")), "vonzio-plugins.builtins.json")
    : { policy_version: "1", plugins: {} };

  const operatorPath =
    opts.operatorPolicyPath ??
    env.VONZIO_PLUGIN_POLICY ??
    path.join(cwd, "vonzio-plugins.json");
  const operator: OperatorPolicy | null = existsSync(operatorPath)
    ? validatePolicy(JSON.parse(readFileSync(operatorPath, "utf8")), path.basename(operatorPath))
    : null;

  const builtinNames = new Set(Object.keys(builtins.plugins));

  return {
    builtins,
    operator,
    operatorPath: existsSync(operatorPath) ? operatorPath : null,
    builtinNames,
    entryFor(packageName: string): PolicyEntry | null {
      return operator?.plugins[packageName] ?? builtins.plugins[packageName] ?? null;
    },
  };
}

export type CrossCheckResult =
  | {
      ok: true;
      grantedCapabilities: PluginCapability[];
      grantedOutboundHosts: string[];
      frontendApproved: boolean;
    }
  | { ok: false; reason: RefusalReason; message: string; remediation?: string; detail?: Record<string, unknown> };

export interface CrossCheckArgs {
  packageName: string;
  manifest: PluginManifest;
  entry: PolicyEntry | null;
  /** Installed package version (from package.json "version"). */
  installedVersion: string;
  /** Hash of the installed package directory (hashPackageDir). */
  installedHash: string;
  /** "strict" (default) requires version-string equality; "loose" relaxes it
   *  to "hash match is authoritative" (VONZIO_PLUGIN_POLICY_TRACK_VERSIONS). */
  trackVersions?: "strict" | "loose";
}

/**
 * The §3 step-16 policy cross-check: hash match, version match, capability
 * subset, outbound-host subset, frontend approval. Returns the granted sets
 * on success or a refusal with the §11 reason code. The external-only
 * capability rules (db.access, db.scoped opt-in, root combos) are applied
 * SEPARATELY by the loader before this (§3 steps 7-9).
 */
export function crossCheckPolicy(args: CrossCheckArgs): CrossCheckResult {
  const { packageName, manifest, entry, installedVersion, installedHash } = args;
  const trackVersions = args.trackVersions ?? "strict";

  if (!entry) {
    return {
      ok: false,
      reason: "policy_missing",
      message: `No operator policy entry for "${packageName}". Approve it before loading.`,
      remediation: `run: vonzio plugin approve ${packageName}`,
    };
  }

  if (entry.approved_hash_sha256 !== installedHash) {
    return {
      ok: false,
      reason: "policy_hash_mismatch",
      message: `Installed package hash for "${packageName}" does not match the approved hash. The package was modified since approval, or tampered with.`,
      remediation: `re-review and run: vonzio plugin approve ${packageName}`,
      detail: { approved: entry.approved_hash_sha256, installed: installedHash },
    };
  }

  if (trackVersions === "strict" && entry.version !== installedVersion) {
    return {
      ok: false,
      reason: "policy_version_mismatch",
      message: `Installed version ${installedVersion} of "${packageName}" differs from the approved version ${entry.version}.`,
      remediation: `run: vonzio plugin approve ${packageName} (or set VONZIO_PLUGIN_POLICY_TRACK_VERSIONS=loose)`,
      detail: { approved: entry.version, installed: installedVersion },
    };
  }

  const approvedCaps = new Set(entry.approved_capabilities);
  const capDrift = manifest.capabilities.filter((c) => !approvedCaps.has(c));
  if (capDrift.length) {
    return {
      ok: false,
      reason: "policy_capability_drift",
      message: `"${packageName}" requests capabilities not in the approved set: ${capDrift.join(", ")}`,
      remediation: `re-review and run: vonzio plugin approve ${packageName}`,
      detail: { requested: manifest.capabilities, approved: entry.approved_capabilities, drift: capDrift },
    };
  }

  const approvedHosts = new Set(entry.approved_outbound_hosts);
  const hostDrift = (manifest.outboundHosts ?? []).filter((h) => !approvedHosts.has(h));
  if (hostDrift.length) {
    return {
      ok: false,
      reason: "policy_outbound_host_drift",
      message: `"${packageName}" requests outbound hosts not in the approved set: ${hostDrift.join(", ")}`,
      remediation: `re-review and run: vonzio plugin approve ${packageName}`,
      detail: { requested: manifest.outboundHosts ?? [], approved: entry.approved_outbound_hosts, drift: hostDrift },
    };
  }

  if (manifest.frontendEntry && entry.approved_frontend !== true) {
    return {
      ok: false,
      reason: "unapproved_frontend",
      message: `"${packageName}" declares a frontend but the operator policy has not approved frontend bundling.`,
      remediation: `run: vonzio plugin approve --frontend ${packageName}`,
    };
  }

  return {
    ok: true,
    grantedCapabilities: [...manifest.capabilities],
    grantedOutboundHosts: [...(manifest.outboundHosts ?? [])],
    frontendApproved: entry.approved_frontend === true,
  };
}
