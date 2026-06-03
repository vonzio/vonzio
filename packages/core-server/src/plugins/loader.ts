import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PLUGIN_API_VERSION,
  assertApiCompatible,
  validateManifest,
  BUILTIN_ONLY_CAPABILITIES,
  ROOT_EQUIVALENT_COMBINATIONS,
  type PluginCapability,
  type PluginContext,
  type PluginCore,
  type PluginLogger,
  type PluginManifest,
  type PluginSecrets,
  type PluginSessionPresenceRegistry,
  type PluginSource,
  type RefusalReason,
  type VonzioPlugin,
} from "@vonzio/plugin-api";
import type { DB } from "../db/index.js";
import { encrypt, decrypt } from "../auth/crypto.js";
import type { Config } from "../config.js";
import { NotificationBusImpl } from "./notification-bus.js";
import { McpRegistryImpl } from "./mcp-registry.js";
import { SchedulerImpl } from "./scheduler.js";
import { runPluginMigrations } from "./migrations.js";
import {
  findRepoRoot,
  hashPackageDir,
  classifySource,
  crossCheckPolicy,
  loadPolicies,
  type LoadedPolicies,
} from "./policy.js";
import { assembleCore, throwingSurface, type OnViolation } from "./membrane.js";
import { scopedDb, checkMigrationPrefix } from "./scoped-db.js";
import { makePluginHttp, installGlobalFetchGuard, runInPluginContext } from "./http.js";
import { makePluginStorage } from "./storage.js";
import { makePluginSecrets } from "./secrets.js";
import type { MtlsMaterial } from "../lib/safe-webhook-fetch.js";
import {
  emitPluginLoaded,
  emitPluginRefused,
  emitCapabilityViolation,
  emitMtlsResolve,
  emitOutboundCall,
  emitOutboundViolation,
  emitRawFetchAnomaly,
  withIntrinsicsCheck,
  type AuditLogger,
} from "./audit.js";

/**
 * Plugin loader. Reads `config.VONZIO_PLUGINS`, dynamically imports
 * each listed package, runs its migrations, parses its config from
 * env, builds the per-plugin `PluginContext`, and calls `init()`.
 *
 * Sandboxed init: a plugin throwing inside `init()` is logged and
 * skipped; core continues with whichever plugins did succeed. This
 * keeps a single broken plugin from bricking the whole server.
 *
 * Migration failures DO propagate -- a schema migration crash means
 * the plugin's tables are in an unknown state and trying to load it
 * with a half-built schema would mask the actual breakage.
 */
export interface LoadedPlugin {
  plugin: VonzioPlugin;
  context: PluginContext;
  packageName: string;
}

/**
 * Plugin specification parsed from the VONZIO_PLUGINS env list.
 * The package name (e.g. "@vonzio/plugin-telegram") is the only
 * field the loader needs; semver constraints in the env value are
 * advisory (npm/workspace resolution happens at install time, not
 * load time).
 */
export interface PluginSpec {
  packageName: string;
}

/**
 * Parse `VONZIO_PLUGINS` env format:
 *   "@vonzio/plugin-telegram@^0.1, @vonzio/plugin-slack@^0.1"
 *
 * The `@version-constraint` suffix is stripped (we use whatever the
 * package resolver installed -- enforcing the constraint at runtime
 * would be redundant work). Whitespace and empty entries are tolerated
 * so accidental trailing commas don't break boot.
 */
export function parsePluginEnvList(value: string | undefined | null): PluginSpec[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      // Split on the LAST `@` before a version constraint, but only if
      // the entry started with `@<scope>/...`. Bare `name@version` has
      // one `@`; scoped `@scope/name@version` has two. Strategy:
      // strip the trailing `@<anything>` only if there's at least
      // one preceding non-@ char.
      const atVersionIdx = entry.lastIndexOf("@");
      if (atVersionIdx > 0 && entry[atVersionIdx - 1] !== "/") {
        return { packageName: entry.slice(0, atVersionIdx) };
      }
      return { packageName: entry };
    });
}

/**
 * Runtime shape validation. We trust the TypeScript contract at compile
 * time, but the loader receives a dynamic import result whose default
 * export might be a malformed object (wrong shape, missing fields,
 * runtime/build mismatch). Better to fail fast with a useful error.
 */
function assertPluginShape(
  candidate: unknown,
  packageName: string,
): asserts candidate is VonzioPlugin {
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`Plugin "${packageName}" default export is not an object`);
  }
  const p = candidate as Record<string, unknown>;
  for (const field of ["name", "apiVersion", "configSchema", "init"]) {
    if (!(field in p)) {
      throw new Error(`Plugin "${packageName}" missing required field: ${field}`);
    }
  }
  if (typeof p.name !== "string" || !p.name) {
    throw new Error(`Plugin "${packageName}" .name must be a non-empty string`);
  }
  if (typeof p.apiVersion !== "string") {
    throw new Error(`Plugin "${packageName}" .apiVersion must be a string`);
  }
  if (typeof p.init !== "function") {
    throw new Error(`Plugin "${packageName}" .init must be a function`);
  }
}

