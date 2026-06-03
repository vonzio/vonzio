// Pure, dependency-free validators for the plugin manifest (the package.json
// `vonzio` block) and the operator policy file, plus the runtime outbound-host
// matcher. No I/O — the loader reads files and calls these. Strict: unknown
// fields are rejected so a typo (`capabilites`) can't leave a plugin ungated.
// See docs/PLUGIN_LOADER_SPEC.md §3 ("Outbound host matching", "Policy file
// JSON schema"), §4.

import {
  isPluginCapability,
  type PluginCapability,
} from "./capabilities.js";
import {
  MANIFEST_ALLOWED_KEYS,
  POLICY_ENTRY_ALLOWED_KEYS,
  SCHEMA_PREFIX_PATTERN,
  type ManifestRoutePrefix,
  type OperatorPolicy,
  type PluginManifest,
  type PolicyEntry,
} from "./manifest.js";
import { PolicyViolationError, type RefusalReason } from "./errors.js";

export type ManifestValidationResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; reason: RefusalReason; message: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Characters that disqualify a string from being a bare hostname pattern. */
const HOST_FORBIDDEN_CHARS = /[/:?#@\s]/;

/**
 * Normalize + validate one `outboundHosts` manifest entry into its canonical
 * comparison form: lowercased, trailing-dot-stripped, IDNA/punycode-encoded,
 * with a single leading `*.` glob preserved. Throws on malformed entries.
 *
 * Rules (§3 "Outbound host matching"):
 *  - hostnames only — `/ : ? # @` and whitespace rejected (schemes, ports,
 *    paths, userinfo are not part of the match)
 *  - one leading `*.` glob allowed (matches exactly one DNS label); `**`,
 *    mid-pattern `*`, or a bare `*` are rejected
 *  - IDNA: the non-glob remainder is ASCII-encoded via the URL parser
 */
export function normalizeHostPattern(entry: string): string {
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error("outboundHosts entry must be a non-empty string");
  }
  let host = entry.trim().toLowerCase().replace(/\.$/, "");
  let glob = false;
  if (host.startsWith("*.")) {
    glob = true;
    host = host.slice(2);
  }
  if (host.includes("*")) {
    throw new Error(
      `Invalid outboundHosts entry "${entry}": "*" is only allowed as a single leading label (e.g. *.slack.com)`,
    );
  }
  if (host.length === 0) {
    throw new Error(`Invalid outboundHosts entry "${entry}": empty host after glob`);
  }
  if (HOST_FORBIDDEN_CHARS.test(host)) {
    throw new Error(
      `Invalid outboundHosts entry "${entry}": hostnames only — no scheme, port, path, or userinfo`,
    );
  }
  // IDNA-encode via the URL parser (applies punycode + validation). A host
  // with an illegal character set will throw here.
  let encoded: string;
  try {
    encoded = new URL(`http://${host}`).hostname;
  } catch {
    throw new Error(`Invalid outboundHosts entry "${entry}": not a valid hostname`);
  }
  return glob ? `*.${encoded}` : encoded;
}

/**
 * Does `hostname` (from `url.hostname` — already lowercased + IDNA) match any
 * normalized pattern? Glob `*.x.com` matches exactly one extra leading label.
 */
export function matchOutboundHost(hostname: string, patterns: readonly string[]): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  for (const raw of patterns) {
    // Patterns are expected pre-normalized (validateManifest stores them so),
    // but normalize defensively in case a caller passes raw manifest strings.
    let pattern: string;
    try {
      pattern = raw.startsWith("*.") || !HOST_FORBIDDEN_CHARS.test(raw)
        ? normalizeHostPattern(raw)
        : raw.toLowerCase().replace(/\.$/, "");
    } catch {
      continue; // a malformed pattern never matches
    }
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2);
      const labels = host.split(".");
      const suffixLabels = suffix.split(".");
      if (
        labels.length === suffixLabels.length + 1 &&
        labels.slice(1).join(".") === suffix
      ) {
        return true;
      }
    } else if (host === pattern) {
      return true;
    }
  }
  return false;
}

