// `vonzio plugin` CLI: approve an installed external plugin into the operator
// policy file, diff changes since last approval, and dry-run the loader
// validation (`--list-plugins`). See docs/PLUGIN_LOADER_SPEC.md §4, §6.
//
// Run: npx tsx packages/core-server/src/plugins/cli.ts <subcommand> [args]
//
// The pure pieces (buildApprovalEntry, diffApproval, dry-run validation) are
// exported + unit-tested; the interactive prompts in main() are a thin shell.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  validateManifest,
  validatePolicy,
  BUILTIN_ONLY_CAPABILITIES,
  ROOT_EQUIVALENT_COMBINATIONS,
  assertApiCompatible,
  PLUGIN_API_VERSION,
  type OperatorPolicy,
  type PluginManifest,
  type PolicyEntry,
} from "@vonzio/plugin-api";
import { resolvePackageRoot } from "./loader.js";
import {
  hashPackageDir,
  classifySource,
  crossCheckPolicy,
  findRepoRoot,
  loadPolicies,
} from "./policy.js";

/** Resolve + validate an installed plugin's manifest for the CLI. Throws a
 *  human-readable error on any problem. */
export function inspectPlugin(packageName: string): {
  manifest: PluginManifest;
  version: string;
  realRoot: string;
  hash: string;
} {
  const { realRoot, version, manifestRaw } = resolvePackageRoot(packageName);
  const res = validateManifest(manifestRaw);
  if (!res.ok) throw new Error(`${packageName}: invalid manifest — ${res.message}`);
  assertApiCompatible(res.manifest.apiVersion, PLUGIN_API_VERSION);
  return { manifest: res.manifest, version, realRoot, hash: hashPackageDir(realRoot) };
}

export interface BuildApprovalArgs {
  manifest: PluginManifest;
  version: string;
  hash: string;
  frontend: boolean;
  approvedBy?: string;
  reason?: string;
  approvedAt?: string;
}

/**
 * Build a policy entry from an inspected plugin. Refuses the approvals the
 * loader would reject at boot anyway (§4): db.access (built-in only) and the
 * root-equivalent capability combinations — no override for v1.
 */
export function buildApprovalEntry(args: BuildApprovalArgs): PolicyEntry {
  const caps = args.manifest.capabilities;
  for (const cap of caps) {
    if (BUILTIN_ONLY_CAPABILITIES.has(cap)) {
      throw new Error(`Refusing to approve ${cap}: built-in-only capability (the loader refuses it for external plugins).`);
    }
  }
  for (const combo of ROOT_EQUIVALENT_COMBINATIONS) {
    if (combo.every((c) => caps.includes(c))) {
      throw new Error(
        `Refusing to approve the root-equivalent combination ${combo.join(" + ")}. ` +
          `v1 has no override; reshape the plugin to request less.`,
      );
    }
  }
  if (args.manifest.frontendEntry && args.frontend) {
    // allowed — operator explicitly granted frontend
  }
  return {
    version: args.version,
    approved_hash_sha256: args.hash,
    approved_capabilities: [...caps],
    approved_outbound_hosts: [...(args.manifest.outboundHosts ?? [])],
    ...(args.manifest.frontendEntry && args.frontend ? { approved_frontend: true } : {}),
    ...(args.approvedAt ? { approved_at: args.approvedAt } : {}),
    ...(args.approvedBy ? { approved_by: args.approvedBy } : {}),
    ...(args.reason ? { approval_reason: args.reason } : {}),
  };
}

/** Human-readable diff between an existing approval and a freshly inspected
 *  plugin (capability/host/version/hash deltas). Empty array = no change. */
