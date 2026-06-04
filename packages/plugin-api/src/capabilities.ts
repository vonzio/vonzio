// Plugin capability enum + the surface map that routes each capability to
// the `ctx` / `ctx.core` surface it unlocks. This file is the SINGLE SOURCE
// OF TRUTH consumed by the loader (to validate manifests + cross-check the
// operator policy) and by the membrane (to assemble the per-plugin `core`
// object method-by-method and to decide which non-core `ctx` surfaces to
// attach).
//
// The runtime array `PLUGIN_CAPABILITIES` is authoritative; the
// `PluginCapability` type is derived from it so a completeness test can
// iterate every member and the map can be a total `Record`.

/**
 * Every capability a plugin may declare, as a runtime-iterable tuple.
 * Adding a capability is additive (minor bump); removing/renaming is
 * breaking (major bump). Keep the ordering grouped by domain to match §5.
 */
export const PLUGIN_CAPABILITIES = [
  // ── Storage (preferred for new plugins) ──────────────────────────
  "storage.kv",

  // ── Database (use sparingly) ─────────────────────────────────────
  "db.scoped",
  "db.access",

  // ── Crypto ───────────────────────────────────────────────────────
  "encryption.encrypt",
  "encryption.decrypt",

  // ── Integrations ─────────────────────────────────────────────────
  "integrations.read.masked",
  "integrations.read.decrypted",
  "integrations.write",

  // ── Profiles ─────────────────────────────────────────────────────
  "profiles.read",
  "profiles.resolve",

  // ── Workspaces ───────────────────────────────────────────────────
  "workspaces.read",
  "workspaces.write",

  // ── Auth ─────────────────────────────────────────────────────────
  "auth.gate",

  // ── Presence ─────────────────────────────────────────────────────
  "presence.register",

  // ── Tasks / sessions / orchestration ─────────────────────────────
  "tasks.submit",
  "sessions.register",
  "sessions.extend",
  "sessions.setStatus",
  "sessions.getConnectedIds",
  "orchestrator.wake",

  // ── Event log + dashboard push ───────────────────────────────────
  "events.append",
  "events.read",
  "events.subscribe",
  "dashboard.push",

  // ── Chat-surface utilities ───────────────────────────────────────
  "images.rewrite",
  "models.list",

  // ── Plugin-contributed surfaces ──────────────────────────────────
  "notifications.channel",
  "mcp.register",
  "scheduler.run",

  // ── Outbound HTTP ────────────────────────────────────────────────
  "http.outbound",

  // ── Secrets (operator-provisioned material) ──────────────────────
  "secrets.mtls",
] as const;

/**
 * The capability union. Derived from the runtime tuple so there is exactly
 * one place to edit. Total count: 31 (asserted by capabilities.test.ts).
 */
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

/** O(1) membership check used by the manifest validator. */
const CAPABILITY_SET: ReadonlySet<string> = new Set(PLUGIN_CAPABILITIES);

/** Type guard: is an arbitrary string a known capability? */
export function isPluginCapability(value: string): value is PluginCapability {
  return CAPABILITY_SET.has(value);
}

/**
 * How a capability is enforced against its surface.
 *  - `property`: the whole surface object is included iff the cap is granted.
 *    A property-access Proxy can gate this on its own.
 *  - `method`: the cap unlocks specific named methods on a surface shared
 *    with other caps (e.g. `core.sessionLifecycle.register`). The membrane
 *    assembles the surface method-by-method; a property Proxy can't split it.
 *  - `argument`: the cap is distinguished from a sibling cap by a call
 *    ARGUMENT, not a method name (integrations masked-vs-decrypted via the
 *    `opts.decrypt` flag). The membrane wraps the methods to enforce/clamp
 *    the argument.
 */
export type SurfaceKind = "property" | "method" | "argument";

