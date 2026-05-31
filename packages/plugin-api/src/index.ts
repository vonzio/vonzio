// Plugin contract for vonzio. A plugin is a self-contained npm package
// that the loader in core-server imports at boot, parses config for,
// applies migrations from, and calls init() on. From there the plugin
// registers routes / notification handlers / MCP servers / background
// jobs to integrate with the host runtime.
//
// This file is the SURFACE plugin authors program against. Keep it
// minimal -- once shipped, breaking changes require a major bump and
// a migration guide.

import type { FastifyInstance } from "fastify";

/**
 * Current plugin-api version. Plugins encode the version they were
 * built against in `VonzioPlugin.apiVersion`; the loader rejects plugins
 * whose major version exceeds core's (see `assertApiCompatible`).
 */
export const PLUGIN_API_VERSION = "0.1.0";

/**
 * The shape every plugin's default export must satisfy. Generic over
 * the plugin's own config type so init() receives a fully-typed config.
 */
export interface VonzioPlugin<TConfig = unknown> {
  /**
   * Stable identifier. Used for the auto-route prefix, log scope, and
   * the migration namespace in the `_migrations` table. Conventionally
   * matches the npm package's unscoped name (e.g. `telegram` for
   * `@vonzio/plugin-telegram`).
   */
  name: string;

  /**
   * Semver of `@vonzio/plugin-api` this plugin was built against. The
   * loader compares the major against core's PLUGIN_API_VERSION and
   * refuses to load plugins targeting a newer major.
   */
  apiVersion: string;

  /**
   * Zod schema for the plugin's env-derived config. The loader calls
   * `.parse(process.env)` on it and rejects malformed values with a
   * useful error. Plugins should namespace their env vars
   * (`SLACK_CLIENT_ID`, `TELLER_API_KEY`, etc.) to avoid collisions.
   *
   * Typed as `ConfigSchemaLike` (a structural shape with just
   * `.parse()`) rather than `z.ZodType<TConfig>` for two reasons:
   *  1. The workspace can have zod v3 and v4 simultaneously (different
   *     deps pin different majors); using zod's strong types here
   *     would force every plugin's schema to be the same major
   *     instance as plugin-api's.
   *  2. ZodObject is technically a ZodType subtype, but TS variance
   *     rules reject ZodObject<T> as a ZodType<T> in many cases.
   * The plugin's TConfig flows from `.parse()`'s return value at the
   * use site, so typing stays useful where it matters.
   */
  configSchema: ConfigSchemaLike<TConfig>;

  /**
   * SQL migrations owned by this plugin. The core migration runner
   * applies them in order interleaved with core's own, tagged in
   * `_migrations` as `<plugin-name>_<migration-name>`. Plugins should
   * keep migrations idempotent (CREATE TABLE IF NOT EXISTS, etc.) so
   * partial-apply failures don't poison subsequent boots.
   */
  migrations?: PluginMigration[];

  /**
   * Where this plugin's routes live in the URL space. Default
   * (`{ kind: "auto" }`) mounts everything under `/plugins/<name>/*`.
   * Plugins with externally-registered URLs (Slack OAuth callback,
   * Telegram webhook secret in the Telegram app config, etc.) can
   * use `{ kind: "absolute", prefix }` to keep their legacy URLs and
   * avoid forcing every self-hoster to update their third-party app
   * configuration.
   */
  routePrefix?: PluginRoutePrefix;

  /**
   * Called once at server boot, after config parsing and after this
   * plugin's migrations have been applied. The plugin registers its
   * handlers via `ctx.server`, `ctx.notificationBus`,
   * `ctx.mcpRegistry`, and `ctx.scheduler`. init() must not block on
   * external services (e.g. an API call) -- those belong in scheduled
   * jobs or lazy on-first-request initialization, so a flaky upstream
   * doesn't block server startup.
   */
  init: (ctx: PluginContext<TConfig>) => Promise<void> | void;

  /**
   * Called on graceful server shutdown. Plugins MUST clear timers,
   * cancel intervals, close sockets, and stop any worker threads they
   * spawned. The scheduler-registered jobs are cancelled by core
   * automatically, but anything the plugin spawned outside that
   * channel is its own responsibility.
   */
  teardown?: () => Promise<void> | void;
}

/**
 * Where the plugin's routes live. `auto` mounts under
 * `/plugins/<plugin-name>/*` which is the recommended default --
 * keeps URLs collision-free and self-documenting. `absolute` is the
 * escape hatch for plugins that need a stable legacy URL (e.g. Slack
 * OAuth callback is registered in the Slack app config; changing it
 * would force every self-hoster to update their Slack app).
 */
export type PluginRoutePrefix =
  | { kind: "auto" }
  | { kind: "absolute"; prefix: string };

/**
 * One SQL migration. The core migration runner applies these in the
 * order the plugin lists them, and records `<plugin-name>_<name>` in
 * the `_migrations` table so a partial apply can resume cleanly.
 */
export interface PluginMigration {
  /**
   * Migration name. Conventionally `NNNN_short_description.sql`-style
   * (e.g. `0001_initial_schema`, `0002_add_thread_label`).
   * Combined with the plugin name to form the key core stores.
   */
  name: string;
  /** Idempotent SQL. Plugins should use CREATE ... IF NOT EXISTS etc. */
  up: string;
}