export function diffApproval(
  prev: PolicyEntry,
  next: { manifest: PluginManifest; version: string; hash: string },
): string[] {
  const lines: string[] = [];
  if (prev.version !== next.version) lines.push(`version: ${prev.version} -> ${next.version}`);
  if (prev.approved_hash_sha256 !== next.hash) {
    lines.push(`hash: ${prev.approved_hash_sha256.slice(0, 8)} -> ${next.hash.slice(0, 8)}`);
  }
  const prevCaps = new Set(prev.approved_capabilities);
  const nextCaps = new Set(next.manifest.capabilities);
  const addedCaps = next.manifest.capabilities.filter((c) => !prevCaps.has(c));
  const removedCaps = prev.approved_capabilities.filter((c) => !nextCaps.has(c));
  for (const c of addedCaps) lines.push(`capability + ${c} (NEW — review)`);
  for (const c of removedCaps) lines.push(`capability - ${c} (removed)`);
  const prevHosts = new Set(prev.approved_outbound_hosts);
  for (const h of next.manifest.outboundHosts ?? []) {
    if (!prevHosts.has(h)) lines.push(`outbound + ${h} (NEW host — review)`);
  }
  return lines;
}

export function loadPolicyFile(policyPath: string): OperatorPolicy {
  if (!existsSync(policyPath)) return { policy_version: "1", plugins: {} };
  return validatePolicy(JSON.parse(readFileSync(policyPath, "utf8")), path.basename(policyPath));
}

export function writePolicyFile(policyPath: string, policy: OperatorPolicy): void {
  writeFileSync(policyPath, JSON.stringify(policy, null, 2) + "\n");
}

function resolvePolicyPath(): string {
  return process.env.VONZIO_PLUGIN_POLICY ?? path.join(process.cwd(), "vonzio-plugins.json");
}

// ── Dry-run validation (`vonzio plugin list` / --list-plugins) ───────────────

export interface DryRunResult {
  name: string;
  ok: boolean;
  source?: string;
  hash?: string;
  capabilities?: string[];
  outboundHosts?: string[];
  frontend?: boolean;
  refusal?: { reason: string; message: string };
}

/** Validate a single plugin without importing it or touching services. */
export function dryRunValidate(packageName: string, repoRoot: string, operatorPolicyPath?: string): DryRunResult {
  const policies = loadPolicies({ repoRoot, operatorPolicyPath });
  try {
    const { realRoot, version, manifestRaw } = resolvePackageRoot(packageName);
    const res = validateManifest(manifestRaw);
    if (!res.ok) return { name: packageName, ok: false, refusal: { reason: res.reason, message: res.message } };
    const manifest = res.manifest;
    const source = classifySource(realRoot, repoRoot, policies.builtinNames, packageName);
    const hash = hashPackageDir(realRoot);
    const cc = crossCheckPolicy({
      packageName,
      manifest,
      entry: policies.entryFor(packageName),
      installedVersion: version,
      installedHash: hash,
      trackVersions: process.env.VONZIO_PLUGIN_POLICY_TRACK_VERSIONS === "loose" ? "loose" : "strict",
      source,
    });
    if (!cc.ok) return { name: packageName, ok: false, source, hash, refusal: { reason: cc.reason, message: cc.message } };
    return {
      name: packageName,
      ok: true,
      source,
      hash,
      capabilities: cc.grantedCapabilities,
      outboundHosts: cc.grantedOutboundHosts,
      frontend: cc.frontendApproved,
    };
  } catch (err) {
    return { name: packageName, ok: false, refusal: { reason: "package_unresolvable", message: err instanceof Error ? err.message : String(err) } };
  }
}

// ── Interactive shell ───────────────────────────────────────────────────────

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

function parseFlags(args: string[]): { positionals: string[]; flags: Record<string, string | boolean> } {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key === "reason") flags.reason = args[++i] ?? "";
      else flags[key] = true;
    } else positionals.push(a);
  }
  return { positionals, flags };
}

