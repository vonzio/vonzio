// Error types thrown by the loader + the runtime membrane/wrappers. Exported
// from @vonzio/plugin-api so plugin authors and the attack corpus can assert
// on them by class. See docs/PLUGIN_LOADER_SPEC.md §7, §9, §10, §11.

/**
 * Refusal reason codes emitted in the audit "plugin refused" event (§11).
 * Kept as a runtime tuple so the audit logger + tests can enumerate them.
 */
export const REFUSAL_REASONS = [
  "manifest_invalid",
  "api_version_incompatible",
  "external_db_access",
  "external_db_scoped_not_opted_in",
  "external_root_combination",
  "policy_missing",
  "policy_hash_mismatch",
  "policy_capability_drift",
  "policy_outbound_host_drift",
  "policy_mtls_secret_drift",
  "policy_version_mismatch",
  "unapproved_frontend",
  "mtls_secret_unreadable",
  "schema_prefix_invalid",
  "frontend_path_escape",
  "backend_path_escape",
  // Loader-internal refusals not in the §11 enumeration but needed in
  // practice (malformed env entry, unresolvable package, etc.).
  "package_unresolvable",
  "absolute_route_denied",
] as const;

export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/**
 * Thrown by the membrane's `get` trap when a plugin accesses a `core`
 * surface (or a non-core ctx surface) it did not declare + get granted.
 * Throwing at the violation site (rather than returning undefined) names
 * the underlying bug instead of surfacing a confusing downstream TypeError.
 */
export class CapabilityViolationError extends Error {
  readonly plugin: string;
  readonly capability: string | null;
  readonly key: string;
  constructor(args: { plugin: string; capability: string | null; key: string }) {
    super(
      `Plugin "${args.plugin}" accessed "${args.key}" without a granted capability` +
        (args.capability ? ` (needs ${args.capability})` : ""),
    );
    this.name = "CapabilityViolationError";
    this.plugin = args.plugin;
    this.capability = args.capability;
    this.key = args.key;
  }
}

/**
 * Thrown by `ctx.http.fetch` / webSocket / eventSource when the target
 * hostname is not in the manifest∩policy outbound allowlist (§10).
 */
export class OutboundHostViolationError extends Error {
  readonly plugin: string;
  readonly host: string;
  constructor(args: { plugin: string; host: string }) {
    super(`Plugin "${args.plugin}" attempted outbound request to disallowed host "${args.host}"`);
    this.name = "OutboundHostViolationError";
    this.plugin = args.plugin;
    this.host = args.host;
  }
}

/**
 * Thrown by the scoped Drizzle wrapper when a `db.scoped` plugin references
 * a table outside its schema prefix, or attempts raw SQL (§9).
 */
export class DbScopeViolationError extends Error {
  readonly plugin: string;
  readonly schemaPrefix: string;
  readonly offending: string;
  constructor(args: { plugin: string; schemaPrefix: string; offending: string }) {
    super(
      `Plugin "${args.plugin}" (schema "${args.schemaPrefix}") attempted to access "${args.offending}" outside its scope`,
    );
    this.name = "DbScopeViolationError";
    this.plugin = args.plugin;
    this.schemaPrefix = args.schemaPrefix;
    this.offending = args.offending;
  }
}

/**
 * Thrown by the loader when a plugin is refused at load. Carries the §11
 * reason code + an operator-facing remediation hint where applicable. The
 * loader catches this per-plugin, emits the refusal audit event, and skips
 * the plugin (boot continues).
 */
export class PluginRefusedError extends Error {
  readonly plugin: string;
  readonly reason: RefusalReason;
  readonly remediation?: string;
  readonly detail?: Record<string, unknown>;
  constructor(args: {
    plugin: string;
    reason: RefusalReason;
    message: string;
    remediation?: string;
    detail?: Record<string, unknown>;
  }) {
    super(args.message);
    this.name = "PluginRefusedError";
    this.plugin = args.plugin;
    this.reason = args.reason;
    this.remediation = args.remediation;
    this.detail = args.detail;
  }
}

/** Thrown by the policy validator when the operator policy file is malformed. */
export class PolicyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyViolationError";
  }
}