/**
 * Subsets of core services the loader uses to build the typed
 * adapters on PluginCore. Each is structural (not class-typed) so
 * the loader stays decoupled from the concrete service module --
 * swapping out an implementation behind this interface doesn't
 * ripple into plugin code.
 */
type IntegrationRow = {
  id: string;
  user_id: string;
  type: string;
  config: Record<string, unknown>;
  enabled: boolean;
  updated_at: string;
};

export interface IntegrationServiceLike {
  get(id: string, opts?: { decrypt?: boolean }): Promise<IntegrationRow | null>;
  getByUserAndType(userId: string, type: string, opts?: { decrypt?: boolean }): Promise<IntegrationRow | null>;
  listByType(type: string, opts?: { decrypt?: boolean }): Promise<IntegrationRow[]>;
  listByUserAndType(userId: string, type: string, opts?: { decrypt?: boolean }): Promise<IntegrationRow[]>;
  findByTypeAndExternalId(type: string, externalId: string, opts?: { decrypt?: boolean }): Promise<IntegrationRow | null>;
  listByTypeAndExternalId(type: string, externalId: string, opts?: { decrypt?: boolean }): Promise<IntegrationRow[]>;
  backfillExternalId(id: string): Promise<void>;
  // Signature mirrors core's IntegrationService.create (positional
  // userId/type/config + optional scopeInput).
  create(userId: string, type: string, config: Record<string, unknown>, scopeInput?: unknown): Promise<IntegrationRow>;
  update(
    id: string,
    input: Partial<{ config: Record<string, unknown>; enabled: boolean; scope: string; profile_ids: string[] }>,
    opts?: { expectUpdatedAt?: string },
  ): Promise<IntegrationRow | null>;
  // IntegrationService.delete actually returns boolean (did-it-exist).
  // The loader adapter narrows that to void in the plugin-facing
  // contract, but this structural type captures the real signature.
  delete(id: string): Promise<boolean>;
}

export interface ProfileServiceLike {
  list(userId: string): Promise<Array<import("@vonzio/shared").Profile>>;
  // getResolved is on ProfileService; structural type lets the loader
  // accept a partial implementation (e.g. test mocks that don't need
  // the heavier resolution path).
  getResolved(profileId: string): Promise<import("@vonzio/shared").ResolvedProfile | null>;
  // Pass the full Profile type from @vonzio/shared through. Mirroring
  // it structurally here would silently drift as fields are added
  // (the Profile shape is wide -- mcp_servers, agent_ids, etc.).
  get(profileId: string): Promise<import("@vonzio/shared").Profile | null>;
}

/**
 * Structural shape for TaskService.submit. Matches the real method's
 * signature -- input.profile_id is optional (auto-resolves from
 * callerProfileIds when caller has exactly one).
 */
export interface TaskServiceLike {
  submit(
    input: {
      mode?: "session" | "batch" | "pooled" | "single";
      prompt: string;
      profile_id?: string;
      session_id?: string;
      allowed_tools?: string[];
      egress_domains?: string[];
      max_turns?: number;
      max_budget_usd?: number;
      model?: string;
      effort?: string;
      timeout_seconds?: number;
      attachments?: Array<import("@vonzio/shared").TaskAttachment>;
    },
    callerProfileIds: string[],
  ): Promise<{ task_id: string; status: string; created_at: string }>;
}

/**
 * Structural shape of the SessionRegistry methods plugins use. Wraps
 * register / extendExpiry / setStatus / getConnectedSessionIds; the
 * full SessionRegistry class has more (reassignContainer, setVolumeId,
 * listByUser, ...) that plugins shouldn't need.
 */
export interface SessionRegistryLike {
  register(
    sessionId: string,
    containerId: string | null,
    userId: string,
    profileId: string,
    persistent?: boolean,
    orgId?: string | null,
  ): Promise<{ session_id: string; user_id: string; profile_id: string }>;
  extendExpiry(sessionId: string, expiresAt: string): Promise<void>;
  setStatus(sessionId: string, status: "active" | "resumable" | "idle" | "expired"): Promise<void>;
  getConnectedSessionIds(): Set<string>;
}

/**
 * Structural shape of Orchestrator's plugin-facing surface. Just
 * wakeWorkspaceContainer for now -- the events surface goes through
 * sessionEventEmitter (see SessionEventEmitterLike).
 */
export interface OrchestratorLike {
  wakeWorkspaceContainer(
    sessionId: string,
    profile: import("@vonzio/shared").ResolvedProfile,
  ): Promise<string | null>;
}

export interface EventLogLike {
  append(sessionId: string, type: string, data: Record<string, unknown>): void;
  read(
    sessionId: string,
    afterSeq?: number,
  ): Array<{ seq: number; type: string; data: Record<string, unknown>; ts: number }>;
}

export interface ConnectionManagerLike {
  sendToSession(sessionId: string, message: Record<string, unknown>): void;
}