export interface CapabilitySurface {
  /**
   * Dotted surface path. `core.*` lives behind the legibility membrane
   * (`ctx.core`); `ctx.*` is a top-level context surface attached by
   * conditional inclusion (membrane only wraps `core`, so non-core
   * surfaces are gated by presence — see §7 + membrane.ts).
   */
  surface: string;
  kind: SurfaceKind;
  /**
   * For `method` / `argument` kinds: the methods on `surface` this cap
   * unlocks. Omitted for `property` (the whole surface is unlocked).
   */
  methods?: readonly string[];
  /** One-line description, mirrors the §5 doc comment. */
  description: string;
}

/**
 * Maps every capability to the surface it unlocks. Total `Record` over the
 * union — capabilities.test.ts asserts every member of PLUGIN_CAPABILITIES
 * has an entry so a newly-added capability can't ship ungated.
 *
 * Read-method names for `core.integrations` are shared by the masked and
 * decrypted caps; they differ only by the `opts.decrypt` argument the
 * membrane clamps. `backfillExternalId` is a read-path lazy index helper
 * and travels with the read caps.
 */
export const CAPABILITY_SURFACE_MAP: Record<PluginCapability, CapabilitySurface> = {
  "storage.kv": {
    surface: "ctx.storage",
    kind: "property",
    description: "Per-plugin namespaced key/value store backed by plugin_storage.",
  },
  "db.scoped": {
    surface: "core.db",
    kind: "property",
    description: "Scoped Drizzle handle restricted to manifest.schemaPrefix tables; raw SQL refused.",
  },
  "db.access": {
    surface: "core.db",
    kind: "property",
    description: "Unscoped Drizzle handle + raw SQL. Built-ins only.",
  },
  "encryption.encrypt": {
    surface: "core.encryption",
    kind: "method",
    methods: ["encrypt"],
    description: "Encrypt plugin-owned secrets for persistence.",
  },
  "encryption.decrypt": {
    surface: "core.encryption",
    kind: "method",
    methods: ["decrypt"],
    description: "Decrypt plugin-owned secrets.",
  },
  "integrations.read.masked": {
    surface: "core.integrations",
    kind: "argument",
    methods: [
      "get",
      "getByUserAndType",
      "listByType",
      "listByUserAndType",
      "findByTypeAndExternalId",
      "listByTypeAndExternalId",
      "backfillExternalId",
    ],
    description: "Read integration rows with secrets MASKED (opts.decrypt clamped to false).",
  },
  "integrations.read.decrypted": {
    surface: "core.integrations",
    kind: "argument",
    methods: [
      "get",
      "getByUserAndType",
      "listByType",
      "listByUserAndType",
      "findByTypeAndExternalId",
      "listByTypeAndExternalId",
      "backfillExternalId",
    ],
    description: "Read integration rows with secrets DECRYPTED. Highest-risk read.",
  },
  "integrations.write": {
    surface: "core.integrations",
    kind: "method",
    methods: ["create", "update", "delete"],
    description: "Create / update / delete integration rows.",
  },
  "profiles.read": {
    surface: "core.profiles",
    kind: "property",
    description: "Narrow read-only profile lookup (list / get).",
  },
  "profiles.resolve": {
    surface: "core.profileResolver",
    kind: "property",
    description: "Full ResolvedProfile lookup (credentials, env, setup_commands).",
  },
  "workspaces.read": {
    surface: "core.workspaces",
    kind: "method",
    methods: ["get", "list"],
    description: "Workspace get + list.",
  },
  "workspaces.write": {
    surface: "core.workspaces",
    kind: "method",
    methods: ["update"],
    description: "Workspace mutations (name, starred, archived, tags, model_override).",
  },
  "auth.gate": {
    surface: "core.authHook",
    kind: "property",
    description: "Opt route scopes into the user-auth hook.",
  },
  "presence.register": {
    surface: "core.sessionPresence",
    kind: "property",
    description: "Register a chat-surface presence provider.",
  },
  "tasks.submit": {
    surface: "core.tasks",
    kind: "property",
    description: "Submit new tasks.",
  },
  "sessions.register": {
    surface: "core.sessionLifecycle",
    kind: "method",
    methods: ["register"],
    description: "Register a new session row.",
  },
  "sessions.extend": {
    surface: "core.sessionLifecycle",
    kind: "method",
    methods: ["extendExpiry"],
    description: "Push session expiry forward.",
  },
  "sessions.setStatus": {
    surface: "core.sessionLifecycle",
    kind: "method",
    methods: ["setStatus"],
    description: "Move sessions between status states.",
  },
  "sessions.getConnectedIds": {
    surface: "core.sessionLifecycle",
    kind: "method",
    methods: ["getConnectedSessionIds"],
    description: "Read the set of dashboard-connected session ids.",
  },
  "orchestrator.wake": {
    surface: "core.orchestrator",
    kind: "property",
    description: "Wake a workspace container before submitting a task.",
  },
  "events.append": {
    surface: "core.eventLog",
    kind: "method",
    methods: ["append"],
    description: "Append entries to the dashboard timeline.",
  },
  "events.read": {
    surface: "core.eventLog",
    kind: "method",
    methods: ["read"],
    description: "Read entries from the dashboard timeline.",
  },
  "events.subscribe": {
    surface: "ctx.sessionEvents",
    kind: "property",
    description: "Subscribe to orchestrator session events (task:token, task:done).",
  },
  "dashboard.push": {
    surface: "core.connectionManager",
    kind: "property",
    description: "Push messages to dashboard WebSocket clients.",
  },
  "images.rewrite": {
    surface: "core.imageRewriter",
    kind: "property",
    description: "Strip inline images from agent output.",
  },
  "models.list": {
    surface: "core.modelList",
    kind: "property",
    description: "List models available to a profile.",
  },
  "notifications.channel": {
    surface: "ctx.notificationBus",
    kind: "property",
    description: 'Claim a notification kind ("telegram", "slack", "email").',
  },
  "mcp.register": {
    surface: "ctx.mcpRegistry",
    kind: "property",
    description: "Contribute an MCP server.",
  },
  "scheduler.run": {
    surface: "ctx.scheduler",
    kind: "property",
    description: "Register cron + interval scheduled work.",
  },
  "http.outbound": {
    surface: "ctx.http",
    kind: "property",
    description: "Use ctx.http.fetch. Requires manifest.outboundHosts populated.",
  },
  "secrets.mtls": {
    surface: "ctx.secrets",
    kind: "property",
    description:
      "Use ctx.secrets.mtls(name) to resolve an operator-provisioned mTLS client cert/key " +
      "(declared in manifest.mtlsSecrets, mapped to host files in policy) into an opaque ref " +
      "for ctx.http.fetch({ mtls }). The plugin never reads the key bytes.",
  },
};

/**
 * Capability pairs that are effectively root and are REFUSED for external
 * plugins at load (§3 step 9, §5). Built-ins are exempt. Each inner array
 * is an AND-set: an external plugin declaring all members is refused.
 *
 * `secrets.mtls` is deliberately NOT listed: the cert/key files are
 * operator-provisioned (policy-declared host paths the plugin can't choose)
 * and resolve to an OPAQUE ref the plugin can't read, so it can't exfiltrate
 * the key even alongside `integrations.read.decrypted` — the design-time
 * guarantee that motivates the combos above doesn't apply here.
 */
export const ROOT_EQUIVALENT_COMBINATIONS: ReadonlyArray<readonly PluginCapability[]> = [
  ["integrations.read.decrypted", "db.scoped"],
  ["integrations.read.decrypted", "db.access"],
];

/** Capabilities only built-in plugins may declare (§5). */
export const BUILTIN_ONLY_CAPABILITIES: ReadonlySet<PluginCapability> = new Set([
  "db.access",
]);
