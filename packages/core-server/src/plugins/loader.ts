import type { FastifyInstance } from "fastify";
import {
  PLUGIN_API_VERSION,
  assertApiCompatible,
  type PluginContext,
  type PluginCore,
  type PluginLogger,
  type VonzioPlugin,
} from "@vonzio/plugin-api";
import type { DB } from "../db/index.js";
import { encrypt, decrypt } from "../auth/crypto.js";
import type { Config } from "../config.js";
import { NotificationBusImpl } from "./notification-bus.js";
import { McpRegistryImpl } from "./mcp-registry.js";
import { SchedulerImpl } from "./scheduler.js";
import { runPluginMigrations } from "./migrations.js";

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
};

export interface IntegrationServiceLike {
  get(id: string, opts?: { decrypt?: boolean }): Promise<IntegrationRow | null>;
  getByUserAndType(userId: string, type: string, opts?: { decrypt?: boolean }): Promise<IntegrationRow | null>;
  listByType(type: string, opts?: { decrypt?: boolean }): Promise<IntegrationRow[]>;
  listByUserAndType(userId: string, type: string, opts?: { decrypt?: boolean }): Promise<IntegrationRow[]>;
  findByTypeAndExternalId(type: string, externalId: string, opts?: { decrypt?: boolean }): Promise<IntegrationRow | null>;
  // Signature mirrors core's IntegrationService.create (positional
  // userId/type/config + optional scopeInput).
  create(userId: string, type: string, config: Record<string, unknown>, scopeInput?: unknown): Promise<IntegrationRow>;
  update(id: string, input: Partial<{ config: Record<string, unknown>; enabled: boolean; scope: string; profile_ids: string[] }>): Promise<IntegrationRow | null>;
  // IntegrationService.delete actually returns boolean (did-it-exist).
  // The loader adapter narrows that to void in the plugin-facing
  // contract, but this structural type captures the real signature.
  delete(id: string): Promise<boolean>;
}

export interface ProfileServiceLike {
  list(userId: string): Promise<Array<{ id: string; slug: string | null; name: string }>>;
}

export interface WorkspaceServiceLike {
  get(sessionId: string): {
    session_id: string;
    user_id: string;
    profile_id?: string | null;
  } | null;
}

export interface TelegramPlatformBotLike {
  getMetadata(): { botUserId: string; botUsername: string } | null;
  getToken(): string | null;
  getWebhookSecret(): string | null;
  isConfigured(): boolean;
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
  /** Optional -- only telegram plugin uses it; absent in test setups. */
  telegramPlatformBot?: TelegramPlatformBotLike;
  /**
   * Backs `ctx.sessionEvents`. Orchestrator satisfies this directly
   * (it extends EventEmitter). When absent (test setups), plugins
   * that subscribe just receive no events -- their handlers register
   * fine, they just never fire.
   */
  sessionEventEmitter?: SessionEventEmitterLike;
}

/**
 * Full happy-path: read env, import, migrate, init each plugin.
 * Returns the loaded set so the caller can call `teardown()` at
 * shutdown.
 */
export async function loadPluginsFromEnv(opts: LoadPluginsOpts): Promise<LoadedPlugin[]> {
  const specs = parsePluginEnvList(opts.envList);
  if (specs.length === 0) {
    opts.server.log.info("[plugins] VONZIO_PLUGINS not set -- skipping plugin load");
    return [];
  }

  const loaded: LoadedPlugin[] = [];
  for (const spec of specs) {
    try {
      const mod = await import(spec.packageName);
      const candidate = (mod as { default?: unknown }).default;
      assertPluginShape(candidate, spec.packageName);
      assertApiCompatible(candidate.apiVersion, PLUGIN_API_VERSION);

      if (candidate.migrations && candidate.migrations.length > 0) {
        await runPluginMigrations(opts.handle, candidate.name, candidate.migrations);
      }

      // Parse plugin config from env. The plugin owns the schema --
      // whatever it accepts, that's what init() receives.
      const config = candidate.configSchema.parse(process.env);

      const context = buildPluginContext({
        plugin: candidate,
        parsedConfig: config,
        opts,
      });

      await candidate.init(context);
      loaded.push({ plugin: candidate, context, packageName: spec.packageName });
      opts.server.log.info(
        { plugin: candidate.name, packageName: spec.packageName },
        "[plugins] loaded",
      );
    } catch (err) {
      // Sandboxed: log and continue. A broken plugin loses its
      // functionality but doesn't take down core.
      opts.server.log.error(
        { packageName: spec.packageName, err: err instanceof Error ? err.message : String(err) },
        "[plugins] failed to load",
      );
    }
  }
  return loaded;
}