function validateRoutePrefix(raw: unknown): ManifestRoutePrefix | { error: string } {
  if (!isPlainObject(raw)) return { error: "routePrefix must be an object" };
  if (raw.kind === "auto") {
    if (Object.keys(raw).length !== 1) return { error: 'routePrefix {kind:"auto"} takes no other fields' };
    return { kind: "auto" };
  }
  if (raw.kind === "absolute") {
    const extra = Object.keys(raw).filter((k) => k !== "kind" && k !== "prefix");
    if (extra.length) return { error: `routePrefix has unknown fields: ${extra.join(", ")}` };
    const p = raw.prefix;
    const arr = Array.isArray(p) ? p : [p];
    if (arr.length === 0) return { error: "routePrefix.absolute.prefix is empty" };
    for (const one of arr) {
      if (typeof one !== "string" || !one.startsWith("/")) {
        return { error: `routePrefix.absolute.prefix entries must be absolute paths: ${String(one)}` };
      }
    }
    return { kind: "absolute", prefix: p as string | string[] };
  }
  return { error: `routePrefix.kind must be "auto" or "absolute", got ${JSON.stringify(raw.kind)}` };
}

/**
 * Validate the `vonzio` block from a plugin's package.json. Returns a
 * discriminated result so the loader can map the failure to the right §11
 * refusal reason without this module importing the loader. Does NOT run the
 * apiVersion compatibility check (that's assertApiCompatible) nor any I/O
 * (backendEntry existence, hashing) — those are the loader's job.
 */