export interface ImageRewriterServiceLike {
  forSession(
    sessionId: string,
    text: string,
  ): Promise<{
    textWithUrls: string;
    textWithoutImages: string;
    images: Array<{ url: string; alt: string; originalUrl: string }>;
  } | null>;
}

export interface ModelListServiceLike {
  listForProfile(profileId: string): Promise<
    | {
        ok: true;
        models: Array<{ id: string; display_name: string | null; provider: "anthropic" | "ollama" }>;
        profileDefault: string | null;
      }
    | { ok: false; status: number; error: string }
  >;
}

export interface WorkspaceServiceLike {
  get(sessionId: string): import("@vonzio/shared").Workspace | null;
  list(filters: {
    userId?: string;
    orgId?: string;
    status?: "active" | "resumable" | "idle" | "expired";
    includeArchived?: boolean;
    starredOnly?: boolean;
    page?: number;
    limit?: number;
  }): Promise<{
    workspaces: Array<import("@vonzio/shared").Workspace>;
    total: number;
  }>;
  update(
    sessionId: string,
    fields: {
      name?: string;
      starred?: boolean;
      pinned?: boolean;
      archived?: boolean;
      tags?: string[];
      public_preview?: boolean;
      model_override?: string | null;
      last_run_model?: string | null;
    },
    opts?: { orgId?: string },
  ): Promise<import("@vonzio/shared").Workspace | null>;
}

/**
 * Narrow EventEmitter-shaped contract used to back the typed
 * `sessionEvents` facade. Orchestrator's class satisfies this
 * naturally (it extends node:events.EventEmitter); other backends
 * could too (mock in tests, fan-in proxy for sharded setups).
 */
export interface SessionEventEmitterLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, listener: (...args: any[]) => void): unknown;
}

export interface LoadPluginsOpts {
  envList: string | undefined;
  server: FastifyInstance;
  handle: DB;
  config: Config;
  notificationBus: NotificationBusImpl;
  mcpRegistry: McpRegistryImpl;
  scheduler: SchedulerImpl;
  integrationService: IntegrationServiceLike;
  profileService: ProfileServiceLike;
  workspaceService: WorkspaceServiceLike;
  /**
   * The surfaces below back the new PluginCore fields added in
   * Phase 3D.1b -- everything telegram-events.ts will need once it
   * moves into the plugin. Server.ts already constructs each
   * service; passing them through here just exposes them through the
   * plugin contract.
   */
  taskService: TaskServiceLike;
  sessionRegistry: SessionRegistryLike;
  orchestrator: OrchestratorLike;
  eventLog: EventLogLike;
  connectionManager: ConnectionManagerLike;
  imageRewriterService: ImageRewriterServiceLike;
  modelListService: ModelListServiceLike;
  authHook: import("fastify").onRequestHookHandler;
  /**
   * Chat-surface presence registry. Plugins receive the register-side
   * of this via `ctx.core.sessionPresence` and add a provider in their
   * init(); core's orchestrator + ask-user-fallback + workspace-
   * service walk the same registry to ask "is this session
   * reachable?" without coupling to plugin-owned tables.
   */
  sessionPresence: PluginSessionPresenceRegistry;
  /**
   * Backs `ctx.sessionEvents`. Orchestrator satisfies this directly
   * (it extends EventEmitter). When absent (test setups), plugins
   * that subscribe just receive no events -- their handlers register
   * fine, they just never fire.
   */
  sessionEventEmitter?: SessionEventEmitterLike;
  /**
   * Monorepo root used to classify builtin vs external plugins and locate
   * the shipped builtins policy. Defaults to findRepoRoot() (walks to the
   * workspaces package.json).
   */
  repoRoot?: string;
  /** Override for the operator policy path (defaults to $VONZIO_PLUGIN_POLICY
   *  then <cwd>/vonzio-plugins.json). */
  operatorPolicyPath?: string;
  /**
   * Dry-run (`vonzio --list-plugins` / VONZIO_PLUGINS_DRY_RUN=1): run the §3
   * validation pipeline (steps 1-17) + emit the audit block for every plugin,
   * then return WITHOUT importing any plugin entry or calling init().
   */
  dryRun?: boolean;
}