export async function runPluginCli(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const { positionals, flags } = parseFlags(rest);

  if (sub === "list" || flags["list-plugins"]) {
    const repoRoot = findRepoRoot();
    const names = (process.env.VONZIO_PLUGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const name of names) {
      const r = dryRunValidate(name.replace(/@[^/@]+$/, ""), repoRoot);
      if (r.ok) {
        console.log(`✓ ${r.name} [${r.source}] ${r.hash?.slice(0, 12)}`);
        console.log(`    capabilities: ${r.capabilities?.join(", ")}`);
        if (r.outboundHosts?.length) console.log(`    outbound:     ${r.outboundHosts.join(", ")}`);
        console.log(`    frontend:     ${r.frontend ? "approved" : "no"}`);
      } else {
        console.log(`✗ ${r.name} REFUSED [${r.refusal?.reason}] ${r.refusal?.message}`);
      }
    }
    return 0;
  }

  if (sub === "approve") {
    const name = positionals[0];
    if (!name) {
      console.error("usage: vonzio plugin approve <name> [--frontend|--no-frontend] [--reason \"...\"] [--yes]");
      return 2;
    }
    const inspected = inspectPlugin(name);
    const policyPath = resolvePolicyPath();
    const policy = loadPolicyFile(policyPath);
    const prev = policy.plugins[name];

    console.log(`${name}@${inspected.version}`);
    console.log(`  hash:         sha256:${inspected.hash.slice(0, 16)}…`);
    console.log(`  capabilities: ${inspected.manifest.capabilities.join(", ")}`);
    if (inspected.manifest.outboundHosts?.length) {
      console.log(`  outbound:     ${inspected.manifest.outboundHosts.join(", ")}`);
    }
    console.log(`  frontend:     ${inspected.manifest.frontendEntry ? `yes (${inspected.manifest.frontendEntry})` : "no"}`);
    if (prev) {
      const d = diffApproval(prev, inspected);
      if (d.length) console.log(`\n  changes since last approval:\n${d.map((l) => `    ${l}`).join("\n")}`);
    }

    const yes = flags.yes === true;
    if (!yes && !(await confirm("\nApprove backend (membrane + scoped capabilities + audited outbound)?"))) {
      console.log("aborted.");
      return 1;
    }

    let frontend = false;
    if (inspected.manifest.frontendEntry) {
      if (flags.frontend) frontend = true;
      else if (flags["no-frontend"]) frontend = false;
      else if (!yes) {
        console.log(
          "\nThis plugin includes frontend code that will run in your dashboard origin with full DOM,\n" +
            "localStorage, cookie, and credentialed-fetch access. v1 has no DOM sandbox.",
        );
        frontend = await confirm("Approve frontend bundling?");
      }
    }

    const entry = buildApprovalEntry({
      manifest: inspected.manifest,
      version: inspected.version,
      hash: inspected.hash,
      frontend,
      approvedBy: process.env.USER,
      reason: typeof flags.reason === "string" ? flags.reason : undefined,
    });
    policy.plugins[name] = entry;
    writePolicyFile(policyPath, policy);
    console.log(`\n✓ Wrote ${policyPath} (approved_frontend: ${entry.approved_frontend === true}).`);
    console.log(`  Re-run vonzio with VONZIO_PLUGINS including ${name}.`);
    return 0;
  }

  if (sub === "diff") {
    const name = positionals[0];
    if (!name) {
      console.error("usage: vonzio plugin diff <name>");
      return 2;
    }
    const inspected = inspectPlugin(name);
    const policy = loadPolicyFile(resolvePolicyPath());
    const prev = policy.plugins[name];
    if (!prev) {
      console.log(`${name}: not yet approved.`);
      return 0;
    }
    const d = diffApproval(prev, inspected);
    console.log(d.length ? d.join("\n") : `${name}: no changes since approval.`);
    return 0;
  }

  console.error("usage: vonzio plugin <approve|diff|list> ...");
  return 2;
}

// Direct-run entrypoint.
if (import.meta.url === `file://${process.argv[1]}`) {
  runPluginCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
