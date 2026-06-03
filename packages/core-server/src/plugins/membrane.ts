// The capability membrane. Builds the per-plugin `ctx.core` object from the
// set of GRANTED capabilities (declared ∩ approved) and wraps it in a
// revocable Proxy that throws on access to any undeclared surface.
//
// FRAMING (docs/PLUGIN_LOADER_SPEC.md §2, §7): this is hygiene against honest
// mistakes + runtime legibility, NOT a sandbox. A plugin can defeat it with
// `require('@vonzio/core-server')` directly; the loader cannot prevent that
// without out-of-process isolation (v2). What the membrane guarantees is that
// the supplied `ctx.core` reference exposes ONLY granted surfaces, and that
// any attempt to reach beyond them via this reference throws + is audited.
//
// Two structural facts the spec under-specifies, handled here (Plan-agent
// findings):
//  1. Several capabilities are METHOD- or ARGUMENT-level within one core
//     property (encryption.encrypt vs decrypt; integrations masked vs
//     decrypted vs write; workspaces read vs write; sessions.*; events.*). A
//     property-access Proxy cannot split those, so `core` is assembled
//     method-by-method from the granted set; non-granted methods are throwing
//     stubs that name the missing capability.
//  2. Leaf service objects stay PLAIN (not themselves proxied) so the
//     built-ins' `{...ctx.core.profiles}` spreads keep working.

import { CapabilityViolationError, type PluginCapability } from "@vonzio/plugin-api";
import type { PluginCore } from "@vonzio/plugin-api";

/** Emitted on every membrane / stub capability violation (wired to audit in C8/C9). */
export interface CapabilityViolation {
  plugin: string;
  capability: string | null;
  key: string;
}

export type OnViolation = (v: CapabilityViolation) => void;

/** Property-level core surfaces: the whole object is included iff the cap is
 *  granted. (db.scoped/db.access both map to `db`; the loader has already
 *  placed the correctly-scoped handle on fullCore.db.) */
const PROPERTY_SURFACES: ReadonlyArray<{ cap: PluginCapability; key: keyof PluginCore }> = [
  { cap: "db.scoped", key: "db" },
  { cap: "db.access", key: "db" },
  { cap: "profiles.read", key: "profiles" },
  { cap: "profiles.resolve", key: "profileResolver" },
  { cap: "auth.gate", key: "authHook" },
  { cap: "presence.register", key: "sessionPresence" },
  { cap: "tasks.submit", key: "tasks" },
  { cap: "orchestrator.wake", key: "orchestrator" },
  { cap: "dashboard.push", key: "connectionManager" },
  { cap: "images.rewrite", key: "imageRewriter" },
  { cap: "models.list", key: "modelList" },
];

/** Method-level core surfaces: each method gated by its own capability.
 *  Integrations is handled separately (argument-level masking). */
const METHOD_SURFACES: ReadonlyArray<{
  key: keyof PluginCore;
  methods: ReadonlyArray<{ method: string; cap: PluginCapability }>;
}> = [
  {
    key: "encryption",
    methods: [
      { method: "encrypt", cap: "encryption.encrypt" },
      { method: "decrypt", cap: "encryption.decrypt" },
    ],
  },
  {
    key: "workspaces",
    methods: [
      { method: "get", cap: "workspaces.read" },
      { method: "list", cap: "workspaces.read" },
      { method: "update", cap: "workspaces.write" },
    ],
  },
  {
    key: "sessionLifecycle",
    methods: [
      { method: "register", cap: "sessions.register" },
      { method: "extendExpiry", cap: "sessions.extend" },
      { method: "setStatus", cap: "sessions.setStatus" },
      { method: "getConnectedSessionIds", cap: "sessions.getConnectedIds" },
    ],
  },
  {
    key: "eventLog",
    methods: [
      { method: "append", cap: "events.append" },
      { method: "read", cap: "events.read" },
    ],
  },
];

/** Read methods on core.integrations gated by the masked/decrypted caps. */
const INTEGRATION_READ_METHODS = [
  "get",
  "getByUserAndType",
  "listByType",
  "listByUserAndType",
  "findByTypeAndExternalId",
  "listByTypeAndExternalId",
  "backfillExternalId",
] as const;
/** Write methods on core.integrations gated by integrations.write. */
const INTEGRATION_WRITE_METHODS = ["create", "update", "delete"] as const;

function makeMethodStub(
  pluginName: string,
  capability: PluginCapability,
  key: string,
  onViolation?: OnViolation,
): (...args: unknown[]) => never {
  return (..._args: unknown[]): never => {
    onViolation?.({ plugin: pluginName, capability, key });
    throw new CapabilityViolationError({ plugin: pluginName, capability, key });
  };
}

export interface AssembleCoreOpts {
  pluginName: string;
  granted: ReadonlySet<PluginCapability>;
  onViolation?: OnViolation;
}

export interface AssembledCore {
  /** The membrane: a revocable Proxy typed as PluginCore. */
  core: PluginCore;
  /** Revoke the proxy (v2 hot-reload prep; v1 uses it only in tests). */
  revoke: () => void;
}

/**
 * Build the gated `core` object + wrap it in a revocable legibility Proxy.
 * `fullCore` is the complete ungated PluginCore the loader constructs today;
 * the loader is responsible for having already placed the correctly-scoped DB
 * handle on `fullCore.db`.
 */
