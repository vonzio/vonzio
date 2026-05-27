import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { swaggerOptions, swaggerUiOptions, registerSchemas, registerOpenApiJsonRoute, ajvOptions } from "./openapi/index.js";
import { sql, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import pg from "pg";
import type { Config } from "./config.js";
import type { DrizzleDB } from "./db/index.js";
import { schema } from "./db/index.js";
import type { ContainerManager } from "@vonzio/shared";
import { createAuth, mountBetterAuth } from "./auth/better-auth.js";
import { fromNodeHeaders } from "better-auth/node";
import { userAuthHook, adminOnlyHook } from "./auth/user-auth.js";
import { buildDefaultCoreDeps } from "./lib/build-core-deps.js";
import { InMemoryTaskQueue } from "./queue/in-memory.js";
import { SlidingWindowRateLimiter } from "./rate-limit/sliding-window.js";
import { ConcurrencyLimiter } from "./rate-limit/concurrency-limiter.js";
import { ContainerPool } from "./container/pool.js";
import { SessionRegistry } from "./container/session-registry.js";
import { WorkspaceProvisioner } from "./container/workspace.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { MetricsCollector } from "./metrics/collector.js";
import { TaskService } from "./services/task-service.js";
import { WorkspaceService } from "./services/workspace-service.js";
import { ProfileService } from "./services/profile-service.js";
import { ApiKeyService } from "./services/api-key-service.js";
import { ModelListService } from "./services/model-list-service.js";
import { ToolFileService } from "./services/tool-file-service.js";
import { SkillService } from "./services/skill-service.js";
import { SubagentService } from "./services/subagent-service.js";
import { GitProviderService } from "./services/git-provider-service.js";
import { ConnectionManager } from "./ws/connection.js";
import { setupWsHandler } from "./ws/handler.js";
import { createPreviewAuthChecker } from "./auth/preview-auth.js";
import { ImageRewriterService } from "./services/image-rewriter-service.js";
import { taskRoutes } from "./routes/tasks.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { workspaceFilesRoutes } from "./routes/workspace-files.js";
import { profileRoutes } from "./routes/profiles.js";
import { userResourceRoutes } from "./routes/user-resources.js";
import { poolRoutes } from "./routes/pool.js";
import { adminRoutes } from "./routes/admin.js";
import { previewRoutes, setupHostnamePreviewProxy, setupPreviewWebSocketProxy } from "./routes/preview.js";
import { gitOAuthRoutes, gitOAuthCallbackRoute } from "./routes/git-oauth.js";
import { slackOAuthRoutes, slackOAuthCallbackRoute } from "./routes/slack-oauth.js";
import { gmailOAuthRoutes, gmailOAuthCallbackRoute } from "./routes/gmail-oauth.js";
import { tellerConnectRoutes } from "./routes/teller-connect.js";
import { slackEventsRoutes } from "./routes/slack-events.js";
import { telegramSetupRoutes, resyncTelegramBotCommands } from "./routes/telegram-setup.js";
import { telegramEventsRoutes } from "./routes/telegram-events.js";
import { integrationRoutes } from "./routes/integrations.js";
import { IntegrationService } from "./services/integration-service.js";
import { MemoryService } from "./services/memory-service.js";
import { SlackService } from "./services/slack-service.js";
import { TelegramService } from "./services/telegram-service.js";
import { PlatformBotService } from "./services/platform-bot-service.js";
import { SecretVaultService } from "./services/secret-vault-service.js";
import { PlaybookService } from "./services/playbook-service.js";
import { PlaybookScheduler } from "./services/playbook-scheduler.js";
import { ChainRunner } from "./orchestrator/chain-runner.js";
import { playbookRoutes, playbookWebhookRoute } from "./routes/playbooks.js";
import { NotificationService } from "./services/notification-service.js";
import { createAskUserFallback } from "./orchestrator/ask-user-fallback.js";
import { createEventTracker, ROUTE_EVENTS, getUserIdFromRequest } from "./services/event-service.js";
import { eventTrackerPlugin } from "./lib/event-tracker/index.js";
import { eventRoutes, adminEventRoutes } from "./routes/events.js";
import { EventLog } from "./events/event-log.js";
import { memoryRoutes } from "./routes/memories.js";
import { memoryMcpPlugin } from "./mcp/memory-mcp.js";
import { notifyMcpPlugin } from "./mcp/notify-mcp.js";
import { gmailMcpPlugin } from "./mcp/gmail-mcp.js";
import { tellerMcpPlugin } from "./mcp/teller-mcp.js";
import { TellerClient } from "./services/teller-client.js";
import { platformMcpPlugin } from "./mcp/platform-mcp.js";
import { ErrorCodes, errorResponse } from "./errors.js";

export interface ServerDeps {
  config: Config;
  db: DrizzleDB;
  pool: pg.Pool;
  containerManager: ContainerManager;
}

export async function buildServer(deps: ServerDeps) {
  const { config, db, pool: pgPool, containerManager } = deps;

  const server = Fastify({
    logger: { level: config.LOG_LEVEL },
    // Accept OpenAPI annotation keywords (example, examples, etc.)
    // in route schemas. See ajvOptions for rationale. Sharing the
    // constant keeps the boot smoke test in sync with reality.
    ajv: ajvOptions,
  });

  // CORS
  const origin = config.CORS_ORIGIN === "*"
    ? true
    : config.CORS_ORIGIN.split(",").map((o) => o.trim());
  await server.register(cors, { origin, credentials: true });

  // OpenAPI spec + Swagger UI. Registered before routes so each handler's
  // `schema:` block gets captured. Interactive UI at /v1/docs. Raw spec at
  // /v1/openapi.json (alias) and /v1/docs/json (auto-mounted by
  // swagger-ui). YAML variant at /v1/docs/yaml. No auth — the docs page
  // reveals the route shapes, not user data, and codegen tools need to
  // fetch the spec without a token.
  //
  // Component schemas are registered via `server.addSchema()` (not via
  // `swaggerOptions.openapi.components.schemas`) so route `$ref`s resolve
  // both for the generated spec AND for Fastify's runtime route
  // validator. Boot smoke test in `openapi/openapi.test.ts` guards this.
  await server.register(swagger, swaggerOptions);
  await server.register(swaggerUi, swaggerUiOptions);
  registerSchemas(server);
  registerOpenApiJsonRoute(server);

  // (The /v1/session/hint endpoint is registered later, after `auth` is
  // created, so we can fall back to a real Better Auth session check
  // when the cross-site mirror cookie isn't present.)

  // Core infrastructure
  const queue = new InMemoryTaskQueue();
  const callerRateLimiter = new SlidingWindowRateLimiter(60_000, config.RATE_LIMIT_CALLER_RPM);
  const concurrencyLimiter = new ConcurrencyLimiter(config.RATE_LIMIT_PROFILE_CONCURRENCY);
  const metrics = new MetricsCollector(db, { retentionDays: config.METRICS_RETENTION_DAYS });
  const workspace = new WorkspaceProvisioner();
  const connectionManager = new ConnectionManager({ maxPerCaller: config.WS_MAX_CONNECTIONS_PER_CALLER });
  const eventLog = new EventLog(config.EVENT_LOG_DIR);

  const containerPool = new ContainerPool(
    containerManager,
    {
      minSize: config.POOL_MIN_SIZE,
      maxSize: config.POOL_MAX_SIZE,
      idleDrainSecs: config.POOL_IDLE_DRAIN_SECS,
      maxRecycles: config.POOL_MAX_RECYCLES,
      healthCheckIntervalSecs: config.POOL_HEALTH_CHECK_INTERVAL_SECS,
      cleanupCmd: ["sh", "/app/cleanup.sh"],
    },
    () => ({
      env: { ANTHROPIC_API_KEY: "__pool_placeholder__" },
      labels: { "vonzio-mode": "pooled" },
      cpus: config.CONTAINER_CPU_LIMIT_BATCH,
      memory: config.CONTAINER_MEMORY_LIMIT_BATCH,
    }),
  );

  const sessionRegistry = new SessionRegistry(
    {
      idleTtlSecs: config.SESSION_IDLE_TTL_SECS,
      maxLifetimeSecs: config.SESSION_MAX_LIFETIME_SECS,
      workstationIdlePauseSecs: config.WORKSTATION_IDLE_PAUSE_SECS,
      workstationMaxLifetimeSecs: config.WORKSTATION_MAX_LIFETIME_SECS,
      maxPaused: config.WORKSTATION_MAX_PAUSED,
      volumeTtlDays: config.WORKSTATION_VOLUME_TTL_DAYS,
    },
    {
      onIdleExpiry: async (sessionId, containerId) => {
        try {
          await containerManager.removeContainer(containerId, true);
        } catch { /* container may be gone */ }
        server.log.info({ sessionId, containerId }, "Session container destroyed on idle TTL");
      },
      onIdlePause: async (sessionId, containerId) => {
        try {
          await containerManager.pauseContainer(containerId);
        } catch (err) {
          server.log.error({ sessionId, containerId, err }, "Failed to pause container");
        }
      },
      onExpired: async (sessionId) => {
        server.log.info({ sessionId }, "Session expired (24h)");
      },
    },
    db,
    server.log,
  );

  // Connected WS sessions should never go idle
  sessionRegistry.getConnectedSessionIds = () => connectionManager.connectedSessionIds;

  const apiKeyService = new ApiKeyService(db, config.ENCRYPTION_KEY);
  const profileService = new ProfileService(db, config.ENCRYPTION_KEY, apiKeyService);
  // Shared model-list cache + provider fetcher used by the dashboard
  // ModelPicker route AND the Telegram /model + Slack `@vonzio model`
  // bot commands. One cache so the bot pickers don't repeatedly hit
  // upstream providers on each open.
  const modelListService = new ModelListService(profileService, apiKeyService);
  const toolFileService = new ToolFileService(db, config.TOOLS_DIR);
  const skillService = new SkillService(db, config.SKILLS_DIR);
  const subagentService = new SubagentService(db);
  const gitProviderService = new GitProviderService(db, config.ENCRYPTION_KEY);
  const integrationService = new IntegrationService(db, config.ENCRYPTION_KEY);
  const memoryService = new MemoryService(db);
  const secretVaultService = new SecretVaultService(db, config.ENCRYPTION_KEY);
  const slackService = new SlackService();
  const telegramService = new TelegramService();
  const tellerClient = new TellerClient(config);
  const platformBotService = new PlatformBotService(config, telegramService, server.log);

  containerPool.setSessionRegistry(sessionRegistry, (containerId) => {
    server.log.info({ containerId }, "Orphan container removed");
  });

  // Eight-seam registry for cross-cutting deps (token validation, profile
  // resolution, integration credentials, secret vault, quotas, usage,
  // entitlements, vpn tunnels). OSS default impls; cp-server (when
  // mounted) swaps in plan-aware ones. Built here (before the orchestrator)
  // so the orchestrator's runtime reads see cp-server's mutations as soon
  // as cp-server mounts later in this function.
  const coreDeps = buildDefaultCoreDeps({
    db,
    profileService,
    secretVaultService,
    integrationService,
    registrationEnabled: config.REGISTRATION_ENABLED,
  });

  const orchestrator = new Orchestrator({
    queue,
    containerManager,
    pool: containerPool,
    sessionRegistry,
    workspace,
    concurrencyLimiter,
    profileService,
    toolFileService,
    skillService,
    subagentService,
    gitProviderService,
    memoryService,
    secretVaultService,
    integrationService,
    eventLog,
    vpnTunnelProvider: () => coreDeps.vpnTunnelProvider,
    db,
    log: server.log,
    config: {
      taskTimeoutSeconds: config.TASK_TIMEOUT_SECONDS,
      maxTurns: config.MAX_TURNS,
      agentImage: config.AGENT_IMAGE,
      containerCpuBatch: config.CONTAINER_CPU_LIMIT_BATCH,
      containerCpuSession: config.CONTAINER_CPU_LIMIT_SESSION,
      containerMemoryBatch: config.CONTAINER_MEMORY_LIMIT_BATCH,
      containerMemorySession: config.CONTAINER_MEMORY_LIMIT_SESSION,
      previewUrlTemplate: config.PREVIEW_URL_TEMPLATE,
      internalServerUrl: config.INTERNAL_SERVER_URL,
      encryptionKey: config.ENCRYPTION_KEY,
    },
  });

  // Services
  const taskService = new TaskService(db, queue, orchestrator, profileService);
  const workspaceService = new WorkspaceService(db, sessionRegistry, containerManager);
  const playbookService = new PlaybookService(db, integrationService);
  const notificationService = new NotificationService({
    slackService,
    telegramService,
    integrationService,
    db,
    dashboardUrl: config.BETTER_AUTH_URL,
    log: server.log,
  });
  // Cross-surface fallback for AskUserQuestion: when the agent asks
  // and no in-band surface (dashboard WS / Telegram chat / Slack thread)
  // can deliver, push a notification through the user's account-level
  // channels with a link back to the dashboard.
  const askUserFallback = createAskUserFallback({
    db,
    sessionRegistry,
    notificationService,
    integrationService,
    dashboardUrl: config.BETTER_AUTH_URL,
    log: server.log,
  });
  orchestrator.on("task:ask_user", (taskId: string, sessionId: string | undefined, input: unknown) => {
    // Fire-and-forget; the fallback never throws and we don't want to
    // block the in-band relays (WS, Telegram, Slack) waiting on it.
    void askUserFallback(taskId, sessionId, input);
  });
  const chainRunner = new ChainRunner({
    playbookService,
    orchestrator,
    db,
    submitTask: (input) => taskService.submit(input, [input.profile_id!]),
    notificationService,
    log: server.log,
  });
  const playbookScheduler = new PlaybookScheduler(playbookService, chainRunner, server.log);

  // Health endpoint (no auth)
  server.get("/health", async () => {
    return {
      status: "ok",
      version: process.env.VONZIO_VERSION ?? "dev",
      pool: {
        idle: containerPool.idleCount,
        busy: containerPool.busyCount,
        total: containerPool.totalCount,
      },
      sessions: sessionRegistry.activeCount,
      connections: connectionManager.count,
    };
  });

  // Public config (no auth). `setupNeeded` is true when REGISTRATION_ENABLED
  // is off (OSS single-user mode) AND no users exist yet — the dashboard
  // uses this to route a fresh OSS instance to its first-run setup wizard
  // instead of the login screen.
  server.get("/api/config", async () => {
    let setupNeeded = false;
    if (!config.REGISTRATION_ENABLED) {
      const countRow = (await db.execute(sql`SELECT COUNT(*)::int AS cnt FROM "user"`)).rows[0] as { cnt: number } | undefined;
      setupNeeded = (countRow?.cnt ?? 0) === 0;
    }
    return {
      version: process.env.VONZIO_VERSION ?? "dev",
      registrationEnabled: config.REGISTRATION_ENABLED,
      setupNeeded,
      // True iff an outbound email channel (Resend) is configured. The
      // dashboard uses this to hide "Forgot password" — without email
      // there is no path for a reset link to reach the user, so showing
      // the link only leads to a confusing dead end.
      emailEnabled: !!config.RESEND_API_KEY,
      authProviders: {
        google: !!config.AUTH_GOOGLE_CLIENT_ID,
        github: !!config.AUTH_GITHUB_CLIENT_ID,
      },
      turnstileSiteKey: config.TURNSTILE_SITE_KEY ?? null,
      marketingUrl: config.MARKETING_URL ?? null,
      previewUrlTemplate: config.PREVIEW_URL_TEMPLATE,
      maxTurns: config.MAX_TURNS,
      ollamaEnabled: config.OLLAMA_ENABLED,
    };
  });

  // Event tracker (beta observability)
  const eventTracker = createEventTracker(db, server.log);

  // Load the proprietary control plane (cp-server) module up front, if
  // installed, so we can ask it for its Better Auth plugin contributions
  // BEFORE constructing the auth instance. Better Auth bakes plugins in
  // at construction time and exposes no add-after API, so plugin
  // injection has to happen before createAuth. The mount itself still
  // runs later (after profile/orchestrator setup).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cpServerModule: any = null;
  try {
    // Dynamic specifier so tsc doesn't try to resolve @vonzio/cp-server
    // at compile time — OSS distributions don't ship it.
    const cpServerSpec = "@vonzio/cp-server";
    cpServerModule = await import(/* @vite-ignore */ cpServerSpec);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    const msg = (err as Error)?.message ?? "";
    const isCpMissing = code === "ERR_MODULE_NOT_FOUND" && msg.includes("@vonzio/cp-server");
    if (!isCpMissing) throw err;
    // OSS — left null; admin-plugin contributions empty, mount skipped below.
  }

  // Better Auth (tracker wired for signup/login events). Plugins from
  // cp-server (e.g. better-auth's admin plugin for user management)
  // are merged in here; OSS leaves the array empty.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extraAuthPlugins: any[] = cpServerModule?.getAuthPlugins?.() ?? [];
  const auth = createAuth(config, pgPool, db, eventTracker, extraAuthPlugins);

  // First-run OSS setup wizard. Creates the lone admin on a fresh
  // single-user instance, then disables itself (the no-users precondition
  // can never become true again). Idempotent: 409 once a user exists.
  server.post<{
    Body: { email: string; password: string; name: string };
  }>("/api/setup", async (request, reply) => {
    if (config.REGISTRATION_ENABLED) {
      return reply.code(403).send({ error: "Setup wizard is OSS-only — use /api/auth/sign-up" });
    }
    const { email, password, name } = request.body ?? ({} as { email?: string; password?: string; name?: string });
    if (!email || !password || !name) {
      return reply.code(400).send({ error: "email, password, and name are required" });
    }
    if (password.length < 8) {
      return reply.code(400).send({ error: "Password must be at least 8 characters" });
    }
    const countRow = (await db.execute(sql`SELECT COUNT(*)::int AS cnt FROM "user"`)).rows[0] as { cnt: number } | undefined;
    if ((countRow?.cnt ?? 0) > 0) {
      return reply.code(409).send({ error: "Setup already completed — a user exists" });
    }
    try {
      // Direct user+account insert. We can't use auth.api.signUpEmail
      // (gated by disableSignUp=!REGISTRATION_ENABLED, which is exactly
      // the OSS configuration) or auth.api.createUser from the admin
      // plugin (requires an admin session — none exists yet, that's
      // the point of setup). hashPassword is Better Auth's own helper
      // so the user can sign in normally afterward.
      const { hashPassword } = await import("better-auth/crypto");
      const hashed = await hashPassword(password);
      const userId = nanoid(24);
      const accountId = nanoid(24);
      const now = new Date();
      await db.execute(sql`
        INSERT INTO "user" (id, name, email, "emailVerified", role, feature_flags, "createdAt", "updatedAt")
        VALUES (${userId}, ${name}, ${email}, true, 'admin', '', ${now}, ${now})
      `);
      await db.execute(sql`
        INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
        VALUES (${accountId}, ${userId}, 'credential', ${userId}, ${hashed}, ${now}, ${now})
      `);
      return { status: "ok", email };
    } catch (err) {
      request.log.error({ err }, "setup wizard failed");
      return reply.code(500).send({ error: err instanceof Error ? err.message : "Failed to create account" });
    }
  });

  const authHook = userAuthHook(auth, coreDeps.tokenValidator);
  // Shared preview-auth checker used by chat-surface relays (WS/Telegram/Slack)
  // to mint short-lived _pvt tokens for agent-generated image URLs. Same secret
  // as the preview routes' internal checker — tokens are interchangeable.
  const previewAuthChecker = createPreviewAuthChecker(auth, sessionRegistry, config.BETTER_AUTH_SECRET);
  // Session-aware wrapper around the rewriter with container-name caching.
  // One instance, three consumers (WS handler, Telegram relay, Slack relay).
  const imageRewriterService = new ImageRewriterService({
    sessionRegistry, containerManager, previewAuthChecker,
    previewUrlTemplate: config.PREVIEW_URL_TEMPLATE,
  });

  // Hostname-based preview proxy — must be registered before any routes
  // so it intercepts *.vonzio.localhost before the SPA fallback
  if (config.PREVIEW_MODE === "hostname" && config.PREVIEW_DOMAIN) {
    setupHostnamePreviewProxy(server, containerManager, config.PREVIEW_DOMAIN, auth, sessionRegistry, config.BETTER_AUTH_URL, config.BETTER_AUTH_SECRET);
  }

  // Mount Better Auth routes (before auth-guarded routes, after CORS)
  mountBetterAuth(server, auth);

  // Session enrichment: returns the current user plus entitlements computed
  // by coreDeps.entitlementsProvider. The dashboard fetches this once on
  // boot and provides the result through EntitlementsProvider context so
  // routes/nav/settings can self-gate. 401 when no session.
  server.get("/api/me", async (request, reply) => {
    try {
      const headers = fromNodeHeaders(request.headers);
      const session = await auth.api.getSession({ headers });
      if (!session?.user) return reply.code(401).send({ error: "unauthorized" });
      // Better Auth surfaces additionalFields under their schema-registered
      // key (snake_case `feature_flags` per auth/better-auth.ts), but some
      // serialization paths camelCase it. Read both like the dashboard
      // does in App.tsx.
      const u = session.user as Record<string, unknown> & {
        id: string;
        email: string;
        name?: string | null;
        role?: string | null;
      };
      const featureFlags = (u.feature_flags ?? u.featureFlags ?? undefined) as string | undefined;
      const entitlements = await coreDeps.entitlementsProvider.compute({
        id: u.id,
        email: u.email,
        role: u.role ?? undefined,
        featureFlags,
      });
      return {
        user: { id: u.id, email: u.email, name: u.name ?? null, role: u.role ?? null },
        entitlements,
      };
    } catch (err) {
      server.log.error({ err }, "/api/me failed");
      return reply.code(500).send({ error: "internal" });
    }
  });

  // Cross-site session indicator for the marketing site. The marketing
  // surface (vonzio.com) can't read Better Auth's HttpOnly+SameSite=Lax
  // session cookie via document.cookie, so this endpoint surfaces a
  // boolean the landing page can fetch with credentials:include to swap
  // "Sign in" for "Open the app".
  //
  // Two signal sources, checked in order:
  //   1. `vonzio_authed=1` mirror cookie — set by mountBetterAuth() at
  //      login. SameSite=None + Secure so it survives the cross-site fetch.
  //   2. Real Better Auth session — only present on same-origin requests
  //      (SameSite=Lax). Covers users whose mirror cookie expired or
  //      predates the mirror feature shipping.
  //
  // No auth on purpose — leaks no user data, only the existence of a
  // session. `Cache-Control: no-store` keeps the answer accurate after
  // sign-in / sign-out.
  server.get("/v1/session/hint", { schema: { hide: true } }, async (request, reply) => {
    reply.header("cache-control", "no-store");

    const cookieHeader = request.headers.cookie ?? "";
    for (const part of cookieHeader.split(/;\s*/)) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === "vonzio_authed" && part.slice(eq + 1).trim() === "1") {
        return { authed: true };
      }
    }

    try {
      const headers = fromNodeHeaders(request.headers);
      const session = await auth.api.getSession({ headers });
      if (session?.user) return { authed: true };
    } catch {
      // Better Auth threw — treat as not authed and fall through.
    }

    return { authed: false };
  });

  // WebSocket support (must be registered before WS routes)
  server.register(websocket);

  // /v1/* routes — user auth scoped here only
  server.register(async (v1) => {
    v1.addHook("onRequest", authHook);
    v1.register(eventTrackerPlugin, {
      tracker: eventTracker,
      routeEvents: ROUTE_EVENTS,
      getUserId: getUserIdFromRequest,
    });
    v1.register(eventRoutes, { tracker: eventTracker });
    v1.register(taskRoutes, { taskService, profileService });
    v1.register(workspaceRoutes, { workspaceService, profileService, eventLog, orchestrator });
    v1.register(workspaceFilesRoutes, { sessionRegistry, containerManager });
    v1.register(profileRoutes, { profileService, apiKeyService, modelListService });
    v1.register(userResourceRoutes, { db, apiKeyService, profileService, toolFileService, skillService, subagentService, gitProviderService, secretVaultService });
    v1.register(gitOAuthRoutes, { config, gitProviderService, encryptionKey: config.ENCRYPTION_KEY });
    v1.register(slackOAuthRoutes, { config, integrationService, encryptionKey: config.ENCRYPTION_KEY });
    v1.register(telegramSetupRoutes, { config, integrationService, telegramService, profileService, workspaceService, platformBotService });
    v1.register(gmailOAuthRoutes, { config, integrationService, encryptionKey: config.ENCRYPTION_KEY });
    v1.register(tellerConnectRoutes, { config, integrationService });
    v1.register(integrationRoutes, { integrationService, notificationService, profileService });
    v1.register(memoryRoutes, { memoryService });
    v1.register(playbookRoutes, { playbookService, chainRunner, playbookScheduler });
    v1.register(poolRoutes, { pool: containerPool, sessionRegistry, containerManager });

    if (config.OLLAMA_ENABLED) {
      const { ollamaRoutes } = await import("./routes/ollama.js");
      v1.register(ollamaRoutes, { apiKeyService });
    }

    // WS handler lives under /v1 scope (needs auth)
    setupWsHandler(v1, {
      connectionManager,
      taskService,
      workspaceService,
      sessionRegistry,
      orchestrator,
      containerManager,
      profileService,
      eventLog,
      imageRewriterService,
      log: server.log,
    });
  });

  // OAuth callbacks (no auth — browser redirect from provider)
  server.register(gitOAuthCallbackRoute, { config, gitProviderService, encryptionKey: config.ENCRYPTION_KEY });
  server.register(slackOAuthCallbackRoute, { config, integrationService, encryptionKey: config.ENCRYPTION_KEY });
  server.register(gmailOAuthCallbackRoute, { config, integrationService, encryptionKey: config.ENCRYPTION_KEY });

  // Playbook webhook trigger (no auth — token-based)
  server.register(playbookWebhookRoute, { playbookService, chainRunner });

  // Memory MCP endpoint (token-based auth — used by agent containers)
  server.register(memoryMcpPlugin, {
    memoryService,
    resolveSession: (token) => {
      const session = orchestrator.resolveMemoryToken(token);
      return session ? { userId: session.userId, profileId: session.profileId } : null;
    },
  });

  // Notify MCP endpoint (token-based auth — used by agent containers)
  server.register(notifyMcpPlugin, {
    notificationService,
    resolveSession: (token: string) => {
      const session = orchestrator.resolveNotifyToken(token);
      return session ? { userId: session.userId, sessionId: session.sessionId } : null;
    },
  });

  // Gmail MCP endpoint (token-based auth — used by agent containers)
  server.register(gmailMcpPlugin, {
    config,
    integrationService,
    resolveSession: (token: string) => {
      const session = orchestrator.resolveGmailToken(token);
      return session ? { userId: session.userId } : null;
    },
  });

  // Teller MCP endpoint (token-based auth — used by agent containers)
  server.register(tellerMcpPlugin, {
    integrationService,
    tellerClient,
    resolveSession: (token: string) => {
      const session = orchestrator.resolveTellerToken(token);
      return session ? { userId: session.userId, profileId: session.profileId } : null;
    },
  });

  // Platform MCP endpoint (token-based auth — used by agent containers)
  server.register(platformMcpPlugin, {
    playbookService,
    taskService,
    chainRunner,
    integrationService,
    slackService,
    workspaceService,
    profileService,
    eventLog,
    resolveSession: (token: string) => {
      const session = orchestrator.resolvePlatformToken(token);
      return session ? { userId: session.userId, profileId: session.profileId } : null;
    },
  });

  // Slack events + interactions (no auth — verified via signing secret)
  server.register(slackEventsRoutes, {
    config, db, integrationService, slackService,
    taskService, profileService, sessionRegistry, workspaceService, orchestrator, eventLog,
    imageRewriterService,
    modelListService,
  });

  // Telegram webhook (no auth — verified via per-bot secret_token header)
  server.register(telegramEventsRoutes, {
    config, db, integrationService, telegramService,
    taskService, profileService, sessionRegistry, workspaceService, orchestrator, eventLog,
    connectionManager,
    imageRewriterService,
    platformBotService,
    modelListService,
  });

  // /admin/* routes — admin role auth scoped here only
  server.register(adminRoutes, { auth, db, tokenValidator: coreDeps.tokenValidator, profileService, apiKeyService, toolFileService, skillService, subagentService, gitProviderService, containerManager });

  // Admin events (separate plugin because adminRoutes scopes its own auth hook)
  server.register(async (adminScope) => {
    adminScope.addHook("onRequest", authHook);
    adminScope.addHook("onRequest", adminOnlyHook);
    adminScope.register(adminEventRoutes, { db });
  });

  // Mount the proprietary control plane (cp-server) using the module
  // we already loaded above for plugin discovery. SaaS path runs the
  // mount; OSS leaves cpServerModule null and skips.
  if (cpServerModule) {
    await cpServerModule.registerCpServer(server, {
      db,
      auth,
      authHook,
      adminOnlyHook,
      coreDeps,
      config: {
        BETTER_AUTH_URL: config.BETTER_AUTH_URL,
        EMAIL_FROM: config.EMAIL_FROM,
        RESEND_API_KEY: config.RESEND_API_KEY,
        ENCRYPTION_KEY: config.ENCRYPTION_KEY,
      },
    });
    server.log.info("cp-server mounted (multi-tenant control plane)");
    if (!config.REGISTRATION_ENABLED) {
      server.log.warn(
        "cp-server is mounted but REGISTRATION_ENABLED=false — signin works, " +
          "but no new users can be created via signup or invite-accept. Set " +
          "REGISTRATION_ENABLED=true if this SaaS deployment expects new accounts.",
      );
    }
  } else {
    server.log.info("cp-server not installed — running single-user OSS");
  }

  // Preview proxy (auth-gated — session cookie + container ownership check)
  server.register(previewRoutes, {
    containerManager,
    previewMode: config.PREVIEW_MODE,
    previewDomain: config.PREVIEW_DOMAIN,
    auth,
    sessionRegistry,
    dashboardUrl: config.BETTER_AUTH_URL,
    secret: config.BETTER_AUTH_SECRET,
  });

  // Prometheus metrics endpoint
  if (config.PROMETHEUS_ENABLED) {
    server.get("/metrics", async (request, reply) => {
      reply.type("text/plain; charset=utf-8");
      return metrics.toPrometheus();
    });
  }

  // Serve widget JS
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const widgetDist = join(__dirname, "../../widget/dist");
  if (existsSync(widgetDist)) {
    server.register(fastifyStatic, {
      root: widgetDist,
      prefix: "/widget/",
      decorateReply: false, // required for 2nd fastify-static
    });
  }

  // Serve dashboard static files if the build exists.
  // DASHBOARD_DIST env var overrides the default path — SaaS deployments
  // point this at packages/cp-dashboard/dist to serve the SaaS composition
  // instead of the OSS shell.
  const dashboardDist = process.env.DASHBOARD_DIST
    ? resolve(process.env.DASHBOARD_DIST)
    : join(__dirname, "../../dashboard/dist");
  if (existsSync(dashboardDist)) {
    server.register(fastifyStatic, {
      root: dashboardDist,
      prefix: "/",
      wildcard: false,
      cacheControl: false,
      // Hashed assets ship with content-addressed filenames so they're
      // immutable for a year; index.html must never be cached because
      // it references the current bundle's hashes, which change every
      // deploy.
      setHeaders: (res, filePath) => {
        if (filePath.endsWith("index.html")) {
          res.setHeader("cache-control", "no-cache");
        } else {
          res.setHeader("cache-control", "public, max-age=31536000, immutable");
        }
      },
    });
    // SPA fallback: serve index.html for unmatched routes
    server.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/v1") || request.url.startsWith("/admin/") || request.url.startsWith("/api/") || request.url.startsWith("/preview") || request.url.startsWith("/widget")) {
        return reply.code(404).send(errorResponse(ErrorCodes.NOT_FOUND, "Not found"));
      }
      reply.header("cache-control", "no-cache");
      return reply.sendFile("index.html");
    });
  }

  // Preview WebSocket proxy (intercepts 'upgrade' on the raw http.Server for preview URLs)
  server.addHook("onReady", () => {
    setupPreviewWebSocketProxy(
      server.server,
      containerManager,
      config.PREVIEW_MODE,
      config.PREVIEW_DOMAIN,
      auth,
      sessionRegistry,
      config.BETTER_AUTH_SECRET,
    );
  });

  // Lifecycle hooks
  server.addHook("onReady", async () => {
    // Run Better Auth migrations
    const { getMigrations } = await import("better-auth/db/migration");
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();

    // Backfill: assign orphaned data to the first registered user
    try {
      const firstUser = (await db.execute(sql`SELECT id FROM "user" ORDER BY "createdAt" ASC LIMIT 1`)).rows;
      if (firstUser.length > 0) {
        const userId = (firstUser[0] as { id: string }).id;
        // Profiles with user_id=NULL are shared — don't reassign them
        await db.execute(sql`UPDATE workspaces SET user_id = ${userId} WHERE user_id IS NULL`);
        await db.execute(sql`UPDATE api_tokens SET user_id = ${userId} WHERE user_id IS NULL`);
        await db.execute(sql`UPDATE workspaces SET name = 'Workspace ' || substr(created_at, 1, 10) WHERE name IS NULL`);
      }
    } catch { /* No users yet — skip backfill */ }

    // Mark stale running/queued tasks as failed on startup
    // (their containers are gone after a restart)
    const staleResult = await db.execute(sql`UPDATE tasks SET status = 'failed', error = 'Server restarted' WHERE status IN ('running', 'queued')`);
    if (staleResult.rowCount && staleResult.rowCount > 0) {
      server.log.info({ count: staleResult.rowCount }, "Marked stale tasks as failed");
    }

    // Order matters: hydrate session registry FIRST so containerPool.init()'s
    // sweepOrphans() can see existing workspace containers and skip them.
    // Otherwise it nukes every paused/running session container on every
    // server restart, and loadFromDB then marks them all resumable.
    await sessionRegistry.loadFromDB(containerManager);
    if (config.DOCKER_ENABLED) {
      await containerPool.init();
    }
    orchestrator.start();
    sessionRegistry.start();
    connectionManager.start();
    playbookScheduler.start();
    metrics.startPeriodicFlush(config.METRICS_FLUSH_INTERVAL_SECS * 1000);
    // Best-effort: registers the platform Telegram bot's webhook if the
    // env vars are set. Silent no-op otherwise. Never throws — failure
    // disables the feature without taking the server down.
    await platformBotService.init();
    // Background re-sync of every connected bot's slash-command menu.
    // Telegram clients cache the menu, so bots paired before a
    // BOT_COMMANDS update keep serving the stale list until we call
    // setMyCommands again. Fire-and-forget so it doesn't gate readiness.
    void resyncTelegramBotCommands({
      integrationService,
      telegramService,
      platformBotToken: platformBotService.getToken(),
      log: server.log,
    });
    server.log.info("Vonzio server ready");
  });

  server.addHook("onClose", async () => {
    await orchestrator.stop();
    await containerPool.shutdown();
    playbookScheduler.stop();
    sessionRegistry.stop();
    connectionManager.stop();
    metrics.stop();
    modelListService.stop();
    orchestrator.removeAllListeners();
  });

  return server;
}
