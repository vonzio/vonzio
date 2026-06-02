// Telegram setup routes, moved from
// packages/core-server/src/routes/telegram-setup.ts as part of the
// 3C extraction arc. URL paths (/v1/integrations/telegram/*) kept
// verbatim via the plugin's `routePrefix: { kind: "absolute" }`
// declaration so the dashboard's API client + any browser bookmarks
// don't break.
//
// Service deps come through structural types from @vonzio/plugin-api
// (PluginIntegrationLookup etc.) rather than the concrete core
// services, so this module compiles standalone -- no edge from
// plugin-telegram into core-server.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import type {
  AuthUser,
  PluginIntegrationLookup,
  PluginProfileLookup,
  PluginWorkspaceLookup,
  PluginTelegramPlatformBot,
} from "@vonzio/plugin-api";

/**
 * `request.user` is decorated by core's userAuthHook on the /v1
 * scope. The plugin-api package can't declare the augmentation
 * (would collide with core's own module-merge), so we cast at the
 * boundary. The `!` on (request as ...).user! is safe because the
 * /v1 scope enforces auth before routes run.
 */
function getUser(request: FastifyRequest): AuthUser {
  return (request as FastifyRequest & { user?: AuthUser }).user!;
}
import type { TelegramConfig } from "../types.js";
import type { TelegramService } from "../services/telegram-service.js";

/**
 * Minimal error-response helper. Lives inside the plugin so the
 * plugin doesn't pull in core-server as a runtime dep (would create
 * a circular package edge). Shape matches what the dashboard expects
 * (`{ error: { code, message } }`).
 */
const ErrorCodes = {
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  PRECONDITION_FAILED: "PRECONDITION_FAILED",
  BAD_GATEWAY: "BAD_GATEWAY",
} as const;

type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

function errorResponse(code: ErrorCode, message: string): { error: { code: ErrorCode; message: string } } {
  return { error: { code, message } };
}

export interface TelegramSetupRoutesOptions {
  /** BETTER_AUTH_URL — used to construct the webhook URL Telegram POSTs to. */
  betterAuthUrl: string;
  integrationService: PluginIntegrationLookup;
  telegramService: TelegramService;
  profileService: PluginProfileLookup;
  workspaceService: PluginWorkspaceLookup;
  /**
   * Always passed (plugin's init() substitutes a disabled stub when
   * core doesn't expose one). The stub's isConfigured() returns false
   * so the platform-bot connect endpoint returns 503 cleanly.
   */
  platformBotService: PluginTelegramPlatformBot;
  /** Auth hook from PluginCore -- mirrors what core wires on /v1. */
  authHook: import("fastify").onRequestHookHandler;
}

/**
 * Constant-time compare of two strings. Returns false when lengths
 * differ (avoiding `timingSafeEqual`'s length-mismatch throw). Used
 * for token / secret equality so the codebase doesn't drift between
 * `===` and `timingSafeEqual` for the same shape of comparison.
 */
function secretsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Build the {universal-link, native-app-link} pair for a Telegram bot
 * with a `/start <payload>` deep link. Used for `/link <code>` ownership
 * claims and `resume_<sid>` workspace-port deep links — both encode
 * their payload via the same `start=` query param.
 */
function tgDeepLinks(botUsername: string, payload: string) {
  return {
    link_url: `https://t.me/${botUsername}?start=${payload}`,
    link_url_native: `tg://resolve?domain=${botUsername}&start=${payload}`,
  };
}

/**
 * Public-facing shape returned for each connected bot. Mirrors the
 * single-bot legacy shape but with profile binding included.
 */
