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

  /**
   * Subscribe to session-lifecycle events emitted by the orchestrator.
   * Used by integrations that relay task progress to external
   * surfaces (e.g. Telegram chat, Slack thread).
   */
  sessionEvents: SessionEvents;
}

/**
 * One user's integration row, as seen by a plugin. Used by
 * notification handlers to resolve `req.recipient` (an integration
 * id) into the bot token / channel / chat id / etc. needed to send a
 * message.
 *
 * `config` is type-erased on this contract -- the actual shape is
 * provider-specific (Telegram: bot_token + owner_tg_user_id;
 * Slack: bot_token + authed_user_id; etc.) and is the plugin's
 * responsibility to assert. With `opts.decrypt: true` the loader
 * runs the standard decrypt pass against config before returning.
 */
export interface PluginIntegration {
  id: string;
  user_id: string;
  type: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

/**
 * Adapter around core's IntegrationService. Plugins use this to look
 * up + manage user-integration rows (Slack tokens, Telegram bots,
 * Gmail OAuth grants, etc.). All eight methods mirror core's
 * IntegrationService surface 1:1 -- the structural shape lets the
 * loader pass the real service through without leaking the concrete
 * class type into plugin-api.
 */
export interface PluginIntegrationLookup {
  get(id: string, opts?: { decrypt?: boolean }): Promise<PluginIntegration | null>;
  getByUserAndType(userId: string, type: string, opts?: { decrypt?: boolean }): Promise<PluginIntegration | null>;
  listByType(type: string, opts?: { decrypt?: boolean }): Promise<PluginIntegration[]>;
  listByUserAndType(userId: string, type: string, opts?: { decrypt?: boolean }): Promise<PluginIntegration[]>;
  findByTypeAndExternalId(type: string, externalId: string, opts?: { decrypt?: boolean }): Promise<PluginIntegration | null>;
  create(userId: string, type: string, config: Record<string, unknown>, scopeInput?: unknown): Promise<PluginIntegration>;
  update(id: string, input: Partial<{ config: Record<string, unknown>; enabled: boolean; scope: string; profile_ids: string[] }>): Promise<PluginIntegration | null>;
  delete(id: string): Promise<void>;
}

/**
 * Narrow read-only profile lookup. Plugins use this when validating
 * that a user-supplied profile_id (e.g. for binding a Telegram bot to
 * a specific agent profile) actually belongs to the caller.
 */
export interface PluginProfileLookup {
  list(userId: string): Promise<Array<{ id: string; slug: string | null; name: string }>>;
}

/**
 * Narrow read-only workspace lookup. Plugins use this when surfacing
 * workspace-bound resources (e.g. Telegram deep-links into a
 * workspace).
 */
export interface PluginWorkspaceLookup {
  get(sessionId: string): {
    session_id: string;
    user_id: string;
    profile_id?: string | null;
  } | null;
}

/**
 * Telegram-specific platform-bot surface. Transitional -- exposed on
 * PluginCore until telegram-events.ts moves into the plugin, at
 * which point PlatformBotService instantiation moves with it and
 * this field disappears from PluginCore. Until then, the telegram
 * plugin's setup routes need a reference to the in-core singleton
 * that telegram-events also holds, so we expose it here.
 *
 * Structural typing -- the concrete class lives in core-server's
 * services/. Other plugins ignore this field.
 */
export interface PluginTelegramPlatformBot {
  getMetadata(): { botUserId: string; botUsername: string } | null;
  getToken(): string | null;
  getWebhookSecret(): string | null;
  isConfigured(): boolean;
}

/**
 * Session-lifecycle events emitted by the orchestrator. Plugins
 * subscribe via `ctx.sessionEvents.on(event, handler)` to react to
 * task progress without core having to know they exist -- e.g. the
 * telegram plugin's relay echoes `task:token` to the user's Telegram
 * chat, and `task:done` posts the final result.
 *
 * The signatures mirror orchestrator's existing `emit("task:*", ...)`
 * calls exactly so the typed facade is a zero-overhead pass-through.
 * sessionId may be `undefined` for tasks not bound to a session
 * (one-off API calls); plugins typically early-return in that case.
 *
 * Handlers are NOT async-awaited by core -- they fire in parallel.
 * Plugins that need ordering must coordinate via their own queues.
 */
export interface SessionEvents {
  on(event: "task:token", handler: (taskId: string, sessionId: string | undefined, text: string) => void): void;
  on(event: "task:tool_use", handler: (taskId: string, sessionId: string | undefined, tool: string, input?: unknown) => void): void;
  on(event: "task:ask_user", handler: (taskId: string, sessionId: string | undefined, input: unknown) => void | Promise<void>): void;
  on(event: "task:done", handler: (taskId: string, sessionId: string | undefined, result?: { text?: string }) => void | Promise<void>): void;
  on(event: "task:failed", handler: (taskId: string, sessionId: string | undefined, error?: string) => void | Promise<void>): void;
  /**
   * Bulk unsubscribe -- called by core during plugin teardown so a
   * reloaded plugin doesn't double up subscriptions. Plugins normally
   * don't call this themselves.
   */
  off(event: SessionEventName, handler: (...args: never[]) => void): void;
}

export type SessionEventName =
  | "task:token"
  | "task:tool_use"
  | "task:ask_user"
  | "task:done"
  | "task:failed";

/**
 * Agent-facing description of one chat surface. Surfaced verbatim in
 * the system-prompt Reachability section that tells the agent where a
 * `AskUserQuestion` call will be delivered. `label` is the human
 * sentence shown to the agent ("Telegram (chat bound — may take
 * minutes if the user isn't near their phone)"); `slow` is true for
 * surfaces with phone-typing latency, which triggers the
 * "phrase as 2-4 button options" steer.
 */
export interface PresenceSurfaceMetadata {
  label: string;
  slow?: boolean;
}

/**
 * One chat-surface provider that core's presence/fallback logic walks
 * to decide whether a session is reachable. Plugins register one of
 * these for each surface they own (e.g. the telegram plugin
 * registers `{ surface: "telegram", ... }`). Implementations may
 * leave optional methods undefined when they don't apply -- the
 * registry tolerates partial providers.
 *
 * The provider replaces the direct `db.select().from(schema.<plugin-
 * table>)` calls that core used to do for each surface, breaking the
 * reverse-coupling that blocks plugin schema moves.
 */
export interface SessionPresenceProvider {
  /**
   * Stable surface key. Used for dedup (registering two providers
   * for the same key throws at boot) and for logging. Conventionally
   * matches the plugin name.
   */
  surface: string;
  /** Agent-visible description; rendered verbatim. */
  metadata: PresenceSurfaceMetadata;
  /**
   * "Is this session bound to a chat on my surface?" Used by the
   * orchestrator's Reachability section and by ask-user fallback's
   * in-band-suppression check. Errors are swallowed by the registry
   * (treated as "no surface") so a flaky provider can't block a task.
   */
  hasSession(sessionId: string): Promise<boolean>;
  /**
   * "Will my surface deliver to this user's account-wide channel,
   * regardless of session binding?" Telegram returns true if the user
   * has a linked bot DM; Slack returns true if the user has a linked
   * workspace DM. Used only by ask-user fallback to suppress its
   * plain-text notification when the in-band relay will fire.
   */
  hasOwnerSurface?(userId: string): Promise<boolean>;
  /**
   * Session ids the user has actively engaged with via this surface
   * (e.g. claimed a playbook thread). Used by the workspace list to
   * keep these visible even when the standard "hide playbook
   * executions" filter would drop them.
   */
  listEngagedSessionIds?(): Promise<Set<string>>;
  /**
   * Fallback user_id lookup when the session isn't in the in-process
   * registry (e.g. a brand-new chat-initiated session hasn't reached
   * the workspace registry yet). Walked by ask-user fallback in
   * registry order; first non-null wins.
   */
  resolveUserIdBySession?(sessionId: string): Promise<string | null>;
}

/**
 * Registration-side surface plugins program against. Plugins receive
 * this via `PluginCore.sessionPresence` and call `register(provider)`
 * at init() to contribute their surface. The query-side (used by
 * core's orchestrator + fallback + workspace-service) is internal --
 * plugins never iterate the registry themselves.
 */
export interface PluginSessionPresenceRegistry {
  register(provider: SessionPresenceProvider): void;
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