export function validateManifest(raw: unknown): ManifestValidationResult {
  const fail = (message: string, reason: RefusalReason = "manifest_invalid"): ManifestValidationResult =>
    ({ ok: false, reason, message });

  if (!isPlainObject(raw)) return fail("vonzio manifest block is missing or not an object");

  // Strict: reject unknown keys (typo guard).
  const unknown = Object.keys(raw).filter((k) => !MANIFEST_ALLOWED_KEYS.has(k));
  if (unknown.length) return fail(`manifest has unknown fields: ${unknown.join(", ")}`);

  if (typeof raw.apiVersion !== "string" || raw.apiVersion.length === 0) {
    return fail("manifest.apiVersion must be a non-empty string");
  }
  if (typeof raw.backendEntry !== "string" || raw.backendEntry.length === 0) {
    return fail("manifest.backendEntry must be a non-empty string");
  }
  if (raw.frontendEntry !== undefined && typeof raw.frontendEntry !== "string") {
    return fail("manifest.frontendEntry must be a string when present");
  }

  if (!Array.isArray(raw.capabilities)) {
    return fail("manifest.capabilities must be an array");
  }
  const capabilities: PluginCapability[] = [];
  for (const c of raw.capabilities) {
    if (typeof c !== "string" || !isPluginCapability(c)) {
      return fail(`manifest.capabilities contains an unknown capability: ${JSON.stringify(c)}`);
    }
    capabilities.push(c);
  }

  const declaresHttp = capabilities.includes("http.outbound");
  const declaresDb = capabilities.includes("db.scoped") || capabilities.includes("db.access");

  // outboundHosts: required + non-empty iff http.outbound; normalized.
  let outboundHosts: string[] | undefined;
  if (raw.outboundHosts !== undefined) {
    if (!Array.isArray(raw.outboundHosts)) return fail("manifest.outboundHosts must be an array");
    try {
      outboundHosts = raw.outboundHosts.map((h) => normalizeHostPattern(h as string));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
  if (declaresHttp && (!outboundHosts || outboundHosts.length === 0)) {
    return fail("manifest declares http.outbound but outboundHosts is missing or empty");
  }
  if (!declaresHttp && outboundHosts && outboundHosts.length > 0) {
    return fail("manifest.outboundHosts is set but http.outbound capability is not declared");
  }

  // schemaPrefix: required iff db.* and must be a DB-safe identifier.
  let schemaPrefix: string | undefined;
  if (raw.schemaPrefix !== undefined) {
    if (typeof raw.schemaPrefix !== "string") return fail("manifest.schemaPrefix must be a string");
    if (!SCHEMA_PREFIX_PATTERN.test(raw.schemaPrefix)) {
      return fail(
        `manifest.schemaPrefix "${raw.schemaPrefix}" must match ${SCHEMA_PREFIX_PATTERN}`,
        "schema_prefix_invalid",
      );
    }
    schemaPrefix = raw.schemaPrefix;
  }
  if (declaresDb && !schemaPrefix) {
    return fail("manifest declares db.scoped/db.access but schemaPrefix is missing", "schema_prefix_invalid");
  }

  // routePrefix (optional; default auto).
  let routePrefix: ManifestRoutePrefix | undefined;
  if (raw.routePrefix !== undefined) {
    const rp = validateRoutePrefix(raw.routePrefix);
    if ("error" in rp) return fail(`manifest.${rp.error}`);
    routePrefix = rp;
  }

  return {
    ok: true,
    manifest: {
      apiVersion: raw.apiVersion,
      backendEntry: raw.backendEntry,
      ...(raw.frontendEntry !== undefined ? { frontendEntry: raw.frontendEntry as string } : {}),
      capabilities,
      ...(outboundHosts !== undefined ? { outboundHosts } : {}),
      ...(schemaPrefix !== undefined ? { schemaPrefix } : {}),
      ...(routePrefix !== undefined ? { routePrefix } : {}),
    },
  };
}

/**
 * Validate the operator policy file (or the shipped builtins policy). The
 * policy file is operator-owned config: a malformed file is a hard error
 * (throws PolicyViolationError) rather than a per-plugin skip. Strict:
 * unknown per-entry keys are rejected (mirrors the manifest stance).
 */
export function validatePolicy(raw: unknown, sourceLabel = "policy"): OperatorPolicy {
  if (!isPlainObject(raw)) {
    throw new PolicyViolationError(`${sourceLabel}: file is not a JSON object`);
  }
  if (raw.policy_version !== "1") {
    throw new PolicyViolationError(
      `${sourceLabel}: policy_version must be "1", got ${JSON.stringify(raw.policy_version)}`,
    );
  }
  const topUnknown = Object.keys(raw).filter((k) => k !== "policy_version" && k !== "plugins");
  if (topUnknown.length) {
    throw new PolicyViolationError(`${sourceLabel}: unknown top-level fields: ${topUnknown.join(", ")}`);
  }
  if (!isPlainObject(raw.plugins)) {
    throw new PolicyViolationError(`${sourceLabel}: "plugins" must be an object keyed by package name`);
  }

  const plugins: Record<string, PolicyEntry> = {};
  for (const [name, entryRaw] of Object.entries(raw.plugins)) {
    plugins[name] = validatePolicyEntry(name, entryRaw, sourceLabel);
  }
  return { policy_version: "1", plugins };
}

function validatePolicyEntry(name: string, raw: unknown, sourceLabel: string): PolicyEntry {
  const bad = (msg: string): never => {
    throw new PolicyViolationError(`${sourceLabel}: plugin "${name}": ${msg}`);
  };
  if (!isPlainObject(raw)) return bad("entry is not an object");

  const unknown = Object.keys(raw).filter((k) => !POLICY_ENTRY_ALLOWED_KEYS.has(k));
  if (unknown.length) bad(`unknown fields: ${unknown.join(", ")}`);

  if (typeof raw.version !== "string" || !raw.version) bad("version must be a non-empty string");
  if (typeof raw.approved_hash_sha256 !== "string" || !raw.approved_hash_sha256) {
    bad("approved_hash_sha256 must be a non-empty string");
  }
  if (!Array.isArray(raw.approved_capabilities)) bad("approved_capabilities must be an array");
  const caps: PluginCapability[] = [];
  for (const c of raw.approved_capabilities as unknown[]) {
    if (typeof c !== "string" || !isPluginCapability(c)) bad(`approved_capabilities has unknown capability ${JSON.stringify(c)}`);
    caps.push(c as PluginCapability);
  }
  if (!Array.isArray(raw.approved_outbound_hosts)) bad("approved_outbound_hosts must be an array");
  const hosts: string[] = [];
  for (const h of raw.approved_outbound_hosts as unknown[]) {
    if (typeof h !== "string") bad("approved_outbound_hosts entries must be strings");
    hosts.push(normalizeHostPattern(h as string));
  }
  if (raw.approved_frontend !== undefined && typeof raw.approved_frontend !== "boolean") {
    bad("approved_frontend must be a boolean when present");
  }
  for (const optStr of ["approved_at", "approved_by", "approval_reason"] as const) {
    if (raw[optStr] !== undefined && typeof raw[optStr] !== "string") bad(`${optStr} must be a string when present`);
  }

  return {
    version: raw.version as string,
    approved_hash_sha256: raw.approved_hash_sha256 as string,
    approved_capabilities: caps,
    approved_outbound_hosts: hosts,
    ...(raw.approved_frontend !== undefined ? { approved_frontend: raw.approved_frontend as boolean } : {}),
    ...(raw.approved_at !== undefined ? { approved_at: raw.approved_at as string } : {}),
    ...(raw.approved_by !== undefined ? { approved_by: raw.approved_by as string } : {}),
    ...(raw.approval_reason !== undefined ? { approval_reason: raw.approval_reason as string } : {}),
  };
}
