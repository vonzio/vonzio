// Static plugin manifest (the `vonzio` block in a plugin's package.json) and
// the operator policy file shapes. The loader reads + validates the manifest
// from disk BEFORE importing the plugin's entry point, and cross-checks it
// against the operator policy. See docs/PLUGIN_LOADER_SPEC.md §3, §4.
//
// These are the DECLARED shapes (plugin-author request + operator grant).
// The runtime `VonzioPlugin` default export (name, init, configSchema,
// migrations) is a separate object validated after import — see index.ts.

import type { PluginCapability } from "./capabilities.js";

/**
 * Where the plugin's routes live in the URL space.
 *  - `auto` (default): mount under a real Fastify child scope at
 *    `/plugins/<name>`.
 *  - `absolute`: legacy escape hatch for externally-registered URLs (Slack
 *    OAuth callback, Telegram webhook). v1 registers the child with NO scope
 *    prefix — the plugin uses full paths as before — and the prefix string is
 *    deny-list-checked + audit-logged. `prefix` may be a single string or an
 *    array for plugins spanning multiple legacy roots (Slack/Telegram each
 *    own `/v1/integrations/<name>` AND `/api/<name>`).
 */
export type ManifestRoutePrefix =
  | { kind: "auto" }
  | { kind: "absolute"; prefix: string | string[] };

/**
 * The `vonzio` block in a plugin package's package.json. Strictly validated
 * (unknown fields rejected) by validateManifest in manifest-validate.ts.
 */
export interface PluginManifest {
  /**
   * plugin-api semver this plugin targets. Loader refuses unless
   * `plugin.major === core.major && plugin.minor <= core.minor`.
   */
  apiVersion: string;
  /** Path to the backend bundle, relative to package root. Must be a real
   *  file inside (a child of) the package root after realpath. */
  backendEntry: string;
  /** Path to the frontend bundle. Built-ins: unconditional. Externals: only
   *  when the operator policy sets `approved_frontend: true`. (Frontend
   *  bundling itself is PR 3J.2; the manifest field + gate ship here.) */
  frontendEntry?: string;
  /** Declared capabilities. Each must be a known PluginCapability. */
  capabilities: PluginCapability[];
  /** Required + non-empty iff `http.outbound` is declared. Hostname patterns
   *  only — schemes/ports/paths/userinfo rejected; single-label `*` glob. */
  outboundHosts?: string[];
  /** Required iff `db.scoped` or `db.access` is declared. DB-safe identifier
   *  matching ^[a-z][a-z0-9_]{1,30}$. */
  schemaPrefix?: string;
  /** Route mounting strategy. Defaults to `{ kind: "auto" }` when absent. */
  routePrefix?: ManifestRoutePrefix;
}

/** Source of a loaded plugin. Drives the external-only validation rules. */
export type PluginSource = "builtin" | "external";

/**
 * One operator-policy entry — the operator's GRANT against a plugin's
 * manifest REQUEST. Strictly validated (unknown fields rejected) by
 * validatePolicy. See §4.
 */
export interface PolicyEntry {
  /** Plugin version the operator approved. Compared to the installed
   *  package version (unless TRACK_VERSIONS=loose). */
  version: string;
  /** SHA-256 of the package directory (excl. node_modules) at approval. */
  approved_hash_sha256: string;
  /** Manifest.capabilities must be a subset of this. */
  approved_capabilities: PluginCapability[];
  /** Manifest.outboundHosts must be a subset of this. May be empty. */
  approved_outbound_hosts: string[];
  /** Operator grant for the plugin's frontend to be bundled into the
   *  dashboard. Default false when absent. */
  approved_frontend?: boolean;
  /** ISO-8601 approval timestamp. */
  approved_at?: string;
  /** Operator identity (e.g. email). */
  approved_by?: string;
  /** Free-form rationale (from `--reason`); required for dangerous combos. */
  approval_reason?: string;
}

/**
 * The operator policy file (`vonzio-plugins.json`) and the shipped builtins
 * policy (`vonzio-plugins.builtins.json`) share this shape.
 */
export interface OperatorPolicy {
  /** Pinned to "1" for v1. */
  policy_version: string;
  /** Keyed by package name. */
  plugins: Record<string, PolicyEntry>;
}

/** Keys allowed in the manifest `vonzio` block — used by the strict
 *  validator to reject typos / smuggled fields. */
export const MANIFEST_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "apiVersion",
  "backendEntry",
  "frontendEntry",
  "capabilities",
  "outboundHosts",
  "schemaPrefix",
  "routePrefix",
]);

/** Keys allowed in one operator-policy entry. */
export const POLICY_ENTRY_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "version",
  "approved_hash_sha256",
  "approved_capabilities",
  "approved_outbound_hosts",
  "approved_frontend",
  "approved_at",
  "approved_by",
  "approval_reason",
]);

/** DB-safe schema-prefix identifier pattern (§3 step 14). */
export const SCHEMA_PREFIX_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;