  /**
   * Integration lookup. Plugins resolve `req.recipient` against this
   * to get the credentials + config for the user's connected
   * provider (Slack workspace, Telegram bot, etc.).
   */
  integrations: PluginIntegrationLookup;

  /**
   * Profile lookup (read-only). Plugins use this when validating
   * profile_ids in their own routes.
   */
  profiles: PluginProfileLookup;

  /**
   * Workspace lookup (read-only). Plugins use this for ownership
   * checks on workspace-bound resources.
   */
  workspaces: PluginWorkspaceLookup;

  /**
   * Telegram-specific transitional bridge. See PluginTelegramPlatformBot
   * for why this lives on PluginCore until telegram-events.ts moves.
   * Other plugins should ignore this field.
   */
  telegramPlatformBot?: PluginTelegramPlatformBot;

  /**
   * Auth hook plugins can opt into. Plugins with routes that need
   * authenticated access call
   * `server.addHook("onRequest", ctx.core.authHook)` inside their
   * route registration scope. v0.1 mirrors what core wires onto the
   * /v1 fastify subscope -- a session-cookie-or-bearer check that
   * populates request.user on success and returns 401 otherwise.
   *
   * Plugins whose routes are public (e.g. webhook receivers verified
   * via a shared secret) skip this entirely.
   */
  authHook: import("fastify").onRequestHookHandler;

  /**
   * Where plugins contribute a chat-surface presence provider. Lets
   * core's orchestrator + ask-user-fallback + workspace-service ask
   * "is this session reachable on a chat surface?" without reading
   * plugin-owned tables directly. The plugin's provider does the
   * actual DB read.
   */
  sessionPresence: PluginSessionPresenceRegistry;
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

/**
 * The auth-decorated user attached to a FastifyRequest by core's
 * userAuthHook. Plugins receive this as `request.user` inside any
 * route that runs under an auth-gated scope (e.g. /v1/*).
 *
 * Plugins typed against this interface should cast at the request
 * site -- `const user = request.user as AuthUser` -- because the
 * module augmentation that sets `user?: AuthUser` on FastifyRequest
 * lives in core-server's auth/user-auth.ts; declaring it again here
 * would create a conflicting declaration in plugin-api's tsconfig
 * project.
 *
 * The shape mirrors core's AuthUser (id + email + role + minor
 * fields) but is structurally typed here so plugin-api doesn't have
 * to import from core-server.
 */
export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  role: string;
  feature_flags?: string;
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
