// Structured audit logging for the plugin loader + the runtime membrane/HTTP
// surfaces, and the best-effort intrinsics tamper snapshot. See
// docs/PLUGIN_LOADER_SPEC.md §11, §14.
//
// All events flow to the same pino logger as core's security events; operators
// tail this channel during plugin onboarding. None of this REFUSES anything at
// runtime — refusals happen at the loader gates (§3). The intrinsics snapshot
// in particular only LOGS on mismatch; refusing boot would self-DoS on a
// legitimately-broken transitive dep (§2.10, §14).

import { createHash } from "node:crypto";
import path from "node:path";
import type { PluginSource, RefusalReason } from "@vonzio/plugin-api";

/** Version stamped into every load event so a log line is attributable to a
 *  loader build. Tracks the plugin-api major contract. */
export const LOADER_VERSION = "1.0.0";

/** Minimal structured logger (pino / Fastify log satisfy this). */
export interface AuditLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface PluginLoadAudit {
  name: string;
  version: string;
  source: PluginSource;
  /** Absolute real path of the package root. */
  realPath: string;
  packageHashSha256: string;
  apiVersion: string;
  capabilitiesDeclared: readonly string[];
  capabilitiesGranted: readonly string[];
  outboundHostsDeclared: readonly string[];
  outboundHostsGranted: readonly string[];
  /** Logical mtls secret names the plugin declared + the operator provisioned. */
  mtlsSecrets: readonly string[];
  schemaPrefix: string | null;
  routePrefix: unknown;
  frontendApproved: boolean;
}

/**
 * `resolved_path_fingerprint`: by default the last two path segments + the
 * package-root content hash (keeps absolute paths out of routine logs).
 * Operators wanting absolute paths set VONZIO_AUDIT_LOG_FULL_PATHS=1 (§11).
 */
export function pathFingerprint(realPath: string, version: string, fullPaths = false): string {
  if (fullPaths) return realPath;
  const parts = realPath.split(path.sep).filter(Boolean);
  const tail = parts.slice(-2).join("/");
  return `${tail}@${version}`;
}

/** §11 "plugin loaded" structured event. */
export function emitPluginLoaded(
  log: AuditLogger,
  audit: PluginLoadAudit,
  opts: { fullPaths?: boolean } = {},
): void {
  log.info(
    {
      loader_version: LOADER_VERSION,
      node_version: process.version,
      plugin: {
        name: audit.name,
        version: audit.version,
        source: audit.source,
        resolved_path_fingerprint: pathFingerprint(audit.realPath, audit.version, opts.fullPaths),
        package_hash_sha256: audit.packageHashSha256,
        api_version: audit.apiVersion,
        capabilities_declared: audit.capabilitiesDeclared,
        capabilities_granted: audit.capabilitiesGranted,
        outbound_hosts_declared: audit.outboundHostsDeclared,
        outbound_hosts_granted: audit.outboundHostsGranted,
        mtls_secrets: audit.mtlsSecrets,
        schema_prefix: audit.schemaPrefix,
        route_prefix: audit.routePrefix,
        frontend_approved: audit.frontendApproved,
      },
    },
    "plugin loaded",
  );
}

/** §11 "plugin refused" structured event. */
export function emitPluginRefused(
  log: AuditLogger,
  info: {
    pluginName: string;
    reason: RefusalReason;
    message: string;
    remediation?: string;
    detail?: Record<string, unknown>;
  },
): void {
  log.warn(
    {
      plugin_name: info.pluginName,
      reason: info.reason,
      message: info.message,
      ...(info.remediation ? { remediation: info.remediation } : {}),
      ...(info.detail ? { detail: info.detail } : {}),
    },
    "plugin refused",
  );
}

/** Runtime: a capability-violation throw via the membrane / a throwing stub. */
export function emitCapabilityViolation(
  log: AuditLogger,
  info: { plugin: string; capability: string | null; key: string },
): void {
  log.warn(
    { plugin: info.plugin, capability: info.capability, key: info.key },
    "plugin capability violation",
  );
}

/** Runtime: one outbound HTTP/WS call made through ctx.http. */
export function emitOutboundCall(
  log: AuditLogger,
  info: { plugin: string; host: string; method: string; status: number; durationMs: number; mtls?: string },
): void {
  log.info(
    {
      plugin: info.plugin,
      host: info.host,
      method: info.method,
      status: info.status,
      duration_ms: info.durationMs,
      ...(info.mtls ? { mtls_secret: info.mtls } : {}),
    },
    "plugin outbound call",
  );
}

