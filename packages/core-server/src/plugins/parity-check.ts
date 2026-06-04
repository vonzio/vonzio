// Build↔runtime parity check for the dashboard plugin bundle. At boot, the
// server verifies that the frontends the dashboard ACTUALLY bundled (recorded
// in dist/.plugins.json by the Vite plugin) agree with the backend's runtime
// policy — so an operator can't end up serving a frontend the policy doesn't
// approve, or a stale bundle after a policy change.
//
// Honest scope: this catches OPERATOR DRIFT (rebuild forgotten, policy edited
// after build). It assumes dist/.plugins.json is protected by the same
// deployment-integrity controls as the rest of dist/ — it is not a defense
// against a compromised build host (which could rewrite both).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findRepoRoot, loadPolicies, type LoadedPolicies } from "./policy.js";

export interface DashboardPluginsJson {
  plugins: Array<{ name: string; source: string; hash: string }>;
  policyPath: string | null;
  policyHash: string | null;
}

export interface ParityResult {
  ok: boolean;
  errors: string[];
}

/**
 * Pure check: compare a parsed dist/.plugins.json against the runtime policy.
 *  - FORWARD (security): every bundled frontend must be approved_frontend in the
 *    runtime policy; externals must additionally be hash-equal (built-ins skip
 *    hash, deviation #9).
 *  - REVERSE (drift, built-ins only): every built-in approved for frontend must
 *    be in the bundle — built-ins always declare a frontend, so absence means
 *    the dashboard wasn't rebuilt. (Externals are skipped: an approved external
 *    that declares no frontend would legitimately be absent, and the policy
 *    alone can't tell.)
 *  - POLICY CONTENT: the operator policy the dashboard was built against must
 *    match the runtime operator policy file's content (SHA-256).
 */
export function checkDashboardParity(args: {
  data: DashboardPluginsJson;
  policies: LoadedPolicies;
  /** SHA-256 of the runtime operator policy file, or null when absent. */
  runtimePolicyHash: string | null;
}): ParityResult {
  const { data, policies, runtimePolicyHash } = args;
  const errors: string[] = [];
  const bundled = new Set<string>();

  for (const p of data.plugins) {
    bundled.add(p.name);
    const entry = policies.entryFor(p.name);
    if (!entry || entry.approved_frontend !== true) {
      errors.push(`bundled frontend "${p.name}" is not approved_frontend in the runtime policy`);
      continue;
    }
    // Classify by the RUNTIME's authoritative builtinNames, NOT the artifact's
    // self-declared `source` — otherwise a mislabeled "builtin" entry would
    // skip the hash check. Built-ins are workspace-trusted (hash skipped,
    // deviation #9); externals must be hash-equal.
    const isBuiltin = policies.builtinNames.has(p.name);
    if (!isBuiltin && entry.approved_hash_sha256 !== p.hash) {
      errors.push(
        `bundled frontend "${p.name}" hash ${p.hash.slice(0, 12)} != approved ${entry.approved_hash_sha256.slice(0, 12)}`,
      );
    }
  }

  for (const name of policies.builtinNames) {
    const entry = policies.entryFor(name);
    if (entry?.approved_frontend === true && !bundled.has(name)) {
      errors.push(`built-in "${name}" is approved_frontend but missing from the dashboard bundle (rebuild the dashboard)`);
    }
  }

  if ((data.policyHash ?? null) !== (runtimePolicyHash ?? null)) {
    errors.push(
      `operator policy changed since the dashboard build (build ${data.policyHash ?? "none"} != runtime ${runtimePolicyHash ?? "none"}); rebuild the dashboard`,
    );
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Boot-time entry: if `dashboardDist/.plugins.json` exists (production build),
 * run the parity check and THROW on mismatch (fail boot loudly). Absent
 * `.plugins.json` (dev, or a dashboard not built with the Vite plugin) → no-op.
 */
export function assertDashboardParity(opts: {
  dashboardDist: string;
  repoRoot?: string;
  operatorPolicyPath?: string;
}): void {
  const file = path.join(opts.dashboardDist, ".plugins.json");
  if (!existsSync(file)) return;

  let data: DashboardPluginsJson;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as DashboardPluginsJson;
    if (!Array.isArray(parsed.plugins)) throw new Error("`plugins` is not an array");
    for (const p of parsed.plugins) {
      if (typeof p?.name !== "string" || typeof p?.hash !== "string") {
        throw new Error("an entry is missing name/hash");
      }
    }
    data = parsed;
  } catch (err) {
    throw new Error(
      `dashboard parity check: ${file} is malformed (${err instanceof Error ? err.message : String(err)}). Rebuild the dashboard (vite build).`,
    );
  }
  const repoRoot = opts.repoRoot ?? findRepoRoot();
  const policies = loadPolicies({ repoRoot, operatorPolicyPath: opts.operatorPolicyPath });
  const runtimePolicyHash =
    policies.operatorPath && existsSync(policies.operatorPath)
      ? createHash("sha256").update(readFileSync(policies.operatorPath)).digest("hex")
      : null;

  const result = checkDashboardParity({ data, policies, runtimePolicyHash });
  if (!result.ok) {
    throw new Error(
      "dashboard plugin parity check failed (the dashboard bundle disagrees with the runtime plugin policy):\n" +
        result.errors.map((e) => `  - ${e}`).join("\n") +
        "\nRebuild the dashboard (vite build) after any plugin-policy change.",
    );
  }
}