function botSummary(integration: { id: string; config: Record<string, unknown> }, profileSlug?: string | null, profileName?: string | null) {
  const cfg = integration.config as unknown as TelegramConfig;
  const linkCode = cfg.owner_tg_user_id ? null : cfg.link_code ?? null;
  const links = linkCode ? tgDeepLinks(cfg.bot_username, linkCode) : { link_url: null, link_url_native: null };
  return {
    id: integration.id,
    bot_username: cfg.bot_username,
    bot_user_id: cfg.bot_user_id,
    linked: !!cfg.owner_tg_user_id,
    link_code: linkCode,
    link_url: links.link_url,
    link_url_native: links.link_url_native,
    bound_profile_id: cfg.bound_profile_id ?? null,
    bound_profile_slug: profileSlug ?? null,
    bound_profile_name: profileName ?? null,
    is_platform_owned: !!cfg.is_platform_owned,
  };
}

/**
 * Slash-command menu Telegram clients render via setMyCommands. Exported
 * so the server-startup re-sync hook (server.ts) and PlatformBotService
 * can push the same list to every connected bot whenever it changes.
 * Without re-syncing, bots paired before a command-list change keep
 * showing the stale menu — there's no client-side fetch.
 */
export const BOT_COMMANDS = [
  { command: "new", description: "Start a new session (optionally with a prompt)" },
  { command: "clear", description: "Alias for /new — start a fresh session" },
  { command: "end", description: "End the active session" },
  { command: "web", description: "Open the active session in the dashboard" },
  { command: "model", description: "Switch the model for the active session" },
  { command: "sessions", description: "List your recent sessions" },
  { command: "agents", description: "List your available agent profiles" },
  { command: "help", description: "Show how to use this bot" },
];

/**
 * Push the current BOT_COMMANDS list to every connected bot. Telegram
 * caches the slash-command menu client-side and never refetches, so
 * bots paired before a command-list change keep serving the stale menu
 * until we explicitly call setMyCommands again. Called from server
 * startup so each deploy that ships an updated BOT_COMMANDS array
 * propagates the change to every existing bot in the background.
 *
 * Concurrency: all bots are synced in parallel via allSettled.
 * Failures are logged but never rethrown — a single mis-configured
 * bot can't block startup or hold up the rest of the fleet.
 *
 * Dedupes the platform bot: every paired user has a row carrying the
 * platform bot's identity, but we only need to sync it once.
 */
export async function resyncTelegramBotCommands(deps: {
  integrationService: PluginIntegrationLookup;
  telegramService: TelegramService;
  platformBotToken: string | null;
  /** Pino-shaped logger (`info(obj, msg)` / `warn(obj, msg)`). PluginLogger satisfies this. */
  log: {
    info(meta: Record<string, unknown> | string, msg?: string): void;
    warn(meta: Record<string, unknown> | string, msg?: string): void;
  };
}): Promise<void> {
  const { integrationService, telegramService, platformBotToken, log } = deps;
  const tokens = new Set<string>();

  // Platform bot first (if configured) — same token shared across all rows.
  if (platformBotToken) tokens.add(platformBotToken);

  // Per-user bots — walk all telegram integrations across all users.
  // One SELECT, then N decrypts (one-shot per boot). Skip platform-
  // owned rows: their token would dedupe against the env token via the
  // Set, but we filter explicitly so a misconfigured platform row
  // (empty bot_token) doesn't bleed into the per-user loop.
  try {
    const all = await integrationService.listByType("telegram");
    for (const integration of all) {
      const cfg = integration.config as { bot_token?: string; is_platform_owned?: boolean };
      if (cfg.is_platform_owned) continue;
      if (cfg.bot_token) tokens.add(cfg.bot_token);
    }
  } catch (err) {
    log.warn({ err }, "resyncTelegramBotCommands: failed to list telegram integrations; per-user bots will keep stale menus until next /connect");
  }

  if (tokens.size === 0) {
    log.info("resyncTelegramBotCommands: no telegram bots to sync");
    return;
  }

  const results = await Promise.allSettled(
    Array.from(tokens).map((token) => telegramService.setMyCommands(token, BOT_COMMANDS)),
  );
  const failed = results.filter((r) => r.status === "rejected").length;
  log.info({ total: tokens.size, failed }, "resyncTelegramBotCommands: completed");
}

/**
 * Auth-guarded Telegram setup routes — register inside the /v1 scope.
 */