/**
 * What init() receives. Everything a plugin needs to integrate with
 * core lives here -- plugins should never `import` from
 * `@vonzio/core-server` directly.
 */
export interface PluginContext<TConfig = unknown> {
  /**
   * Fastify scope. Routes registered here are auto-prefixed if the
   * plugin uses the default `routePrefix`. The plugin still owns the
   * relative URL space inside its prefix.
   */
  server: FastifyInstance;

  /** The result of `configSchema.parse(process.env)`. */
  config: TConfig;

  /** Logger pre-tagged with `{ plugin: name }`. */
  log: PluginLogger;

  /** Versioned access to core services. */
  core: PluginCore;

  /** Where the plugin claims a notification channel kind. */
  notificationBus: NotificationBus;

  /** Where the plugin contributes an MCP server. */
  mcpRegistry: McpRegistry;

  /** Where the plugin schedules background work. */
  scheduler: Scheduler;
}

/**
 * Core services exposed to plugins. Add fields here only with strong
 * justification -- the surface is a stability commitment.
 */
export interface PluginCore {
  /**
   * Drizzle handle. Plugins should only query their own tables; cross-
   * table access requires going through a documented core call (none
   * yet defined for v0.1). Typed as `unknown` in the contract -- the
   * loader injects the real handle. Plugins cast to
   * `NodePgDatabase<typeof pluginSchema>`.
   */
  db: unknown;

  /**
   * AES-256-GCM wrapper around the master vault key. Use this for
   * any plugin-owned secret that lands in the DB (OAuth tokens, API
   * keys, bot tokens). Never log decrypted values; never persist them
   * outside the encryption flow.
   */
  encryption: {
    encrypt(plaintext: string): string;
    decrypt(ciphertext: string): string;
  };
}

/** Minimal logger contract. Backed by core's pino logger at runtime. */
export interface PluginLogger {
  info(meta: Record<string, unknown> | string, msg?: string): void;
  warn(meta: Record<string, unknown> | string, msg?: string): void;
  error(meta: Record<string, unknown> | string, msg?: string): void;
  debug(meta: Record<string, unknown> | string, msg?: string): void;
}

/**
 * One outbound notification request. Core services hand these to the
 * notification bus, which dispatches to whichever plugin claimed the
 * `kind`.
 */
export interface NotificationRequest {
  /**
   * The channel family this request targets. Plugins claim a kind in
   * `init()` via `notificationBus.registerHandler(kind, handler)`.
   * Examples: `"telegram"`, `"slack"`, `"email"`.
   */
  kind: string;

  /**
   * Plugin-specific recipient identifier. For most plugins this is
   * the user-integration id; the plugin uses it to look up the right
   * bot token, channel, thread, etc. in its own DB.
   */
  recipient: string;

  /** Human-readable body. Plugins may format-translate before sending. */
  text: string;

  /** Free-form per-message metadata (e.g. priority, thread anchors). */
  metadata?: Record<string, unknown>;
}

/**
 * Plugin-side notification handler. Returns a result so callers (and
 * core's retry/circuit-breaker machinery) can react. Never throws --
 * unexpected errors should be wrapped into `{ ok: false, retryable }`.
 */
export type NotificationHandler = (
  req: NotificationRequest,
) => Promise<NotificationResult>;

export type NotificationResult =
  | { ok: true }
  | { ok: false; error: string; retryable: boolean };

/**
 * Where plugins register notification handlers. One handler per
 * kind -- attempting to register a second handler for the same kind
 * is an error (caught at boot).
 */
export interface NotificationBus {
  registerHandler(kind: string, handler: NotificationHandler): void;
}

/**
 * Spec for an MCP server the plugin contributes. The loader hands
 * these to the core MCP runtime, which exposes them to agents
 * according to the agent's profile config.
 */
export interface McpServerSpec {
  /** Identifier shown in agent-side MCP listings. */
  name: string;
  /**
   * How agents reach the server. `stdio` = spawn a process per agent
   * session; `http` = a single endpoint reachable by all sessions.
   */
  transport:
    | {
        type: "stdio";
        command: string;
        args?: string[];
        env?: Record<string, string>;
      }
    | { type: "http"; url: string };
}

export interface McpRegistry {
  registerServer(spec: McpServerSpec): void;
}

/**
 * Scheduled work the plugin owns. Core cancels everything registered
 * here during teardown; plugins don't need to track timer handles.
 */
export interface Scheduler {
  /**
   * Standard 5-field cron expression, evaluated in UTC. `name` is for
   * logging + dedup -- registering the same name twice is an error.
   */
  cron(name: string, schedule: string, fn: () => Promise<void>): void;
  /**
   * Fixed-interval job. `ms` is the gap BETWEEN runs (not from start),
   * so a slow fn won't queue up backlog.
   */
  interval(name: string, ms: number, fn: () => Promise<void>): void;
}

export { assertApiCompatible } from "./version.js";

/**
 * Structural shape the loader needs from a plugin's `configSchema`.
 * Both zod v3 and v4 satisfy this naturally -- they both expose a
 * `parse(input): T` method. Plugins typically use `z.object({...})`
 * which yields a `ZodObject` whose `.parse()` returns the inferred
 * shape; the inference flows into TConfig.
 */
export interface ConfigSchemaLike<TConfig> {
  parse(input: unknown): TConfig;
}
