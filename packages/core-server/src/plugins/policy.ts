// Operator policy loading, package hashing, source classification, and the
// manifest<->policy cross-check. These moved to @vonzio/plugin-api/policy (a
// Node-only submodule) in PR 3J.2 so the dashboard's build-time Vite plugin and
// this runtime loader share ONE byte-identical hashPackageDir — the dashboard
// parity check depends on the hashes matching exactly. This file re-exports so
// existing importers (loader, cli, parity-check, tests) are unchanged.

export {
  findRepoRoot,
  hashPackageDir,
  classifySource,
  loadPolicies,
  crossCheckPolicy,
} from "@vonzio/plugin-api/policy";
export type {
  LoadedPolicies,
  LoadPoliciesOpts,
  CrossCheckArgs,
  CrossCheckResult,
} from "@vonzio/plugin-api/policy";