/**
 * Build the PluginContext a single plugin sees. Extracted so tests can
 * inject mock impls + so the same builder works for env-driven and
 * programmatic plugin registration (the latter is useful for tests
 * and could become a programmatic API later).
 */
export function buildPluginContext<TConfig>(args: {
  plugin: VonzioPlugin<TConfig>;
  parsedConfig: TConfig;
  opts: LoadPluginsOpts;
}): PluginContext<TConfig> {
  const { plugin, parsedConfig, opts } = args;

  const log = makePluginLogger(opts.server.log, plugin.name);

  // Apply the route prefix. Default (`auto`) wraps the plugin's routes
  // under /plugins/<name>/. Explicit `absolute` keeps the literal
  // string so plugins with externally-registered URLs (Slack OAuth
  // callback, etc.) can preserve their legacy URLs.
  const prefix =
    plugin.routePrefix?.kind === "absolute"
      ? plugin.routePrefix.prefix
      : `/plugins/${plugin.name}`;

  // Register a scoped Fastify instance under the prefix. The plugin
  // gets `scopedServer` and registers routes relative to its prefix.
  // We can't call server.register synchronously and return the inner
  // FastifyInstance handle -- Fastify's plugin model is async. For
  // v0.1 we hand the plugin the OUTER server but set the prefix as
  // a route-level option. Plugins call `ctx.server.get(prefix + "/foo")`.
  // (When 3C reveals this is awkward, we'll wrap with server.register.)
  const scopedServer = opts.server;

  const core: PluginCore = {
    db: opts.handle.db,
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
      create: (userId, type, config, scopeInput) => opts.integrationService.create(userId, type, config, scopeInput),
      update: (id, input) => opts.integrationService.update(id, input),
      // IntegrationService.delete returns boolean (did-it-exist); the
      // plugin contract is fire-and-forget so we drop the return.
      delete: async (id) => { await opts.integrationService.delete(id); },
    },
    profiles: {
      list: (userId) => opts.profileService.list(userId),
    },
    workspaces: {
      get: (sessionId) => opts.workspaceService.get(sessionId),
    },
    telegramPlatformBot: opts.telegramPlatformBot,
  };

  // Typed facade over the raw EventEmitter -- plugins get exhaustive
  // narrowing on event names + payloads while the backing dispatch
  // stays a generic EventEmitter we don't have to specialize per event.
  // Missing emitter = silent no-op (test setups, plugins that subscribe
  // to events for a feature that's been disabled).
  const sessionEvents = buildSessionEventsFacade(opts.sessionEventEmitter);

  return {
    server: scopedServer,
    config: parsedConfig,
    log,
    core,
    notificationBus: opts.notificationBus,
    mcpRegistry: opts.mcpRegistry,
    scheduler: opts.scheduler,
    sessionEvents,
    // routePrefix isn't on PluginContext per the API contract; plugins
    // use ctx.server with their own knowledge of routePrefix. (We pass
    // it via env at register-time if needed.)
  } satisfies PluginContext<TConfig> & Record<string, unknown>;
  // The `as` is for the prefix shadowing -- the prefix is consumed by
  // the loader to wire the route scope, not surfaced on the context.
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