/** §6 name validation. Rejects `./`, `../`, absolute/URL forms, whitespace. */
export function isValidPluginName(name: string): boolean {
  return /^(@[\w.-]+\/)?[\w.-]+$/.test(name);
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const unscopedName = (pkg: string): string => (pkg.includes("/") ? pkg.split("/").pop()! : pkg);

/** Absolute-route deny-list (§8). Built-ins are exempt (trusted; §13). */
const ABSOLUTE_ROUTE_DENYLIST = [
  "/v1/auth",
  "/v1/admin",
  "/v1/orgs",
  "/health",
  "/metrics",
  "/assets",
  "/api",
];

export interface ResolvedPackage {
  realRoot: string;
  version: string;
  manifestRaw: unknown;
  realResolvedEntry: string;
}

/** Resolve a package to its real root + read its package.json. Uses
 *  import.meta.resolve (require.resolve throws on these exports-only
 *  packages — deviation #1). Throws on unresolvable. Exported for the CLI. */
export function resolvePackageRoot(packageName: string): ResolvedPackage {
  const entryUrl = import.meta.resolve(packageName);
  const realResolvedEntry = realpathSync(fileURLToPath(entryUrl));
  let dir = path.dirname(realResolvedEntry);
  while (!existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no package.json ancestor for ${packageName}`);
    dir = parent;
  }
  const realRoot = realpathSync(dir);
  const pkg = JSON.parse(readFileSync(path.join(realRoot, "package.json"), "utf8")) as {
    version?: string;
    vonzio?: unknown;
  };
  return { realRoot, version: String(pkg.version ?? "0.0.0"), manifestRaw: pkg.vonzio, realResolvedEntry };
}

/** Resolve manifest.backendEntry/frontendEntry to a real path that is a child
 *  of the package root (§3 step 10). For the backend, also require it to equal
 *  the package's resolved entry (deviation #2). */
function resolveEntry(
  realRoot: string,
  entryRel: string,
  expectedRealEntry: string | undefined,
): { ok: true; realPath: string } | { ok: false; reason: RefusalReason; message: string } {
  const abs = path.resolve(realRoot, entryRel);
  if (!existsSync(abs)) {
    return { ok: false, reason: "backend_path_escape", message: `entry "${entryRel}" does not exist` };
  }
  const real = realpathSync(abs);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    return { ok: false, reason: "backend_path_escape", message: `entry "${entryRel}" escapes the package root` };
  }
  if (expectedRealEntry && real !== expectedRealEntry) {
    return {
      ok: false,
      reason: "backend_path_escape",
      message: `backendEntry "${entryRel}" does not resolve to the package's entry point`,
    };
  }
  return { ok: true, realPath: real };
}

interface PreparedPlugin {
  plugin: VonzioPlugin;
  context: PluginContext;
  manifest: PluginManifest;
  hasHttpOutbound: boolean;
}

interface PrepareEnv {
  opts: LoadPluginsOpts;
  policies: LoadedPolicies;
  repoRoot: string;
  trackVersions: "strict" | "loose";
  fullPaths: boolean;
  log: AuditLogger;
}

/**
 * Run the §3 manifest-before-import pipeline for one plugin. Returns a
 * PreparedPlugin (validated, imported, migrated, context built) or null
 * (refused — already audited — or dry-run). Plugin code does NOT execute
 * before step 18 (the import).
 */