export const telegramSetupRoutes = fp(
  async (server: FastifyInstance, opts: TelegramSetupRoutesOptions) => {
    const { betterAuthUrl, integrationService, telegramService, profileService, workspaceService, platformBotService, authHook } = opts;
    const webhookBase = betterAuthUrl.replace(/\/$/, "");

    // Apply core's auth hook to every route registered inside this
    // fastify-plugin scope. Mirrors what core's v1 subscope does for
    // its own routes -- request.user is populated on success and the
    // request is rejected with 401 otherwise.
    server.addHook("onRequest", authHook);

    /**
     * Resolve {profile_id → slug+name} so each bot summary can show
     * "bound to @<slug>" without N round-trips on the client. Used by
     * the list/status endpoints. We accept the bound id might point at
     * a deleted profile — in that case both fields come back null and
     * the bot falls back to the user's first profile at runtime.
     */
    async function resolveBoundProfile(userId: string, profileId: string | undefined) {
      if (!profileId) return { slug: null as string | null, name: null as string | null };
      const profiles = await profileService.list(userId);
      const match = profiles.find((p) => p.id === profileId);
      return { slug: match?.slug ?? null, name: match?.name ?? null };
    }

    server.get("/v1/integrations/telegram/config", async () => {
      // Telegram requires a publicly reachable webhook URL — surface this so the
      // UI can warn dev users on http://localhost.
      const url = new URL(webhookBase);
      const publicReachable = url.protocol === "https:" || url.hostname !== "localhost";
      const platformMeta = platformBotService.getMetadata();
      return {
        enabled: true,
        publicReachable,
        webhookBase,
        // When set, the dashboard surfaces a one-tap "Connect with @<botUsername>"
        // button alongside the existing BotFather flow. Null/absent → only the
        // per-user flow is offered.
        platformBot: platformMeta
          ? { bot_username: platformMeta.botUsername }
          : null,
      };
    });

    server.post<{ Body: { bot_token: string; bound_profile_id?: string | null } }>(
      "/v1/integrations/telegram/connect",
      async (request, reply) => {
        const user = getUser(request);
        const botToken = (request.body?.bot_token ?? "").trim();
        const boundProfileId = request.body?.bound_profile_id ?? null;
        if (!botToken || !/^\d+:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
          return reply.code(400).send(errorResponse(
            ErrorCodes.VALIDATION_FAILED,
            "Invalid bot token. Get one from @BotFather (format: 123456789:ABC...).",
          ));
        }
        // Anti-hijack: refuse a user-supplied token that matches the
        // platform bot's. Constant-time compare so we stay consistent
        // with the secret-comparison pattern elsewhere in this file
        // (telegram-events.ts:secretsMatch). The token has plenty of
        // entropy so timing leakage is impractical regardless — this
        // is for code-hygiene, not because === is unsafe here.
        if (secretsEqual(botToken, platformBotService.getToken())) {
          return reply.code(400).send(errorResponse(
            ErrorCodes.VALIDATION_FAILED,
            "That bot is hosted by Vonzio — use 'Connect with platform bot' instead.",
          ));
        }

        // If the caller asked to bind a specific profile, sanity-check it
        // exists and belongs to this user before we touch Telegram.
        if (boundProfileId) {
          const profiles = await profileService.list(user.id);
          if (!profiles.some((p) => p.id === boundProfileId)) {
            return reply.code(400).send(errorResponse(
              ErrorCodes.VALIDATION_FAILED,
              "Unknown agent profile.",
            ));
          }
        }

        // Validate the token by calling getMe.
        let me;
        try {
          me = await telegramService.getMe(botToken);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Token validation failed";
          return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, msg));
        }
        if (!me.is_bot) {
          return reply.code(400).send(errorResponse(
            ErrorCodes.VALIDATION_FAILED,
            "Token does not belong to a bot account.",
          ));
        }

        // Refuse to re-connect a bot the user already linked. (External_id
        // is the bot_user_id from getMe, indexed via migration 15.) The
        // intended way to change the binding is the PATCH endpoint below.
        const existingSameBot = await integrationService.findByTypeAndExternalId("telegram", String(me.id));
        if (existingSameBot && existingSameBot.user_id === user.id) {
          return reply.code(409).send(errorResponse(
            ErrorCodes.VALIDATION_FAILED,
            "This bot is already connected. Disconnect it first, or edit its agent binding from the dashboard.",
          ));
        }
        // Different user owns this bot? Tokens are user-secret — getMe
        // succeeded so the caller has the token; just refuse politely.
        if (existingSameBot && existingSameBot.user_id !== user.id) {
          return reply.code(409).send(errorResponse(
            ErrorCodes.VALIDATION_FAILED,
            "This bot is already connected to another account.",
          ));
        }

        const webhookSecret = randomBytes(24).toString("hex");
        const linkCode = randomBytes(4).toString("hex").toUpperCase();
        const webhookUrl = `${webhookBase}/api/telegram/webhook/${me.id}`;

        try {
          await telegramService.setWebhook(botToken, webhookUrl, webhookSecret);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to register webhook";
          return reply.code(502).send(errorResponse(ErrorCodes.BAD_GATEWAY, msg));
        }

        // Best-effort: register slash commands in the Telegram client menu.
        await telegramService.setMyCommands(botToken, BOT_COMMANDS);

        const cfg: TelegramConfig = {
          bot_token: botToken,
          bot_user_id: String(me.id),
          bot_username: me.username,
          webhook_secret: webhookSecret,
          link_code: linkCode,
          ...(boundProfileId ? { bound_profile_id: boundProfileId } : {}),
        };

        const created = await integrationService.create(user.id, "telegram", cfg as unknown as Record<string, unknown>);
        return {
          ...botSummary(created, null, null),
          link_instructions: `Open Telegram and tap "Start", or send /link ${linkCode} to @${me.username}.`,
        };
      },
    );

    /**
     * One-tap pairing with the platform-hosted bot. Creates a
     * user_integrations row that points at the shared bot's user_id,
     * generates a pair code, and hands back a t.me/<bot>?start=<code>
     * deep link. The webhook handler claims ownership on the user's
     * first /start <code> tap (same path as the per-user /link flow).
     *
     * No bot_token is stored on the row — runtime pulls it from
     * PlatformBotService so token rotation is a single env-var change.
     */
    server.post<{ Body: { bound_profile_id?: string | null } }>(
      "/v1/integrations/telegram/connect-platform",
      async (request, reply) => {
        const user = getUser(request);
        const platformMeta = platformBotService.getMetadata();
        if (!platformMeta) {
          return reply.code(503).send(errorResponse(
            ErrorCodes.VALIDATION_FAILED,
            "Platform Telegram bot is not configured on this server.",
          ));
        }
        const boundProfileId = request.body?.bound_profile_id ?? null;
        if (boundProfileId) {
          const profiles = await profileService.list(user.id);
          if (!profiles.some((p) => p.id === boundProfileId)) {
            return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, "Unknown agent profile."));
          }
        }

        // Refuse if this user already has a platform-bot integration —
        // one user, one platform-bot pairing. They want to switch
        // bindings? Use PATCH on the existing row. Want a fresh code?
        // Disconnect + reconnect.
        const existing = await integrationService.listByUserAndType(user.id, "telegram");
        const existingPlatform = existing.find((b) => {
          const cfg = b.config as unknown as TelegramConfig;
          return cfg.is_platform_owned;
        });
        if (existingPlatform) {
          return reply.code(409).send(errorResponse(
            ErrorCodes.VALIDATION_FAILED,
            "Already paired with the platform bot. Disconnect first to re-pair.",
          ));
        }

        // No setWebhook here — the platform bot's webhook is registered
        // once at server startup by PlatformBotService.init().
        const linkCode = randomBytes(4).toString("hex").toUpperCase();
        const cfg: TelegramConfig = {
          // Unused for platform-owned rows — runtime pulls from env via
          // PlatformBotService. The webhook handler splices the resolved
          // token into cfg.bot_token at request time so downstream sends
          // Just Work without per-call-site changes.
          bot_token: "",
          bot_user_id: platformMeta.botUserId,
          bot_username: platformMeta.botUsername,
          // Dead field for platform-owned rows: the webhook handler reads
          // the secret from PlatformBotService.getWebhookSecret() directly
          // (env-wide), never from cfg. Stored only so the shape matches
          // the TelegramConfig interface. Future refactor: type-narrow
          // this so platform rows don't need to carry the field at all.
          webhook_secret: platformBotService.getWebhookSecret() ?? "",
          link_code: linkCode,
          is_platform_owned: true,
          ...(boundProfileId ? { bound_profile_id: boundProfileId } : {}),
        };
        const created = await integrationService.create(user.id, "telegram", cfg as unknown as Record<string, unknown>);
        return {
          ...botSummary(created, null, null),
          link_instructions: `Open Telegram and tap "Start", or send /link ${linkCode} to @${platformMeta.botUsername}.`,
        };
      },
    );

    // List all Telegram bots connected to this user — supersedes the
    // legacy /status which only returned the first bot.
    server.get("/v1/integrations/telegram/bots", async (request) => {
      const user = getUser(request);
      const bots = await integrationService.listByUserAndType(user.id, "telegram");
      // Resolve profile slug/name once per unique bound_profile_id so we
      // don't re-list profiles per bot. With realistic bot counts (1-5)
      // this is a single profileService.list() call total.
      const profiles = await profileService.list(user.id);
      const byId = new Map(profiles.map((p) => [p.id, p]));
      return {
        bots: bots.map((b) => {
          const cfg = b.config as unknown as TelegramConfig;
          const bound = cfg.bound_profile_id ? byId.get(cfg.bound_profile_id) : undefined;
          return botSummary(b, bound?.slug ?? null, bound?.name ?? null);
        }),
      };
    });

    /**
     * Resolve the bot best suited to receive a "resume this workspace"
     * deep link for the given session. Picks:
     *   1. A LINKED bot whose `bound_profile_id` matches the workspace's profile.
     *   2. The first linked bot (any binding) the user owns.
     *   3. null if the user has no linked bots — the dashboard hides
     *      the "Open in Telegram" button in that case.
     */
    server.get<{ Params: { sessionId: string } }>(
      "/v1/integrations/telegram/bots/for-workspace/:sessionId",
      async (request, reply) => {
        const user = getUser(request);
        const workspace = workspaceService.get(request.params.sessionId);
        if (!workspace || workspace.user_id !== user.id) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Workspace not found"));
        }
        const bots = await integrationService.listByUserAndType(user.id, "telegram");
        const linked = bots.filter((b) => {
          const cfg = b.config as unknown as TelegramConfig;
          return !!cfg.owner_tg_user_id;
        });
        if (linked.length === 0) return { bot: null };

        // Prefer the bot whose binding matches the workspace's profile.
        const matched = linked.find((b) => {
          const cfg = b.config as unknown as TelegramConfig;
          return cfg.bound_profile_id === workspace.profile_id;
        });
        const chosen = matched ?? linked[0];
        const cfg = chosen.config as unknown as TelegramConfig;
        // Deep links the dashboard can target. tg:// opens the native
        // app directly; https://t.me/ works in browsers and redirects.
        const links = tgDeepLinks(cfg.bot_username, `resume_${workspace.session_id}`);
        return {
          bot: {
            id: chosen.id,
            bot_username: cfg.bot_username,
            deep_link: links.link_url,
            deep_link_native: links.link_url_native,
            matched_by_profile: !!matched,
          },
        };
      },
    );

    // Legacy single-bot status. Kept for backwards-compat with older
    // dashboard builds; returns the first bot or `connected: false`.
    server.get("/v1/integrations/telegram/status", async (request) => {
      const user = getUser(request);
      const integration = await integrationService.getByUserAndType(user.id, "telegram");
      if (!integration) return { connected: false };
      const cfg = integration.config as unknown as TelegramConfig;
      const bound = await resolveBoundProfile(user.id, cfg.bound_profile_id ?? undefined);
      return { connected: true, ...botSummary(integration, bound.slug, bound.name) };
    });

    // Update the bound agent for an existing bot (rebind without
    // disconnecting). Null = unbind, falls back to default-first-profile.
    server.patch<{ Params: { id: string }; Body: { bound_profile_id: string | null } }>(
      "/v1/integrations/telegram/bots/:id",
      async (request, reply) => {
        const user = getUser(request);
        const integration = await integrationService.get(request.params.id, { decrypt: true });
        if (!integration || integration.user_id !== user.id || integration.type !== "telegram") {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Bot not found"));
        }
        const boundProfileId = request.body?.bound_profile_id ?? null;
        if (boundProfileId) {
          const profiles = await profileService.list(user.id);
          if (!profiles.some((p) => p.id === boundProfileId)) {
            return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, "Unknown agent profile"));
          }
        }
        const cfg = integration.config as unknown as TelegramConfig;
        const newCfg: TelegramConfig = { ...cfg };
        if (boundProfileId) newCfg.bound_profile_id = boundProfileId;
        else delete newCfg.bound_profile_id;
        await integrationService.update(integration.id, { config: newCfg as unknown as Record<string, unknown> });
        const bound = await resolveBoundProfile(user.id, newCfg.bound_profile_id);
        return botSummary({ id: integration.id, config: newCfg as unknown as Record<string, unknown> }, bound.slug, bound.name);
      },
    );

    // Re-issue a link code for a specific bot.
    server.post<{ Body: { bot_id?: string } }>(
      "/v1/integrations/telegram/regenerate-link-code",
      async (request, reply) => {
        const user = getUser(request);
        const integration = await pickBot(user.id, request.body?.bot_id);
        if (!integration) return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "No Telegram bot"));
        const cfg = integration.config as unknown as TelegramConfig;
        if (cfg.owner_tg_user_id) {
          return reply.code(400).send(errorResponse(ErrorCodes.VALIDATION_FAILED, "Bot is already linked. Disconnect to re-link."));
        }
        const newCode = randomBytes(4).toString("hex").toUpperCase();
        await integrationService.update(integration.id, {
          config: { ...cfg, link_code: newCode } as unknown as Record<string, unknown>,
        });
        return { link_code: newCode, ...tgDeepLinks(cfg.bot_username, newCode) };
      },
    );

    server.post<{ Body: { bot_id?: string } }>(
      "/v1/integrations/telegram/disconnect",
      async (request, reply) => {
        const user = getUser(request);
        const existing = await pickBot(user.id, request.body?.bot_id);
        if (!existing) {
          return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "No Telegram bot"));
        }
        try {
          const cfg = existing.config as unknown as TelegramConfig;
          // CRITICAL: don't call deleteWebhook on platform-owned rows —
          // there's one webhook for the shared bot serving every paired
          // user, and a single disconnect would kill it for everyone.
          if (!cfg.is_platform_owned && cfg.bot_token) {
            await telegramService.deleteWebhook(cfg.bot_token);
          }
        } catch { /* best-effort */ }
        await integrationService.delete(existing.id);
        return { status: "disconnected" };
      },
    );

    /**
     * Resolve a bot for the request. When `botId` is provided, fetch and
     * ownership-check that specific row. Without an id, fall back to the
     * user's first telegram integration — matches the legacy single-bot
     * shape so older dashboard builds don't break mid-rollout.
     */
    async function pickBot(userId: string, botId: string | undefined) {
      if (botId) {
        const integration = await integrationService.get(botId, { decrypt: true });
        if (!integration || integration.user_id !== userId || integration.type !== "telegram") {
          return null;
        }
        return integration;
      }
      return integrationService.getByUserAndType(userId, "telegram");
    }
  },
  { name: "telegram-setup-routes" },
);