export function assembleCore(fullCore: PluginCore, opts: AssembleCoreOpts): AssembledCore {
  const { pluginName, granted, onViolation } = opts;
  const has = (c: PluginCapability): boolean => granted.has(c);

  // Null-proto target so the Proxy's getPrototypeOf returns null (no
  // constructor recon) WITHOUT violating the non-extensible-target invariant
  // that a frozen object imposes. Only granted surfaces become own keys.
  const target: Record<string, unknown> = Object.create(null);

  // ── Property-level surfaces ──────────────────────────────────────
  for (const { cap, key } of PROPERTY_SURFACES) {
    if (has(cap)) target[key as string] = fullCore[key];
  }

  // ── Method-level surfaces ────────────────────────────────────────
  for (const { key, methods } of METHOD_SURFACES) {
    const anyGranted = methods.some((m) => has(m.cap));
    if (!anyGranted) continue; // omit -> top-level get-trap throws on access
    const sub: Record<string, unknown> = {};
    const source = fullCore[key] as unknown as Record<string, unknown>;
    for (const { method, cap } of methods) {
      sub[method] = has(cap)
        ? (source[method] as (...a: unknown[]) => unknown).bind(source)
        : makeMethodStub(pluginName, cap, `${String(key)}.${method}`, onViolation);
    }
    target[key as string] = sub;
  }

  // ── Integrations (argument-level masking) ────────────────────────
  const canReadDecrypted = has("integrations.read.decrypted");
  const canReadMasked = has("integrations.read.masked");
  const canWrite = has("integrations.write");
  if (canReadDecrypted || canReadMasked || canWrite) {
    const src = fullCore.integrations as unknown as Record<string, (...a: unknown[]) => unknown>;
    const sub: Record<string, unknown> = {};
    for (const m of INTEGRATION_READ_METHODS) {
      if (canReadDecrypted || canReadMasked) {
        sub[m] = wrapIntegrationRead(src[m].bind(src), m, canReadDecrypted);
      } else {
        // write-only plugin reaching a read method
        sub[m] = makeMethodStub(pluginName, "integrations.read.masked", `integrations.${m}`, onViolation);
      }
    }
    for (const m of INTEGRATION_WRITE_METHODS) {
      sub[m] = canWrite
        ? src[m].bind(src)
        : makeMethodStub(pluginName, "integrations.write", `integrations.${m}`, onViolation);
    }
    target.integrations = sub;
  }

  Object.freeze(target);
  const declaredKeys = new Set(Object.keys(target));

  const { proxy, revoke } = Proxy.revocable(target, {
    get(t, key, recv) {
      if (typeof key === "symbol") return Reflect.get(t, key, recv);
      if (declaredKeys.has(key)) return Reflect.get(t, key, recv);
      // Undeclared string property: throw at the access site. `key` is a core
      // surface name (e.g. "db"), not a capability, so capability is null.
      onViolation?.({ plugin: pluginName, capability: null, key });
      throw new CapabilityViolationError({ plugin: pluginName, capability: null, key });
    },
    set(_t, key) {
      throw new CapabilityViolationError({
        plugin: pluginName,
        capability: null,
        key: `set ${String(key)}`,
      });
    },
    defineProperty(_t, key) {
      throw new CapabilityViolationError({
        plugin: pluginName,
        capability: null,
        key: `defineProperty ${String(key)}`,
      });
    },
    setPrototypeOf() {
      throw new CapabilityViolationError({ plugin: pluginName, capability: null, key: "setPrototypeOf" });
    },
    // has / ownKeys / getOwnPropertyDescriptor / getPrototypeOf default to
    // Reflect on the null-proto frozen target — already legible (only declared
    // keys; prototype null) and invariant-safe.
  });

  return { core: proxy as unknown as PluginCore, revoke };
}

/**
 * Wrap one integration read method to enforce the masked/decrypted split.
 * Masked-only callers have `opts.decrypt` clamped to false, so the service
 * returns config with secret fields still encrypted (opaque) rather than
 * plaintext. (v1 masking = "not decrypted"; sentinel replacement is a cosmetic
 * follow-up — ciphertext is already non-usable. No built-in uses masked-only;
 * this path is corpus-validated.)
 */
function wrapIntegrationRead(
  fn: (...args: unknown[]) => unknown,
  method: string,
  allowDecrypt: boolean,
): (...args: unknown[]) => unknown {
  // backfillExternalId(id) takes no opts and returns void; pass through.
  if (method === "backfillExternalId") return fn;
  return (...args: unknown[]) => {
    if (!allowDecrypt) {
      // The last arg is the opts object for every read method
      // (get(id, opts), getByUserAndType(userId, type, opts), ...). Clamp it.
      const last = args[args.length - 1];
      if (last && typeof last === "object" && !Array.isArray(last)) {
        args[args.length - 1] = { ...(last as Record<string, unknown>), decrypt: false };
      }
      // If no opts object was passed, the service defaults decrypt to false
      // already, so nothing to clamp.
    }
    return fn(...args);
  };
}

/**
 * A throwing stand-in for a NON-core ctx surface (ctx.storage, ctx.http,
 * ctx.notificationBus, ctx.mcpRegistry, ctx.scheduler, ctx.sessionEvents) that
 * the plugin did not get granted. The membrane only wraps `ctx.core`; these
 * top-level surfaces are gated by conditional inclusion in the loader, which
 * substitutes this stub so access throws a clean CapabilityViolationError
 * instead of a TypeError. Typed as `T` for the call site.
 */
export function throwingSurface<T>(
  pluginName: string,
  capability: PluginCapability,
  surfaceName: string,
  onViolation?: OnViolation,
): T {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_t, key) {
      if (typeof key === "symbol") return undefined;
      onViolation?.({ plugin: pluginName, capability, key: `${surfaceName}.${String(key)}` });
      throw new CapabilityViolationError({
        plugin: pluginName,
        capability,
        key: `${surfaceName}.${String(key)}`,
      });
    },
  };
  return new Proxy(Object.create(null) as Record<string, unknown>, handler) as T;
}