async function preparePlugin(packageName: string, env: PrepareEnv): Promise<PreparedPlugin | null> {
  const { opts, policies, repoRoot, trackVersions, fullPaths, log } = env;
  const refuse = (
    reason: RefusalReason,
    message: string,
    remediation?: string,
    detail?: Record<string, unknown>,
  ): null => {
    emitPluginRefused(log, { pluginName: packageName, reason, message, remediation, detail });
    return null;
  };

  // 1. name validation
  if (!isValidPluginName(packageName)) {
    return refuse("manifest_invalid", `invalid plugin name "${packageName}"`);
  }

  // 1-3. resolve + read + validate manifest
  let resolved: ResolvedPackage;
  try {
    resolved = resolvePackageRoot(packageName);
  } catch (err) {
    return refuse("package_unresolvable", `cannot resolve "${packageName}": ${msg(err)}`);
  }
  const { realRoot, version, manifestRaw, realResolvedEntry } = resolved;

  const mres = validateManifest(manifestRaw);
  if (!mres.ok) return refuse(mres.reason, mres.message);
  const manifest = mres.manifest;

  // 4. api compatibility
  try {
    assertApiCompatible(manifest.apiVersion, PLUGIN_API_VERSION);
  } catch (err) {
    return refuse("api_version_incompatible", msg(err));
  }

  // 5. classify
  const source: PluginSource = classifySource(realRoot, repoRoot, policies.builtinNames, packageName);

  // 6-9. external-only capability rules
  if (source === "external") {
    const expectedSuffix = path.sep + path.join("node_modules", ...packageName.split("/"));
    if (!realRoot.endsWith(expectedSuffix)) {
      return refuse(
        "backend_path_escape",
        `external package real path "${realRoot}" is not within node_modules/${packageName} (npm link / file: installs are not trusted as built-ins)`,
      );
    }
    for (const cap of manifest.capabilities) {
      if (BUILTIN_ONLY_CAPABILITIES.has(cap)) {
        return refuse("external_db_access", `external plugin "${packageName}" cannot declare ${cap} (built-ins only)`);
      }
    }
    if (manifest.capabilities.includes("db.scoped") && process.env.VONZIO_ALLOW_SCOPED_DB_PLUGINS !== "1") {
      return refuse(
        "external_db_scoped_not_opted_in",
        `external plugin "${packageName}" declares db.scoped; set VONZIO_ALLOW_SCOPED_DB_PLUGINS=1 to allow`,
      );
    }
    for (const combo of ROOT_EQUIVALENT_COMBINATIONS) {
      if (combo.every((c) => manifest.capabilities.includes(c))) {
        return refuse(
          "external_root_combination",
          `external plugin "${packageName}" declares the root-equivalent combination ${combo.join(" + ")}`,
        );
      }
    }
  }

  // 10. backend/frontend path checks
  const backend = resolveEntry(realRoot, manifest.backendEntry, realResolvedEntry);
  if (!backend.ok) return refuse(backend.reason, backend.message);
  if (manifest.frontendEntry) {
    const fe = resolveEntry(realRoot, manifest.frontendEntry, undefined);
    if (!fe.ok) return refuse("frontend_path_escape", fe.message);
  }

  // §8 absolute-route deny-list (built-ins exempt) — pre-import so a denied
  // prefix refuses the plugin rather than half-loading it.
  const rp = manifest.routePrefix ?? { kind: "auto" as const };
  if (rp.kind === "absolute" && source === "external") {
    const prefixes = Array.isArray(rp.prefix) ? rp.prefix : [rp.prefix];
    for (const p of prefixes) {
      for (const denied of ABSOLUTE_ROUTE_DENYLIST) {
        if (p === denied || p.startsWith(denied + "/")) {
          return refuse("absolute_route_denied", `absolute route prefix "${p}" overlaps the reserved namespace "${denied}"`);
        }
      }
    }
  }

  // 15. hash + 16. policy cross-check
  let installedHash: string;
  try {
    installedHash = hashPackageDir(realRoot);
  } catch (err) {
    // e.g. a symlink in the package tree (refused for attestation integrity).
    return refuse("backend_path_escape", msg(err));
  }
  const entry = policies.entryFor(packageName);
  const cc = crossCheckPolicy({ packageName, manifest, entry, installedVersion: version, installedHash, trackVersions, source });
  if (!cc.ok) return refuse(cc.reason, cc.message, cc.remediation, cc.detail);
  const granted = new Set<PluginCapability>(cc.grantedCapabilities);

  // 16b. Load mTLS client-cert material from the operator-provisioned host
  // files (fail-closed: a declared-but-unreadable cert/key refuses the plugin
  // rather than silently disabling its mTLS calls). Bytes stay in core memory
  // and reach the plugin only as an opaque ref via ctx.secrets/ctx.http.
  const mtlsMaterial = new Map<string, MtlsMaterial>();
  if (granted.has("secrets.mtls")) {
    for (const [name, files] of Object.entries(cc.grantedMtlsSecrets)) {
      let cert: Buffer;
      let key: Buffer;
      let ca: Buffer | undefined;
      try {
        cert = readFileSync(files.cert);
        key = readFileSync(files.key);
        if (files.ca) ca = readFileSync(files.ca);
      } catch (err) {
        return refuse(
          "mtls_secret_unreadable",
          `mTLS secret "${name}" for "${packageName}" could not be read: ${msg(err)}`,
          `check the cert/key/ca paths in policy mtls_secrets["${name}"] are mounted + readable`,
          { name, cert: files.cert, key: files.key, ca: files.ca },
        );
      }
      let passphrase: string | undefined;
      if (files.passphraseEnv) {
        passphrase = process.env[files.passphraseEnv];
        if (!passphrase) {
          return refuse(
            "mtls_secret_unreadable",
            `mTLS secret "${name}" for "${packageName}" references passphrase env "${files.passphraseEnv}" which is unset`,
            `set ${files.passphraseEnv} in the server environment`,
            { name, passphraseEnv: files.passphraseEnv },
          );
        }
      }
      mtlsMaterial.set(name, { cert, key, ...(ca ? { ca } : {}), ...(passphrase ? { passphrase } : {}) });
    }
  }

  // 17. audit "plugin loaded"
  emitPluginLoaded(
    log,
    {
      name: packageName,
      version,
      source,
      realPath: realRoot,
      packageHashSha256: installedHash,
      apiVersion: manifest.apiVersion,
      capabilitiesDeclared: manifest.capabilities,
      capabilitiesGranted: cc.grantedCapabilities,
      outboundHostsDeclared: manifest.outboundHosts ?? [],
      outboundHostsGranted: cc.grantedOutboundHosts,
      mtlsSecrets: manifest.mtlsSecrets ?? [],
      schemaPrefix: manifest.schemaPrefix ?? null,
      routePrefix: manifest.routePrefix ?? { kind: "auto" },
      frontendApproved: cc.frontendApproved,
    },
    { fullPaths },
  );

  // 18. dry-run stops before importing any plugin code.
  if (opts.dryRun) return null;

  try {
    const mod = await import(pathToFileURL(backend.realPath).href);
    const candidate = (mod as { default?: unknown }).default;
    assertPluginShape(candidate, packageName);

    // Migrations (prefix-checked for db.scoped plugins only — db.access
    // built-ins are unscoped + trusted, §9).
    if (candidate.migrations && candidate.migrations.length > 0) {
      if (manifest.schemaPrefix && granted.has("db.scoped")) {
        for (const m of candidate.migrations) {
          const offending = checkMigrationPrefix(m.up, manifest.schemaPrefix);
          if (offending) {
            return refuse(
              "schema_prefix_invalid",
              `migration "${m.name}" touches "${offending}" outside schema prefix "${manifest.schemaPrefix}"`,
            );
          }
        }
      }
      await runPluginMigrations(opts.handle, candidate.name, candidate.migrations);
    }

    const config = candidate.configSchema.parse(process.env);
    const context = buildPluginContext({
      plugin: candidate,
      parsedConfig: config,
      opts,
      manifest,
      granted,
      grantedHosts: cc.grantedOutboundHosts,
      mtlsMaterial,
      log,
    });

    return { plugin: candidate, context, manifest, hasHttpOutbound: granted.has("http.outbound") };
  } catch (err) {
    return refuse("manifest_invalid", `failed to import / initialize "${packageName}": ${msg(err)}`);
  }
}

