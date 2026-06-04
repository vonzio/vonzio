# Building Vonzio Plugins

A guide for authors of `@vonzio/plugin-*` packages.

Vonzio plugins extend the server (routes, notification handlers, MCP
servers, scheduled jobs) and the dashboard (settings sections, header
slots, integration rows). They install via npm workspaces and load at
boot from the `VONZIO_PLUGINS` env list. The two reference
implementations — `@vonzio/plugin-telegram` and `@vonzio/plugin-slack`
— show every contract surface in production use.

This doc is the contract; for the running examples, read the two
plugins side by side.

---

## Table of contents

1. [What a plugin is](#1-what-a-plugin-is)
2. [Lifecycle](#2-lifecycle)
3. [`PluginContext` — what `init()` receives](#3-plugincontext--what-init-receives)
4. [`PluginCore` — services exposed to plugins](#4-plugincore--services-exposed-to-plugins)
5. [Notification bus](#5-notification-bus)
6. [Session presence](#6-session-presence)
7. [Session events](#7-session-events)
8. [Schema + migrations](#8-schema--migrations)
9. [Frontend slots](#9-frontend-slots)
10. [Walkthrough: telegram (full-stack chat plugin)](#10-walkthrough-telegram-full-stack-chat-plugin)
11. [Walkthrough: slack (OAuth-based notify channel)](#11-walkthrough-slack-oauth-based-notify-channel)
12. [Common patterns](#12-common-patterns)
13. [Testing](#13-testing)
14. [Publishing & loading](#14-publishing--loading)

---

## 1. What a plugin is

A vonzio plugin is an npm package that exports a default object
satisfying the `VonzioPlugin` interface from `@vonzio/plugin-api`:

```ts
import type { VonzioPlugin } from "@vonzio/plugin-api";
import { z } from "zod";

const plugin: VonzioPlugin = {
  name: "myplugin",
  apiVersion: "0.1.0",
  configSchema: z.object({ MY_API_KEY: z.string().optional() }),
  migrations: [],            // optional
  routePrefix: { kind: "auto" }, // optional
  async init(ctx) {
    ctx.log.info("hello from myplugin");
  },
  async teardown() {},       // optional
};

export default plugin;
```

The loader imports the package, runs migrations, parses config from
process.env via the Zod schema, builds the per-plugin
`PluginContext`, then calls `init(ctx)`. The plugin registers
everything it needs to during init.

### What a plugin can do

| Surface | How | Reference |
|---|---|---|
| HTTP routes | `ctx.server.{get,post,...}` or `ctx.server.register()` | telegram `events.ts`, slack `oauth.ts` |
| Notification channel | `ctx.notificationBus.registerHandler(kind, handler)` | telegram + slack `notify-handler.ts` |
| Chat-surface presence | `ctx.core.sessionPresence.register({...})` | both plugins' `presence-provider.ts` |
| Orchestrator events | `ctx.sessionEvents.on("task:*", handler)` | both plugins' `events.ts` |
| Scheduled jobs | `ctx.scheduler.cron(name, schedule, fn)` | telegram's bot-commands resync (called inline, no cron) |
| MCP server | `ctx.mcpRegistry.registerServer({...})` | not yet used by either reference plugin |
| Dashboard settings tab | `registerSettingsSection({...})` in `frontend.tsx` | (none — telegram demoted to row in 3G) |
| Dashboard integration row | `registerIntegrationRow({...})` in `frontend.tsx` | telegram + slack `dashboard/<Plugin>IntegrationRow.tsx` |
| Workspace header button | `registerWorkspaceHeaderSlot({...})` | telegram `WorkspaceHeaderTelegramButton.tsx` |

### What a plugin cannot do

- Modify core service behavior (no monkey-patching, no shared mutable state)
- Read or write tables it doesn't own (use the typed
  `ctx.core.integrations`, `ctx.core.workspaces`, etc. surfaces)
- Block core boot — if `init()` throws, the loader logs and skips that
  plugin; core continues with whatever else loaded

---

## 2. Lifecycle

```
boot
 │
 ├─ core resolves VONZIO_PLUGINS env list ("@vonzio/plugin-foo,@vonzio/plugin-bar")
 │
 ├─ for each plugin in order:
 │   ├─ dynamic import the package
 │   ├─ validate the default export shape (assertPluginShape)
 │   ├─ check apiVersion compatibility (assertApiCompatible)
 │   ├─ run plugin migrations (idempotent, CREATE TABLE IF NOT EXISTS)
 │   ├─ parse config from process.env via configSchema
 │   ├─ build PluginContext
 │   └─ call init(ctx)        ← this is your code
 │
 ├─ server.listen()
 │
 └─ on shutdown:
     └─ teardown() for each loaded plugin (best-effort)
```

`init()` runs **once at boot** before the server starts handling
traffic. It must not block on external services (no API roundtrips
to a third-party). For boot-time-but-async work (registering a
webhook with an upstream provider, refreshing a cached menu), kick
it off with `void someInit()` and let it complete in the background.

The loader runs init() inside `server.register(async (scope) => {...})`
which is a Fastify boot-phase callback. That's the only time you can
register new routes; doing it later (e.g. in a setTimeout) throws
"Root plugin has already booted".

---

## 3. `PluginContext` — what `init()` receives

```ts
interface PluginContext<TConfig = unknown> {
  server: FastifyInstance;          // raw fastify (for ctx.server.register / .get / .post)
  config: TConfig;                  // parsed from process.env via configSchema
  log: PluginLogger;                // pino child, pre-tagged with { plugin: name }
  core: PluginCore;                 // see §4
  notificationBus: NotificationBus; // §5
  mcpRegistry: McpRegistry;         // for contributing MCP servers
  scheduler: Scheduler;             // for cron / interval jobs
  sessionEvents: SessionEvents;     // §7 — typed orchestrator events
}
```

### `ctx.server`

Plain Fastify. Register routes the way Fastify expects:

```ts
ctx.server.get("/v1/myplugin/health", async () => ({ ok: true }));

// or via a fastify-plugin module:
await ctx.server.register(myRoutes, { /* opts */ });
```

`routePrefix` on the plugin export is **informational only in v0.1**.
The plugin must use the full path it wants in `ctx.server.get(...)`.
Future versions may automate prefix scoping; until then, use
absolute paths.

### `ctx.config`

Whatever your Zod schema parses out. Plugins should namespace their
env vars (`MYPLUGIN_API_KEY`, not `API_KEY`) to avoid collisions.

The loader calls `configSchema.parse(process.env)`. `process.env`
values are strings; coerce in the schema:

```ts
const configSchema = z.object({
  MYPLUGIN_PORT: z.coerce.number().default(8080),
  MYPLUGIN_DEBUG: z.coerce.boolean().default(false),
});
```

### `ctx.log`

Pino logger, pre-tagged with `{ plugin: "<name>" }`:

```ts
ctx.log.info({ count: 3 }, "processed events");
ctx.log.warn("retrying connection");
ctx.log.error({ err }, "send failed");
```

Don't log decrypted secrets. Don't log payloads that may contain
PII without redaction.

---

## 4. `PluginCore` — services exposed to plugins

Adding a field to `PluginCore` is a stability commitment. The
current surface:

| Field | Type | Use |
|---|---|---|
| `db` | `unknown` (cast to `NodePgDatabase<typeof yourSchema>`) | Drizzle handle for plugin-owned tables |
| `encryption` | `{ encrypt(s), decrypt(s) }` | AES-256-GCM via the master vault key |
| `integrations` | `PluginIntegrationLookup` | Read + mutate `user_integrations` rows |
| `profiles` | `PluginProfileLookup` | Read agent profiles by id/user |
| `profileResolver` | `PluginProfileResolver` | Get full `ResolvedProfile` (env, tools, claude_md, ...) |
| `workspaces` | `PluginWorkspaceLookup` | Read/list/update `workspaces` rows |
| `tasks` | `PluginTaskSubmitter` | Submit new tasks (chat surfaces use this for inbound) |
| `sessionLifecycle` | `PluginSessionLifecycle` | Create/extend/status-change sessions |
| `orchestrator` | `PluginOrchestrator` | `wakeWorkspaceContainer(sessionId, profile)` |
| `eventLog` | `PluginEventLog` | Append + read session timeline |
| `connectionManager` | `PluginConnectionManager` | Push events to dashboard WS clients |
| `imageRewriter` | `PluginImageRewriter` | Strip inline images, get signed URLs |
| `modelList` | `PluginModelList` | List models available to a profile |
| `sessionPresence` | `PluginSessionPresenceRegistry` | Register a chat-surface presence provider (§6) |
| `authHook` | `onRequestHookHandler` | Opt-in auth for plugin routes |

### `ctx.core.db`

Plugins own their drizzle schema. Cast the handle once:

```ts
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { mytable } from "./db/schema.js";

const db = ctx.core.db as NodePgDatabase<Record<string, never>>;
await db.insert(mytable).values({...});
```

Don't query tables you don't own. Use the typed services above
(`integrations`, `workspaces`, etc.) for cross-cutting reads.

### `ctx.core.encryption`

```ts
const encrypted = ctx.core.encryption.encrypt(JSON.stringify({ token: "..." }));
// later:
const decrypted = JSON.parse(ctx.core.encryption.decrypt(encrypted));
```

Use it for any secret that lands in your DB (OAuth tokens, API
keys). The key lives in `ENCRYPTION_KEY` env on the core side;
plugins don't see it.

### `ctx.core.integrations`

Manage rows in `user_integrations`. Most-used methods:

```ts
// Lookup
await ctx.core.integrations.getByUserAndType(userId, "myplugin");
await ctx.core.integrations.listByUserAndType(userId, "myplugin");
await ctx.core.integrations.findByTypeAndExternalId("myplugin", externalId);

// Create / update
await ctx.core.integrations.create(userId, "myplugin", { token: encrypted, ... });
await ctx.core.integrations.update(id, { config: ..., enabled: false });
await ctx.core.integrations.delete(id);
```

Notes:
- `config` is stored encrypted by core; pass plaintext in/out.
- `update(id, ..., { expectUpdatedAt: ... })` is a compare-and-swap
  for race-safe pairing flows (e.g. telegram's `/link <code>`).
- The integration row's `type` is the discriminator. Pick a stable
  short string ("telegram", "slack", "github", etc.) and use it
  consistently.
- Each row carries `scope` (`"all" | "agents"`) and `profile_ids`
  (plugin-api ≥ 1.1.0). To honour the user's per-profile visibility when
  surfacing a row to an agent (e.g. an MCP tool), filter with
  `scope === "all" || profile_ids.includes(profileId)` — where `profileId`
  comes from `ctx.mcpSessions.resolve(token)`.

---

## 5. Notification bus

Core dispatches outbound notifications (playbook completion,
ask-user fallback) by `kind`. Plugins claim a kind and handle the
send:

```ts
import type { NotificationHandler } from "@vonzio/plugin-api";

const handler: NotificationHandler = async (req) => {
  // req.kind === "myplugin"
  // req.recipient is the integration id (or whatever you accept)
  // req.text is the body, req.metadata is per-message metadata

  const integration = await ctx.core.integrations.get(req.recipient, { decrypt: true });
  if (!integration) {
    return { ok: false, error: "integration not found", retryable: false };
  }
  // ... call the provider's API ...
  return { ok: true };
};

ctx.notificationBus.registerHandler("myplugin", handler);
```

Return shape:
- `{ ok: true }` — done, success.
- `{ ok: false, error, retryable }` — `retryable: true` for rate
  limits / transient network errors; `false` for invalid config /
  missing integration.

One handler per kind, registered once. Re-registering throws (caught
at boot).

---

## 6. Session presence

The orchestrator needs to know whether a session is reachable on a
chat surface (to decide whether `AskUserQuestion` will hang, and to
inform the agent in the system prompt). Each chat plugin registers a
presence provider:

```ts
ctx.core.sessionPresence.register({
  surface: "myplugin",  // stable key
  metadata: {
    label: "MyPlugin (slow surface — phone-typing latency)",
    slow: true,         // triggers the agent's "use short button options" steer
  },
  async hasSession(sessionId) {
    // Is this session bound to a chat thread on my surface?
    const rows = await db.select(...);
    return rows.length > 0;
  },
  // Optional methods
  async hasOwnerSurface(userId) {
    // Will my surface deliver to this user's account-wide channel
    // (e.g. a DM bot) regardless of session binding?
    return userHasLinkedBot(userId);
  },
  async resolveUserIdBySession(sessionId) {
    // Fallback: when the in-memory SessionRegistry doesn't have the
    // session yet, find user_id by walking my chat-binding table.
    return rows[0]?.user_id ?? null;
  },
  async listEngagedSessionIds() {
    // Session ids the user has actively engaged on my surface
    // (e.g. claimed a playbook thread). Keeps these visible in the
    // workspace list even when filters would hide them.
    return new Set(rows.map(r => r.session_id));
  },
});
```

`hasSession` is required; the rest are optional. Core treats missing
methods as "doesn't apply."

---

## 7. Session events

Five orchestrator events you can subscribe to:

```ts
ctx.sessionEvents.on("task:token",   (taskId, sessionId, text) => {...});
ctx.sessionEvents.on("task:tool_use",(taskId, sessionId, tool, input?) => {...});
ctx.sessionEvents.on("task:ask_user",(taskId, sessionId, input) => {...});
ctx.sessionEvents.on("task:done",    (taskId, sessionId, result?) => {...});
ctx.sessionEvents.on("task:failed",  (taskId, sessionId, error?) => {...});
```

Use these to relay agent activity to the chat surface — streaming
tokens, posting final results, surfacing ask_user prompts.

Handlers fire in parallel; if you need ordering, queue inside your
handler. Don't block — the orchestrator's emit is fire-and-forget.

`sessionId` may be `undefined` for tasks not bound to a session
(one-off API calls). Early-return in that case.

---

## 8. Schema + migrations

Plugins own their drizzle tables. Layout:

```
src/db/
  schema.ts       # pgTable definitions
  migrations.ts   # PluginMigration[] — runs once on first boot
```

`schema.ts`:

```ts
import { pgTable, text, index } from "drizzle-orm/pg-core";

export const myThing = pgTable("myplugin_things", {
  id: text("id").primaryKey(),
  user_id: text("user_id").notNull(),
  data: text("data").notNull(),
  created_at: text("created_at").notNull(),
}, (t) => [
  index("myplugin_things_user_idx").on(t.user_id),
]);
```

`migrations.ts`:

```ts
import type { PluginMigration } from "@vonzio/plugin-api";

const initial: PluginMigration = {
  name: "0001_initial",
  up: `
    CREATE TABLE IF NOT EXISTS myplugin_things (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS myplugin_things_user_idx ON myplugin_things(user_id);
  `,
};

export const myPluginMigrations: PluginMigration[] = [initial];
```

And wire it up:

```ts
const plugin: VonzioPlugin = {
  name: "myplugin",
  apiVersion: "0.1.0",
  configSchema,
  migrations: myPluginMigrations,  // ← here
  async init(ctx) {...},
};
```

The loader tracks applied migrations in `_plugin_migrations` keyed
by `(plugin_name, migration_name)`. Migrations are idempotent
(`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT
EXISTS`) so half-apply failures can be re-attempted on next boot
without leaving the schema weird.

Naming convention: `NNNN_short_description`, e.g.
`0001_initial_schema`, `0002_add_thread_label`. Apply in declared
order.

---

## 9. Frontend slots

The dashboard exposes registry slots. Plugins contribute by exporting
a `register()` function from `frontend.tsx`:

```ts
// packages/plugins/myplugin/src/frontend.tsx
import {
  registerSettingsSection,
  registerIntegrationRow,
  registerWorkspaceHeaderSlot,
  // ...
} from "@vonzio/dashboard/registry/api";
import type { PluginFrontendEntry } from "@vonzio/plugin-api/frontend";

const register: PluginFrontendEntry = () => {
  registerIntegrationRow({
    id: "myplugin",
    component: MyPluginRow,
    section: "notifications",
    order: 120,
  });
};

export default register;
```

A plugin's frontend is bundled into the dashboard **only when the
operator policy approves it**. The dashboard's `vonzio-plugins` Vite
plugin reads `vonzio-plugins.builtins.json` + the operator's
`vonzio-plugins.json` at build time and bundles a plugin's frontend
only if its policy entry sets `approved_frontend: true` (built-ins are
auto-approved; externals require `vonzio plugin approve --frontend`).
The approved set is exposed to `plugins.ts` via the virtual module
`virtual:vonzio-plugins`, and `dist/.plugins.json` records what was
bundled so the server can verify build↔runtime parity at boot.

Frontend code runs in the dashboard origin with full DOM + session
access — approving it is a real trust grant (see
[SECURITY_MODEL.md](./SECURITY_MODEL.md) and the loader spec §2). The
dashboard ships a strict Content-Security-Policy
(`script-src 'nonce-<per-request>' 'strict-dynamic'`, no `'self'`) so
**bundling is the only path code reaches the dashboard origin**: a
script served from a plugin's Fastify route (or injected via XSS) lacks
the per-request nonce and the browser refuses it. Approved frontend code
is still fully trusted once bundled.

### Available slots (v0.1)

| Slot | Use | Receives |
|---|---|---|
| `registerRoute` | Top-level route | `{ id, path, element, layout? }` |
| `registerNavItem` | Sidebar entry | `{ id, section, label, to, icon, ... }` |
| `registerSettingsSection` | Settings tab | `{ id, label, lede?, component, order? }` |
| `registerTopbarSlot` | Topbar control | `{ id, placement, component, order? }` |
| `registerWorkspaceHeaderSlot` | Workspace chat header button | `{ id, component, order? }` — component receives `{ workspace }` props |
| `registerComposerSlot` | Composer meta line | `{ id, component, order? }` — receives `{ workspaceId, profileId, attachedTunnel? }` |
| `registerIntegrationRow` | Row in Settings > Integrations | `{ id, component, section, order? }` — receives `IntegrationRowSlotProps` |
| `registerOnboardingStep` | First-run flow step | `{ id, component, predicate?, order? }` |
| `registerUserMenuItem` | Avatar dropdown | `{ id, label, to?, onClick?, ... }` |

### Slot guidance — sparse vs rich plugins

Two patterns established by the reference plugins:

- **Sparse**: just a row. Plugin contributes via
  `registerIntegrationRow` with inline actions (Connect, Disconnect).
  Example: slack (one OAuth button).
- **Rich**: row + drawer. Plugin contributes a row that opens a
  Modal containing a full settings UI when the user clicks Manage.
  Example: telegram (bot list, QR codes, multi-bot management).

Either pattern uses the same `registerIntegrationRow` slot — the
difference is content density inside the component.

### `IntegrationRowSlotProps` — what your row component receives

```ts
interface IntegrationRowSlotProps {
  integrations: ReadonlyArray<Integration>;
  agentProfiles: ReadonlyArray<{ id; slug; name }>;
  refetch: () => void;
  openScopeEditor: (integrationId: string) => void;
  handleSetDefault: (id: string) => Promise<void>;
  handleTest: (id: string) => Promise<void>;
  testResult: { id; status; message } | null;
  testingId: string | null;
  scopeSummary: (i) => string;
}
```

Find your integration row by `integrations.find(i => i.type === "myplugin")`.
Plugin owns its own data fetching for plugin-specific endpoints (e.g.
`useApi(fetchMyPluginConfig)`).

### Plugin frontend API client

If your plugin has dashboard-side calls to its own `/v1/...` routes,
duplicate ~30 LOC of a `request()` helper in `dashboard/api.ts`. See
`packages/plugins/telegram/src/dashboard/api.ts` and slack's
equivalent. The alternative — exposing the dashboard's internal
client publicly — couples every plugin to dashboard internals.

---

## 10. Walkthrough: telegram (full-stack chat plugin)

Reference: `packages/plugins/telegram/`.

### File layout

```
src/
  index.ts              # VonzioPlugin export
  types.ts              # TelegramConfig (shape stored on user_integrations.config)
  notify-handler.ts     # outbound: bus dispatch -> Bot API send
  presence-provider.ts  # is this session bound to a TG chat?
  frontend.tsx          # registerIntegrationRow + registerWorkspaceHeaderSlot
  db/
    schema.ts           # telegram_sessions, telegram_active_sessions, telegram_playbook_threads
    migrations.ts       # 0001_initial_telegram_schema
  routes/
    events.ts           # inbound webhook + 5 task:* relay handlers
    setup.ts            # auth-gated /v1/integrations/telegram/* config routes
  services/
    telegram-service.ts # Bot API client
    platform-bot-service.ts # platform-hosted bot (env-driven)
  dashboard/
    api.ts              # plugin's frontend HTTP client
    TelegramIntegrationRow.tsx    # row + drawer
    TelegramSettings.tsx          # the drawer content (bot list, QR, modal)
    WorkspaceHeaderTelegramButton.tsx
```

### `init()` highlights

```ts
async init(ctx) {
  const telegramService = new TelegramService();
  const platformBotService = new PlatformBotService(ctx.config, telegramService, ctx.log);
  void platformBotService.init();    // fire-and-forget setWebhook

  // Auth-gated routes inside an explicit child scope (fp() leak prevention)
  await ctx.server.register(async (oauthScope) => {
    await oauthScope.register(telegramSetupRoutes, {
      ... ctx.core surfaces ...,
      authHook: ctx.core.authHook,
    });
  });

  // Public webhook route + 5 task:* subscriptions
  await ctx.server.register(telegramEventsRoutes, {
    db: ctx.core.db as NodePgDatabase<...>,
    integrationService: ctx.core.integrations,
    taskService: ctx.core.tasks,
    sessionRegistry: ctx.core.sessionLifecycle,
    workspaceService: ctx.core.workspaces,
    orchestrator: ctx.core.orchestrator,
    eventLog: ctx.core.eventLog,
    connectionManager: ctx.core.connectionManager,
    imageRewriterService: ctx.core.imageRewriter,
    modelListService: ctx.core.modelList,
    profileService: { ...ctx.core.profiles, ...ctx.core.profileResolver },
    sessionEvents: ctx.sessionEvents,
    platformBotService,
    // ...
  });

  ctx.notificationBus.registerHandler("telegram", buildTelegramNotifyHandler(ctx));
  ctx.core.sessionPresence.register(buildTelegramPresenceProvider(ctx));
  void resyncTelegramBotCommands({ ... });
}
```

Reads:
- The plugin owns three tables (`telegram_*`).
- The plugin claims the `telegram` notification kind, the `telegram`
  presence surface, the `/api/telegram/webhook/:botId` route, and the
  `/v1/integrations/telegram/*` setup routes.
- The plugin contributes a row + drawer in the dashboard, and a
  workspace header button.

---

## 11. Walkthrough: slack (OAuth-based notify channel)

Reference: `packages/plugins/slack/`.

Smaller surface than telegram — no rich UI, just OAuth + outbound +
inbound events.

### File layout

```
src/
  index.ts
  types.ts              # SlackConfig
  notify-handler.ts     # outbound: open DM, send via Bot API
  presence-provider.ts
  frontend.tsx          # registerIntegrationRow
  db/
    schema.ts           # slack_thread_mappings
    migrations.ts       # 0001_initial_slack_schema
  routes/
    oauth.ts            # /v1/integrations/slack/{config,authorize} + /api/slack/callback
    events.ts           # /api/slack/events + 5 task:* relay handlers
  services/
    slack-service.ts    # Bot API client
  dashboard/
    api.ts
    SlackIntegrationRow.tsx
```

### What's different from telegram

- **OAuth** instead of token-paste. Slack callback decrypts the
  state, exchanges code for `bot_token`, creates the
  `user_integrations` row.
- **Slash commands** + **events** share `/api/slack/events`.
- **No rich UI** — `SlackIntegrationRow` is the entire dashboard
  surface; no drawer needed.
- **OAuth path requires the `fp()` leak fix** (see common patterns)
  because slack-oauth.ts addHook'd auth at the top level.

---

## 12. Common patterns

### Calling an mTLS upstream (`secrets.mtls`)

If an upstream requires a client certificate (mutual TLS — e.g. the Teller
banking API), you never handle the private key yourself. Declare the capability
and the logical cert names; the operator provisions the PEM files in policy:

```jsonc
// package.json "vonzio" block
"capabilities": ["http.outbound", "secrets.mtls"],
"outboundHosts": ["api.teller.io"],
"mtlsSecrets": ["teller-client"]
```

```ts
// in init() / a request handler
const ref = ctx.secrets.mtls("teller-client");          // opaque — no bytes
const res = await ctx.http.fetch("https://api.teller.io/accounts", { mtls: ref });
```

The operator maps each name to host files in `vonzio-plugins.json`
(`mtls_secrets: { "teller-client": { cert, key, ca?, passphraseEnv? } }`). Core
reads the PEMs and presents the cert server-side; your code only ever holds the
opaque ref. A name you didn't declare (or the operator didn't provision) throws
`CapabilityViolationError`. See [PLUGIN_LOADER_SPEC.md §5](./PLUGIN_LOADER_SPEC.md).

### Auth scoping for fastify-plugins

`fastify-plugin` (`fp()`) intentionally un-encapsulates so a registered
plugin can decorate the parent server. If your fp'd plugin calls
`server.addHook("onRequest", authHook)`, the hook lifts to the parent
— and any route registered on the parent **after** your fp inherits
that auth check.

This bit us when slack-oauth's auth gating started rejecting public
webhook requests. The fix: wrap the auth-gated registration in an
explicit child scope so fp() only lifts to that scope, not all the
way to the root server:

```ts
// In init():
await ctx.server.register(async (authedScope) => {
  await authedScope.register(myAuthedRoutes, { authHook: ctx.core.authHook });
});

// Public routes register on ctx.server directly — outside the wrapping scope.
await ctx.server.register(myPublicRoutes, {...});
```

Inside `myAuthedRoutes` (which is `fp()`'d), `server.addHook("onRequest", authHook)`
now lifts to `authedScope`, not root. The public routes stay
unauthed.

### Dashboard `request()` helper duplication

The dashboard's internal `request()` helper isn't a public export.
Plugins' `dashboard/api.ts` duplicates ~30 LOC of it:

```ts
const BASE = "/v1";
const ORG_ID_STORAGE_KEY = "vonzio_current_org_id";

function readCurrentOrgId() {
  if (typeof localStorage === "undefined") return null;
  try { return localStorage.getItem(ORG_ID_STORAGE_KEY); }
  catch { return null; }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...options.headers as Record<string, string> };
  if (options.body) headers["Content-Type"] = "application/json";
  const orgId = readCurrentOrgId();
  if (orgId) headers["X-Org-Id"] = orgId;
  const res = await fetch(`${BASE}${path}`, {
    ...options, credentials: "include", headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? "Request failed");
  }
  return res.json();
}
```

Duplication is intentional — exposing the helper as a public API
would couple every plugin to dashboard internals.

### Raw SQL fallback while schema is in transit

If your plugin reads a table that hasn't moved to your drizzle
schema yet (e.g. during an in-flight extraction), use raw SQL via
`ctx.core.db.execute(sql\`...\`)`. Pattern from telegram's
presence-provider before 3D.1c:

```ts
const result = await db.execute(sql`
  SELECT 1 FROM telegram_sessions WHERE session_id = ${sessionId} LIMIT 1
`);
return result.rows.length > 0;
```

Once the schema moves into your plugin's drizzle schema, switch to
typed reads.

### Update_id / event_id dedup for at-least-once webhooks

Chat-surface webhooks redeliver on retry. Without dedup, every retry
spawns a duplicate reply. Pattern from telegram's events.ts post-#84:

```ts
const seenUpdateIds = new Set<number>();
const DEDUP_TTL_MS = 5 * 60 * 1000;
function remember(updateId: number) {
  seenUpdateIds.add(updateId);
  setTimeout(() => seenUpdateIds.delete(updateId), DEDUP_TTL_MS).unref?.();
}

// In webhook handler, AFTER the 200 ACK:
if (seenUpdateIds.has(update.update_id)) {
  request.log.info({ updateId: update.update_id }, "skipping duplicate");
  return;
}
remember(update.update_id);
```

Bounded by TTL; trivial memory cost (worst-case ~9k entries at
Slack's 30/sec/bot ceiling).

### Sandboxed boot failures

If your `init()` throws, the loader logs and continues. So:

- Don't throw — return early with a log.warn if a feature is disabled.
- Make migration errors meaningful — the loader DOES propagate
  migration failures (better to fail boot than run with a
  half-migrated schema).

---

## 13. Testing

### Unit tests

Plugins ship Vitest. Run with `npm test --workspace=packages/plugins/myplugin`.

For services that take a `PluginContext`, mock the surfaces you use:

```ts
const ctx = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  core: {
    integrations: {
      get: vi.fn().mockResolvedValue({ id: "i1", user_id: "u1", config: {...} }),
    },
    // ... only what you need
  },
} as unknown as PluginContext;
```

### Integration tests with the real backend

For end-to-end webhook tests, the smoke test setup in
`scripts/start-dev.sh` boots the full stack. For automated CI,
spinning up postgres + a fake-provider mock server is the pattern.

---

## 14. Publishing & loading

### Local development

Add your plugin to `package.json` workspaces:

```json
{
  "workspaces": ["packages/shared", "packages/plugin-api", "packages/plugins/*", ...]
}
```

Then add it to `core-server` and `dashboard` deps:

```json
{ "@vonzio/plugin-myplugin": "*" }
```

Add to `VONZIO_PLUGINS` env default in `docker-compose.dev.yml`:

```yaml
- VONZIO_PLUGINS=${VONZIO_PLUGINS:-@vonzio/plugin-telegram,@vonzio/plugin-slack,@vonzio/plugin-myplugin}
```

And mount the plugin source for hot reload:

```yaml
volumes:
  - ../packages/plugins/myplugin/src:/app/packages/plugins/myplugin/src
```

For the frontend half, register it in `packages/dashboard/src/plugins.ts`:

```ts
import myPluginRegister from "@vonzio/plugin-myplugin/frontend";
const plugins: PluginEntry[] = [
  // ...
  { name: "myplugin", register: myPluginRegister },
];
```

### CI

Add a tsc step in `.github/workflows/ci.yml`:

```yaml
- run: npx tsc --project packages/plugins/myplugin/tsconfig.json --noEmit
```

### tsconfig path mapping

If your plugin's frontend imports from `@vonzio/dashboard/*` and
walks into dashboard files via the public exports, your tsconfig
needs the `@/*` path alias mapping (dashboard files use it
internally):

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "baseUrl": ".",
    "paths": { "@/*": ["../../dashboard/src/*"] }
  },
  "include": ["src/**/*"]
}
```

---

## When the contract changes

Plugin-api lives at `0.1.0` and is **additive-only** until 1.0. New
fields land on `PluginCore` as needed (each addition is a stability
commitment). Breaking changes require a major bump and a migration
guide.

If you need a `PluginCore` surface that doesn't exist:

1. Open an issue describing the use case + the minimum shape.
2. Propose a structural type (don't bind to a concrete service class).
3. The plugin contract gets the addition, the loader threads it
   through. Existing plugins are unaffected.

If your plugin works against `0.1.x` and breaks against `0.2.x`,
pin `apiVersion` and ship a compatibility shim. Don't silently
drift.

---

## See also

- Reference plugins: `packages/plugins/telegram/`,
  `packages/plugins/slack/`
- Contract source: `packages/plugin-api/src/index.ts`
- Loader: `packages/core-server/src/plugins/loader.ts`
- Dashboard registry: `packages/dashboard/src/registry/`
- Security model: `docs/SECURITY_MODEL.md`
- Hardening guide: `docs/HARDENING.md`