/** Runtime: a plugin resolved an mTLS secret name into an opaque ref. */
export function emitMtlsResolve(log: AuditLogger, info: { plugin: string; name: string }): void {
  log.info({ plugin: info.plugin, mtls_secret: info.name }, "plugin mtls secret resolved");
}

/** Runtime: an outbound call refused by the allowlist. */
export function emitOutboundViolation(log: AuditLogger, info: { plugin: string; host: string }): void {
  log.warn({ plugin: info.plugin, host: info.host }, "plugin outbound host violation");
}

/** Runtime: best-effort raw globalThis.fetch by a plugin without http.outbound. */
export function emitRawFetchAnomaly(log: AuditLogger, info: { plugin: string; url: string }): void {
  log.warn({ plugin: info.plugin, url: info.url }, "plugin raw fetch anomaly (best-effort)");
}

// ── Intrinsics snapshot (§14) ───────────────────────────────────────────────

export interface IntrinsicsSnapshot {
  envKeys: string[];
  uncaughtListeners: number;
  unhandledListeners: number;
  objectProto: string;
  arrayProto: string;
  functionProto: string;
}

function hashProto(proto: object): string {
  // Own-property names (sorted) fold into the digest — prototype pollution
  // adds an own property, changing the hash. Cheap + stable.
  const names = Object.getOwnPropertyNames(proto).sort();
  const symbols = Object.getOwnPropertySymbols(proto).map((s) => s.toString()).sort();
  return createHash("sha256").update(JSON.stringify({ names, symbols })).digest("hex");
}

export function snapshotIntrinsics(): IntrinsicsSnapshot {
  return {
    envKeys: Object.keys(process.env).sort(),
    uncaughtListeners: process.listenerCount("uncaughtException"),
    unhandledListeners: process.listenerCount("unhandledRejection"),
    objectProto: hashProto(Object.prototype),
    arrayProto: hashProto(Array.prototype),
    functionProto: hashProto(Function.prototype),
  };
}

/** Compare two snapshots; return a list of human-readable differences. */
export function diffIntrinsics(before: IntrinsicsSnapshot, after: IntrinsicsSnapshot): string[] {
  const diffs: string[] = [];
  const beforeEnv = new Set(before.envKeys);
  const afterEnv = new Set(after.envKeys);
  const addedEnv = after.envKeys.filter((k) => !beforeEnv.has(k));
  const removedEnv = before.envKeys.filter((k) => !afterEnv.has(k));
  if (addedEnv.length) diffs.push(`process.env keys added: ${addedEnv.join(", ")}`);
  if (removedEnv.length) diffs.push(`process.env keys removed: ${removedEnv.join(", ")}`);
  if (before.uncaughtListeners !== after.uncaughtListeners) {
    diffs.push(`uncaughtException listeners ${before.uncaughtListeners} -> ${after.uncaughtListeners}`);
  }
  if (before.unhandledListeners !== after.unhandledListeners) {
    diffs.push(`unhandledRejection listeners ${before.unhandledListeners} -> ${after.unhandledListeners}`);
  }
  if (before.objectProto !== after.objectProto) diffs.push("Object.prototype mutated");
  if (before.arrayProto !== after.arrayProto) diffs.push("Array.prototype mutated");
  if (before.functionProto !== after.functionProto) diffs.push("Function.prototype mutated");
  return diffs;
}

/**
 * Snapshot before, run `fn` (a plugin's init), snapshot after, and LOG LOUDLY
 * on any difference. Never throws on mismatch — the detection is
 * defense-in-depth against accidentally-broken deps, not a malice control
 * (§2.10). Returns whatever `fn` returns.
 */
export async function withIntrinsicsCheck<T>(
  log: AuditLogger,
  pluginName: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const before = snapshotIntrinsics();
  try {
    return await fn();
  } finally {
    const diffs = diffIntrinsics(before, snapshotIntrinsics());
    if (diffs.length) {
      log.error(
        { plugin: pluginName, diffs },
        "plugin intrinsics tampering detected (boot continues — see SPEC §14)",
      );
    }
  }
}