/** Register a prepared plugin's routes on a per-plugin Fastify child scope.
 *  Inner try/catch preserves per-plugin error isolation (§2.9): a throw in
 *  init() is logged and the plugin's routes simply don't register — boot
 *  continues. init() runs tagged with the plugin's async context (raw-fetch
 *  detection) and inside the intrinsics-tamper snapshot (§14). */
function registerPluginRoutes(server: FastifyInstance, prepared: PreparedPlugin, log: AuditLogger): void {
  const { plugin, manifest } = prepared;
  const rp = manifest.routePrefix ?? { kind: "auto" as const };
  // auto -> a real /plugins/<name> child scope; absolute -> no scope prefix
  // (the plugin uses its full legacy paths; deviation #4).
  const registerOpts: { prefix?: string } =
    rp.kind === "auto" ? { prefix: `/plugins/${plugin.name}` } : {};
  // For absolute prefixes the child has no scope, so Fastify won't confine the
  // plugin's routes. Enforce confinement explicitly: every registered route
  // must sit under one of the declared (already deny-list-cleared) prefixes —
  // otherwise an external could declare a benign prefix and still register
  // /v1/admin/* (§8).
  const declaredAbsolutePrefixes =
    rp.kind === "absolute" ? (Array.isArray(rp.prefix) ? rp.prefix : [rp.prefix]) : null;
  void server.register(async (child) => {
    if (declaredAbsolutePrefixes) {
      child.addHook("onRoute", (routeOptions) => {
        const url: string = routeOptions.url ?? "";
        const ok = declaredAbsolutePrefixes.some((p) => url === p || url.startsWith(p.endsWith("/") ? p : p + "/"));
        if (!ok) {
          throw new Error(
            `plugin "${plugin.name}" registered route "${url}" outside its declared absolute prefix(es) ${declaredAbsolutePrefixes.join(", ")}`,
          );
        }
      });
    }
    try {
      await runInPluginContext({ plugin: plugin.name, hasHttpOutbound: prepared.hasHttpOutbound }, () =>
        withIntrinsicsCheck(log, plugin.name, () => plugin.init({ ...prepared.context, server: child })),
      );
    } catch (err) {
      log.error(
        { plugin: plugin.name, err: msg(err) },
        "plugin init() threw; routes for this plugin are not registered (boot continues)",
      );
    }
  }, registerOpts);
}

/**
 * Load plugins through the §3 manifest-before-import pipeline: validate +
 * policy-check each plugin from disk, then import + migrate + build a
 * capability-gated context, push the LoadedPlugin eagerly (so teardown
 * tracking is correct), and register routes on a per-plugin Fastify scope.
 * Returns the loaded set for `teardownPlugins` at shutdown.
 */
export async function loadPluginsFromEnv(opts: LoadPluginsOpts): Promise<LoadedPlugin[]> {
  const specs = parsePluginEnvList(opts.envList);
  if (specs.length === 0) {
    opts.server.log.info("[plugins] VONZIO_PLUGINS not set -- skipping plugin load");
    return [];
  }

  const log = opts.server.log as unknown as AuditLogger;
  const repoRoot = opts.repoRoot ?? findRepoRoot();
  const policies = loadPolicies({ repoRoot, operatorPolicyPath: opts.operatorPolicyPath });
  const trackVersions = process.env.VONZIO_PLUGIN_POLICY_TRACK_VERSIONS === "loose" ? "loose" : "strict";
  const fullPaths = process.env.VONZIO_AUDIT_LOG_FULL_PATHS === "1";

  // Best-effort raw-fetch detection (§10) installed once.
  installGlobalFetchGuard((info) => emitRawFetchAnomaly(log, info));

  const loaded: LoadedPlugin[] = [];
  for (const spec of specs) {
    const prepared = await preparePlugin(spec.packageName, { opts, policies, repoRoot, trackVersions, fullPaths, log });
    if (!prepared) continue; // refused (already audited) or dry-run
    // Eager push BEFORE route registration: init() runs deferred inside the
    // Fastify child scope, so teardown tracking must not depend on it.
    loaded.push({ plugin: prepared.plugin, context: prepared.context, packageName: spec.packageName });
    registerPluginRoutes(opts.server, prepared, log);
  }
  return loaded;
}

/**
 * Build the capability-gated PluginContext a single plugin sees. Assembles
 * the complete ungated `fullCore`, wraps it in the membrane (assembleCore)
 * keyed by the granted capabilities, and attaches the non-core ctx surfaces
 * (storage/http/notificationBus/mcpRegistry/scheduler/sessionEvents) by
 * conditional inclusion — present iff granted, else a throwing stub.
 *
 * `server` is set to the OUTER instance as a placeholder; registerPluginRoutes
 * injects the per-plugin Fastify child instance at init time.
 */
export function buildPluginContext<TConfig>(args: {
  plugin: VonzioPlugin<TConfig>;
  parsedConfig: TConfig;
  opts: LoadPluginsOpts;
  manifest: PluginManifest;
  granted: ReadonlySet<PluginCapability>;
  grantedHosts: readonly string[];
  /** Pre-loaded mTLS material keyed by logical name (empty unless secrets.mtls
   *  is granted + provisioned). */
  mtlsMaterial?: ReadonlyMap<string, MtlsMaterial>;
  log: AuditLogger;
}): PluginContext<TConfig> {
  const { plugin, parsedConfig, opts, manifest, granted, grantedHosts, log } = args;
  const mtlsMaterial = args.mtlsMaterial ?? new Map<string, MtlsMaterial>();

  const pluginLog = makePluginLogger(opts.server.log, plugin.name);
  const onViolation: OnViolation = (v) => emitCapabilityViolation(log, v);

  // The DB handle the membrane will expose IF db.* is granted: scoped wrapper
  // for db.scoped, raw handle for db.access. assembleCore only surfaces it
  // when a db capability is in `granted`.
  const dbHandle =
    granted.has("db.scoped") && manifest.schemaPrefix
      ? scopedDb(opts.handle.db as object, plugin.name, manifest.schemaPrefix)
      : opts.handle.db;

  const fullCore: PluginCore = {
    db: dbHandle,
    encryption: {
      encrypt: (plaintext) => encrypt(plaintext, opts.config.ENCRYPTION_KEY),
      decrypt: (ciphertext) => decrypt(ciphertext, opts.config.ENCRYPTION_KEY),
    },
    integrations: {
      // Thin wrappers -- IntegrationServiceLike's structural shape
      // matches the real service's signature 1:1 so this is just
      // method forwarding.
      get: (id, getOpts) => opts.integrationService.get(id, getOpts),
      getByUserAndType: (userId, type, o) => opts.integrationService.getByUserAndType(userId, type, o),
      listByType: (type, o) => opts.integrationService.listByType(type, o),
      listByUserAndType: (userId, type, o) => opts.integrationService.listByUserAndType(userId, type, o),
      findByTypeAndExternalId: (type, ext, o) => opts.integrationService.findByTypeAndExternalId(type, ext, o),
      listByTypeAndExternalId: (type, ext, o) => opts.integrationService.listByTypeAndExternalId(type, ext, o),
      backfillExternalId: (id) => opts.integrationService.backfillExternalId(id),
      create: (userId, type, config, scopeInput) => opts.integrationService.create(userId, type, config, scopeInput),
      update: (id, input, updateOpts) => opts.integrationService.update(id, input, updateOpts),
      // IntegrationService.delete returns boolean (did-it-exist); the
      // plugin contract is fire-and-forget so we drop the return.
      delete: async (id) => { await opts.integrationService.delete(id); },
    },
    profiles: {
      list: (userId) => opts.profileService.list(userId),
      get: (profileId) => opts.profileService.get(profileId),
    },
    workspaces: {
      get: (sessionId) => opts.workspaceService.get(sessionId),
      list: (filters) => opts.workspaceService.list(filters),
      update: (sessionId, fields, updateOpts) =>
        opts.workspaceService.update(sessionId, fields, updateOpts),
    },
    authHook: opts.authHook,
    sessionPresence: opts.sessionPresence,
    // Forwarders -- each one is a thin pass-through to the matching
    // structural input. Concrete classes match the *Like signatures
    // 1:1 so this is method aliasing, not adapter logic.
    tasks: {
      submit: (input, callerProfileIds) =>
        opts.taskService.submit(input, callerProfileIds),
    },
    sessionLifecycle: {
      register: (sessionId, userId, profileId, regOpts) =>
        opts.sessionRegistry.register(
          sessionId,
          null,
          userId,
          profileId,
          regOpts?.persistent,
          regOpts?.orgId,
        ),
      extendExpiry: (sessionId, expiresAtIso) =>
        opts.sessionRegistry.extendExpiry(sessionId, expiresAtIso),
      setStatus: (sessionId, status) =>
        opts.sessionRegistry.setStatus(sessionId, status),
      getConnectedSessionIds: () => opts.sessionRegistry.getConnectedSessionIds(),
    },
    orchestrator: {
      wakeWorkspaceContainer: (sessionId, profile) =>
        opts.orchestrator.wakeWorkspaceContainer(sessionId, profile),
    },
    eventLog: {
      append: (sessionId, type, data) =>
        opts.eventLog.append(sessionId, type, data),
      read: (sessionId, afterSeq) => opts.eventLog.read(sessionId, afterSeq),
    },
    connectionManager: {
      sendToSession: (sessionId, message) =>
        opts.connectionManager.sendToSession(sessionId, message),
    },
    imageRewriter: {
      forSession: (sessionId, text) =>
        opts.imageRewriterService.forSession(sessionId, text),
    },
    modelList: {
      listForProfile: (profileId) =>
        opts.modelListService.listForProfile(profileId),
    },
    profileResolver: {
      getResolved: (profileId) => opts.profileService.getResolved(profileId),
    },
  };

  // ── Capability membrane over `core` ──────────────────────────────
  const { core } = assembleCore(fullCore, { pluginName: plugin.name, granted, onViolation });

  // ── Non-core ctx surfaces: conditional inclusion (§7 framing) ────
  const stub = <T>(cap: PluginCapability, surface: string): T =>
    throwingSurface<T>(plugin.name, cap, surface, onViolation);

  const storage = granted.has("storage.kv")
    ? makePluginStorage(opts.handle, plugin.name)
    : stub<import("@vonzio/plugin-api").PluginStorageKv>("storage.kv", "storage");

  const http = granted.has("http.outbound")
    ? makePluginHttp({
        pluginName: plugin.name,
        grantedHosts,
        mtlsMaterial,
        onCall: (l) => emitOutboundCall(log, l),
        onViolation: (i) => emitOutboundViolation(log, i),
      })
    : stub<import("@vonzio/plugin-api").PluginHttp>("http.outbound", "http");

  const secrets = granted.has("secrets.mtls")
    ? makePluginSecrets({
        pluginName: plugin.name,
        declaredNames: new Set(mtlsMaterial.keys()),
        onResolve: (i) => emitMtlsResolve(log, i),
      })
    : stub<PluginSecrets>("secrets.mtls", "secrets");

  const notificationBus = granted.has("notifications.channel")
    ? opts.notificationBus
    : stub<NotificationBusImpl>("notifications.channel", "notificationBus");

  const mcpRegistry = granted.has("mcp.register")
    ? opts.mcpRegistry
    : stub<McpRegistryImpl>("mcp.register", "mcpRegistry");

  const scheduler = granted.has("scheduler.run")
    ? opts.scheduler
    : stub<SchedulerImpl>("scheduler.run", "scheduler");

  const sessionEvents = granted.has("events.subscribe")
    ? buildSessionEventsFacade(opts.sessionEventEmitter)
    : stub<import("@vonzio/plugin-api").SessionEvents>("events.subscribe", "sessionEvents");

  return {
    // Placeholder; registerPluginRoutes injects the per-plugin Fastify child.
    server: opts.server,
    config: parsedConfig,
    log: pluginLog,
    core,
    storage,
    http,
    secrets,
    notificationBus,
    mcpRegistry,
    scheduler,
    sessionEvents,
  };
}

/**
 * Wrap the raw EventEmitter in a typed shape that matches the
 * SessionEvents contract from plugin-api. When no emitter is
 * provided (test setups), build a no-op facade so subscribers don't
 * have to defensive-check.
 */
export function buildSessionEventsFacade(emitter: SessionEventEmitterLike | undefined): import("@vonzio/plugin-api").SessionEvents {
  if (!emitter) {
    return {
      on: () => {},
      off: () => {},
    };
  }
  return {
    on: (event, handler) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      emitter.on(event, handler as (...args: any[]) => void);
    },
    off: (event, handler) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      emitter.off(event, handler as (...args: any[]) => void);
    },
  };
}

/**
 * Wraps the pino-style server logger to match the PluginLogger
 * contract while pre-tagging every line with the plugin name.
 */
function makePluginLogger(serverLog: FastifyInstance["log"], pluginName: string): PluginLogger {
  const child = serverLog.child({ plugin: pluginName });
  // pino's signature is (obj, msg) OR (msg) -- plugin-api allows both
  // shapes so a plugin can write log.info("x") or log.info({ a: 1 }, "x").
  const adapt = (level: "info" | "warn" | "error" | "debug") =>
    (meta: Record<string, unknown> | string, msg?: string): void => {
      if (typeof meta === "string") child[level](meta);
      else child[level](meta, msg);
    };
  return {
    info: adapt("info"),
    warn: adapt("warn"),
    error: adapt("error"),
    debug: adapt("debug"),
  };
}

/**
 * Best-effort teardown of every loaded plugin. Called from core's
 * shutdown handler. Plugin teardown errors are logged but never
 * propagated -- a stuck teardown shouldn't block process exit.
 */
export async function teardownPlugins(loaded: LoadedPlugin[], log: FastifyInstance["log"]): Promise<void> {
  for (const { plugin } of loaded) {
    if (!plugin.teardown) continue;
    try {
      await plugin.teardown();
      log.info({ plugin: plugin.name }, "[plugins] teardown ok");
    } catch (err) {
      log.error(
        { plugin: plugin.name, err: err instanceof Error ? err.message : String(err) },
        "[plugins] teardown threw",
      );
    }
  }
}
