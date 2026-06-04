# Building Vonzio Plugins

A guide for authors of `@vonzio/plugin-*` packages.

Vonzio plugins extend the server (routes, notification handlers, MCP
servers, scheduled jobs) and the dashboard (settings sections, header
slots, integration rows). A plugin declares the capabilities it needs
in its `package.json`, the operator approves them, and the loader hands
the plugin a `ctx` whose surfaces are shaped to exactly what was
granted. The two reference implementations —
`@vonzio/plugin-telegram` and `@vonzio/plugin-slack` — exercise nearly
every contract surface in production use; `examples/plugin-hello` is a
minimal three-capability example.

This doc is the contract; for the running examples, read the reference
plugins side by side.

---

## Table of contents

1. [What a plugin is](#1-what-a-plugin-is)
2. [Built-in vs external plugins](#2-built-in-vs-external-plugins)
3. [The published SDK packages](#3-the-published-sdk-packages)
4. [The manifest (`vonzio` block)](#4-the-manifest-vonzio-block)
5. [Capabilities](#5-capabilities)
6. [Operator policy + the approve flow](#6-operator-policy--the-approve-flow)
7. [Lifecycle](#7-lifecycle)
8. [`PluginContext` — what `init()` receives](#8-plugincontext--what-init-receives)
9. [`ctx.core` — capability-gated core services](#9-ctxcore--capability-gated-core-services)
10. [Data access: storage vs scoped DB](#10-data-access-storage-vs-scoped-db)
11. [Outbound HTTP + mTLS secrets](#11-outbound-http--mtls-secrets)
12. [Notification bus](#12-notification-bus)
13. [Session presence](#13-session-presence)
14. [Session events](#14-session-events)
15. [MCP servers](#15-mcp-servers)
16. [Migrations](#16-migrations)
17. [Frontend slots](#17-frontend-slots)
18. [Walkthrough: telegram (full-stack chat plugin)](#18-walkthrough-telegram-full-stack-chat-plugin)
19. [Walkthrough: slack (OAuth-based notify channel)](#19-walkthrough-slack-oauth-based-notify-channel)
20. [Common patterns](#20-common-patterns)
21. [Testing](#21-testing)
22. [Publishing & loading](#22-publishing--loading)
23. [When the contract changes](#23-when-the-contract-changes)

---

## 1. What a plugin is

A vonzio plugin is an npm package with two halves:

- A **static manifest** — the `vonzio` block in `package.json`. It
  declares the api version the plugin targets, its entry points, and
  the capabilities it wants. The loader reads + validates this **from
  disk before importing any plugin code**, and cross-checks it against
  the operator policy.
- A **runtime default export** satisfying the `VonzioPlugin` interface
  from `@vonzio/plugin-api`:

```ts
import type { VonzioPlugin } from "@vonzio/plugin-api";
import { z } from "zod";

const plugin: VonzioPlugin = {
  name: "myplugin",
  apiVersion: "1.1",
  configSchema: z.object({ MYPLUGIN_API_KEY: z.string().optional() }),
  migrations: [],                  // optional
  routePrefix: { kind: "auto" },   // optional, defaults to auto
  async init(ctx) {
    ctx.log.info("hello from myplugin");
  },
  async teardown() {},             // optional
};

export default plugin;
```

At boot the loader validates the manifest, checks api compatibility,
cross-checks the operator policy, runs migrations, parses config from
`process.env` via the Zod schema, builds the per-plugin
`PluginContext` (shaped to the granted capabilities), then calls
`init(ctx)`. The plugin registers everything it needs during `init`.

### What a plugin can do

| Surface | How | Capability | Reference |
|---|---|---|---|
| HTTP routes | `ctx.server.{get,post,...}` / `ctx.server.register()` | — | telegram `events.ts`, slack `oauth.ts` |
| Notification channel | `ctx.notificationBus.registerHandler(kind, handler)` | `notifications.channel` | telegram + slack `notify-handler.ts` |
| Chat-surface presence | `ctx.core.sessionPresence.register({...})` | `presence.register` | both plugins' `presence-provider.ts` |
| Orchestrator events | `ctx.sessionEvents.on("task:*", handler)` | `events.subscribe` | both plugins' `events.ts` |
| Scheduled jobs | `ctx.scheduler.cron(...)` / `.interval(...)` | `scheduler.run` | — |
| MCP server | `ctx.mcpRegistry.registerServer({...})` | `mcp.register` | — |
| Outbound HTTP | `ctx.http.fetch(url, init)` | `http.outbound` | hello `index.ts` |
| Per-plugin key/value store | `ctx.storage.{get,set,delete,list}` | `storage.kv` | hello `index.ts` |
| Dashboard integration row | `registerIntegrationRow({...})` in `frontend.tsx` | — (frontend approval) | telegram + slack `dashboard/<Plugin>IntegrationRow.tsx` |
| Workspace header button | `registerWorkspaceHeaderSlot({...})` | — (frontend approval) | telegram `WorkspaceHeaderTelegramButton.tsx` |

Every `ctx`/`ctx.core` surface beyond plain `ctx.server` is gated by a
capability — see §5.

### What a plugin cannot do

- Touch a `ctx`/`ctx.core` surface it didn't declare + get granted —
  the access throws `CapabilityViolationError` and is audited (§9).
- Read or write tables it doesn't own. New plugins use `ctx.storage`
  (per-plugin KV) or `db.scoped` (a Drizzle handle confined to the
  plugin's schema prefix). Cross-cutting reads go through the typed
  `ctx.core.integrations` / `ctx.core.workspaces` / etc. surfaces (§10).
- Block core boot — if `init()` throws, the loader logs and skips that
  plugin's route registration; core continues with whatever else loaded.

> **The membrane is hygiene, not a sandbox.** `ctx.core` is a revocable
> Proxy that exposes only granted surfaces and audits attempts to reach
> beyond them via that reference. It guards against honest mistakes; it
> is **not** out-of-process isolation. A plugin that `require()`s core
> internals directly or opens its own DB pool defeats it. Trust in an
> external plugin still comes from the operator's review + approval, not
> from the membrane. See `docs/SECURITY_MODEL.md`.

---

## 2. Built-in vs external plugins

A plugin can be:

- **Built-in** — a workspace package in this repo (e.g.
  `@vonzio/plugin-slack`, `@vonzio/plugin-telegram`). Built-ins are
  trusted: they're auto-approved via the shipped
  `vonzio-plugins.builtins.json` policy, may declare the built-in-only
  `db.access` capability, and their frontend bundles unconditionally.
- **External** — an npm package in its own repository that an operator
  installs, reviews, and approves. Externals run under the full
  capability + policy regime: hash-attested, capability-gated, and
  refused if they declare a built-in-only capability or a
  root-equivalent capability combination (§5, §6).

Both halves consume the same published SDK packages and program against
the same `ctx`. The reference built-ins import the dashboard registry
under exactly the path an external would (`@vonzio/dashboard-registry/api`),
so the public surface is dogfooded.

This guide is written for **external** plugin authors; built-in authors
follow the same contract with a few extra privileges noted inline.

---

## 3. The published SDK packages

External plugins consume these from public npm:

| Package | Use |
|---|---|
| `@vonzio/plugin-api` | The backend contract: `VonzioPlugin`, `PluginContext`, the capability list + types, `validateManifest`, the error classes. |
| `@vonzio/plugin-api/policy` | Node-only policy helpers (`hashPackageDir`, `loadPolicies`, …). Needed by tooling, not by a plugin's runtime. |
| `@vonzio/plugin-api/frontend` | The `PluginFrontendEntry` type for a plugin's `frontend.tsx`. |
| `@vonzio/dashboard-registry/api` | The frontend slot API a plugin's `frontend.tsx` calls — `registerIntegrationRow`, `registerSettingsSection`, `registerWorkspaceHeaderSlot`, … plus the slot prop types. `react` + `lucide-react` are peer deps. |
| `@vonzio/shared` | Shared types (`Profile`, `Workspace`, `ResolvedProfile`, …) referenced by the contract. Installed transitively. |

```bash
npm install @vonzio/plugin-api                              # backend-only plugin
npm install @vonzio/dashboard-registry react lucide-react   # + a dashboard frontend
```

> The frontend slot API lives at `@vonzio/dashboard-registry/api`. (The
> dashboard re-exports the same source internally under
> `@vonzio/dashboard/registry`, but plugins import the published
> `@vonzio/dashboard-registry/api` path.)

---

## 4. The manifest (`vonzio` block)

The loader reads + strictly validates the `vonzio` block in your
`package.json` **before importing any plugin code** (unknown keys are
rejected):

```jsonc
// package.json
"vonzio": {
  "apiVersion": "1.1",
  "backendEntry": "./dist/index.js",
  "frontendEntry": "./dist/frontend.js",   // optional
  "capabilities": ["storage.kv", "notifications.channel", "http.outbound"],
  "outboundHosts": ["api.example.com"],    // required iff http.outbound declared
  "schemaPrefix": "myplugin",              // required iff db.scoped/db.access declared
  "mtlsSecrets": ["myplugin-client"],      // required iff secrets.mtls declared
  "routePrefix": { "kind": "auto" }        // optional, defaults to auto
}
```

Fields:

| Field | Meaning |
|---|---|
| `apiVersion` | The `@vonzio/plugin-api` semver this plugin targets. The loader refuses unless `plugin.major === core.major && plugin.minor <= core.minor`. Core currently ships `1.1.0`. |
| `backendEntry` | Path to the backend bundle, relative to the package root. Must be a real file inside the package and must resolve to the package's own resolved entry point. |
| `frontendEntry` | Path to the frontend bundle. Optional. Built-ins bundle it unconditionally; externals only when the operator approved the frontend (§17). |
| `capabilities` | Declared capabilities (§5). Each must be a known `PluginCapability`. |
| `outboundHosts` | Hostname patterns the plugin may reach via `ctx.http`. Required + non-empty iff `http.outbound` is declared. Hostnames only — schemes/ports/paths/userinfo are rejected; a single-label `*` glob is allowed (`*.example.com`). |
| `schemaPrefix` | DB-safe identifier (`^[a-z][a-z0-9_]{1,30}$`). Required iff `db.scoped` or `db.access` is declared. Scopes the plugin's tables. |
| `mtlsSecrets` | Logical mTLS client-cert names the plugin needs (e.g. `["myplugin-client"]`). Required + non-empty iff `secrets.mtls` is declared. The operator maps each to host file paths in policy (§11). |
| `routePrefix` | Route-mounting strategy. `{ kind: "auto" }` (default) mounts the plugin's routes under a real Fastify child scope at `/plugins/<name>`. `{ kind: "absolute", prefix }` is the escape hatch for plugins with externally-registered URLs (Slack OAuth callback, Telegram webhook) — `prefix` may be a string or array. |

### `routePrefix` is real, not informational

With `{ kind: "auto" }`, the loader registers your routes on a Fastify
child scope prefixed with `/plugins/<name>`, so `ctx.server.get("/health")`
is served at `/plugins/myplugin/health`. You own the relative URL space
inside that prefix.

With `{ kind: "absolute", prefix }`, the child scope has **no** prefix —
you use full legacy paths as before — but the loader enforces that every
route you register sits under one of your declared prefixes, and external
absolute prefixes are deny-list-checked against the reserved namespaces
(`/v1/auth`, `/v1/admin`, `/v1/orgs`, `/health`, `/metrics`, `/assets`,
`/api`). A prefix that overlaps a reserved namespace refuses the plugin
at load.

The runtime export also carries an optional `routePrefix` of the same
shape; keep it consistent with the manifest.

---

## 5. Capabilities

A plugin declares the capabilities it needs in `manifest.capabilities`.
At runtime the loader assembles `ctx` so that **only granted surfaces are
present** — every other surface is a throwing stub. Granted = the
plugin's declared set ∩ what the operator approved. Touching an undeclared
or ungranted surface throws `CapabilityViolationError` and is audited.

The full list (the runtime `PLUGIN_CAPABILITIES` tuple is authoritative):

| Capability | Unlocks |
|---|---|
| `storage.kv` | `ctx.storage` — per-plugin namespaced key/value store (preferred for new plugins). |
| `db.scoped` | `ctx.core.db` — a Drizzle handle confined to your `schemaPrefix` tables; raw SQL refused. Externals must also be opted in via `VONZIO_ALLOW_SCOPED_DB_PLUGINS=1`. |
| `db.access` | `ctx.core.db` — unscoped Drizzle handle + raw SQL. **Built-ins only.** |
| `encryption.encrypt` | `ctx.core.encryption.encrypt`. |
| `encryption.decrypt` | `ctx.core.encryption.decrypt`. |
| `integrations.read.masked` | `ctx.core.integrations` reads with secrets **masked** (`opts.decrypt` clamped to false). |
| `integrations.read.decrypted` | `ctx.core.integrations` reads with secrets **decrypted** (highest-risk read). |
| `integrations.write` | `ctx.core.integrations.{create,update,delete}`. |
| `profiles.read` | `ctx.core.profiles` (narrow `list`/`get`). |
| `profiles.resolve` | `ctx.core.profileResolver.getResolved` (full `ResolvedProfile`). |
| `workspaces.read` | `ctx.core.workspaces.{get,list}`. |
| `workspaces.write` | `ctx.core.workspaces.update`. |
| `auth.gate` | `ctx.core.authHook` — opt route scopes into the user-auth hook. |
| `presence.register` | `ctx.core.sessionPresence.register`. |
| `tasks.submit` | `ctx.core.tasks.submit`. |
| `sessions.register` | `ctx.core.sessionLifecycle.register`. |
| `sessions.extend` | `ctx.core.sessionLifecycle.extendExpiry`. |
| `sessions.setStatus` | `ctx.core.sessionLifecycle.setStatus`. |
| `sessions.getConnectedIds` | `ctx.core.sessionLifecycle.getConnectedSessionIds`. |
| `orchestrator.wake` | `ctx.core.orchestrator.wakeWorkspaceContainer`. |
| `events.append` | `ctx.core.eventLog.append`. |
| `events.read` | `ctx.core.eventLog.read`. |
| `events.subscribe` | `ctx.sessionEvents` — subscribe to orchestrator session events. |
| `dashboard.push` | `ctx.core.connectionManager` — push to dashboard WS clients. |
| `images.rewrite` | `ctx.core.imageRewriter` — strip inline images from agent output. |
| `models.list` | `ctx.core.modelList` — list models available to a profile. |
| `notifications.channel` | `ctx.notificationBus` — claim a notification kind. |
| `mcp.register` | `ctx.mcpRegistry` + `ctx.mcpSessions` — contribute an MCP server. |
| `scheduler.run` | `ctx.scheduler` — cron + interval jobs. |
| `http.outbound` | `ctx.http` — audited outbound HTTP. Requires `manifest.outboundHosts` populated. |
| `secrets.mtls` | `ctx.secrets` — resolve operator-provisioned mTLS client certs into opaque refs. Requires `manifest.mtlsSecrets` populated. |

### External-plugin restrictions

- **`db.access` is built-in only.** An external declaring it is refused.
- **Root-equivalent combinations are refused** for externals. v1 refuses
  `integrations.read.decrypted` + `db.scoped` and
  `integrations.read.decrypted` + `db.access` — reading decrypted
  secrets while holding a writable scoped DB handle is effectively root.
  Reshape the plugin to request less; there's no override.
- **`db.scoped` is opt-in** for externals: the operator must set
  `VONZIO_ALLOW_SCOPED_DB_PLUGINS=1`. Prefer `storage.kv` (§10).
- **`secrets.mtls` is *not* a refused combination** even alongside
  `integrations.read.decrypted`: the cert/key bytes are
  operator-provisioned host files that resolve to an opaque ref the
  plugin can't read, so it can't exfiltrate the key.

Keep your capability set minimal. It's the audit signal an operator
reviews — a three-capability manifest tells them exactly what the plugin
can reach.

---

## 6. Operator policy + the approve flow

External plugins are governed by the operator policy file
**`vonzio-plugins.json`** (built-ins ship in `vonzio-plugins.builtins.json`,
which is auto-trusted). One entry per package records what the operator
approved:

```jsonc
// vonzio-plugins.json
{
  "policy_version": "1",
  "plugins": {
    "@vonzio/plugin-myplugin": {
      "version": "1.0.0",
      "approved_hash_sha256": "…",          // SHA-256 of the package dir at approval
      "approved_capabilities": ["storage.kv", "http.outbound"],
      "approved_outbound_hosts": ["api.example.com"],
      "approved_frontend": false,            // gate for bundling the plugin's frontend
      "mtls_secrets": {                      // host PEM paths per declared mtls name
        "myplugin-client": { "cert": "/run/secrets/cert.pem", "key": "/run/secrets/key.pem" }
      },
      "approved_at": "…",
      "approved_by": "…",
      "approval_reason": "…"
    }
  }
}
```

At load, the loader cross-checks: the installed package hash must match
`approved_hash_sha256`, `manifest.capabilities` must be a subset of
`approved_capabilities`, `manifest.outboundHosts` a subset of
`approved_outbound_hosts`, and every `manifest.mtlsSecrets` name must
have a `mtls_secrets` entry. A drift (new capability, new host, changed
hash, version mismatch) refuses the plugin until re-approval.

### The approve flow

Don't hand-edit `vonzio-plugins.json`. Use the CLI:

```bash
vonzio plugin approve @vonzio/plugin-myplugin
vonzio plugin approve @vonzio/plugin-myplugin --frontend   # also grant the frontend
vonzio plugin diff    @vonzio/plugin-myplugin              # what changed since approval
vonzio plugin list                                         # dry-run validate VONZIO_PLUGINS
```

In this repo the CLI is wrapped as `make plugin ARGS="approve @vonzio/plugin-myplugin"`.

`approve` inspects the installed package, prints its version, hash,
capabilities, outbound hosts, and frontend status (plus a diff against
any prior approval), prompts for confirmation, then writes the policy
entry. It **refuses** to approve a built-in-only capability or a
root-equivalent combination — the same rules the loader enforces at boot,
applied at approval time. Because approval pins the package hash, any
change to the installed package requires re-approval.

After approving: add the package to `VONZIO_PLUGINS` and restart.

---

## 7. Lifecycle

```
boot
 │
 ├─ core resolves VONZIO_PLUGINS env list ("@vonzio/plugin-foo,@vonzio/plugin-bar")
 │
 ├─ for each plugin in order (MANIFEST-BEFORE-IMPORT — no plugin code runs yet):
 │   ├─ resolve package root, read + validate the `vonzio` manifest
 │   ├─ check apiVersion compatibility
 │   ├─ classify builtin vs external; apply external-only capability rules
 │   ├─ resolve backendEntry/frontendEntry (must stay inside the package)
 │   ├─ hash the package dir + cross-check the operator policy
 │   ├─ (secrets.mtls) load operator-provisioned cert/key bytes into core memory
 │   │
 │   ├─ dynamic import the package, validate the default export shape
 │   ├─ run plugin migrations (prefix-checked for db.scoped)
 │   ├─ parse config from process.env via configSchema
 │   ├─ build the capability-gated PluginContext
 │   └─ register routes on a per-plugin Fastify child scope, calling init(ctx)
 │
 ├─ server.listen()
 │
 └─ on shutdown:
     └─ teardown() for each loaded plugin (best-effort)
```

`init()` runs **once at boot**, inside the plugin's Fastify child scope,
before the server starts handling traffic. It must not block on external
services (no API roundtrips to a third party — a flaky upstream would
stall startup). For boot-time-but-async work (registering a webhook with
an upstream, refreshing a cached menu), kick it off with `void someInit()`
and let it complete in the background.

Route registration happens during `init`. That child-scope callback is
the only place you can register new Fastify routes; doing it later (e.g.
in a `setTimeout`) throws "Root plugin has already booted".

If your `init()` throws, the loader logs it and that plugin's routes
simply don't register — boot continues for the rest. Migration failures,
by contrast, **do** propagate: a half-migrated schema is worse than a
failed boot.

---

## 8. `PluginContext` — what `init()` receives

```ts
interface PluginContext<TConfig = unknown> {
  server: FastifyInstance;          // per-plugin Fastify child scope
  config: TConfig;                  // parsed from process.env via configSchema
  log: PluginLogger;                // pino child, pre-tagged with { plugin: name }
  core: PluginCore;                 // capability membrane over core services (§9)
  storage: PluginStorageKv;         // storage.kv          (§10)
  http: PluginHttp;                 // http.outbound       (§11)
  secrets: PluginSecrets;           // secrets.mtls        (§11)
  notificationBus: NotificationBus; // notifications.channel (§12)
  mcpRegistry: McpRegistry;         // mcp.register        (§15)
  mcpSessions: McpSessions;         // mcp.register        (§15)
  scheduler: Scheduler;             // scheduler.run
  sessionEvents: SessionEvents;     // events.subscribe    (§14)
}
```

Every field except `server`, `config`, and `log` is gated by a
capability. When a capability isn't granted, that field is a throwing
stub: accessing it raises `CapabilityViolationError`.

### `ctx.server`

A per-plugin Fastify child scope. Register routes the way Fastify
expects; with the default `auto` prefix they're mounted under
`/plugins/<name>` (§4):

```ts
ctx.server.get("/health", async () => ({ ok: true }));   // -> /plugins/myplugin/health

// or via a fastify-plugin module:
await ctx.server.register(myRoutes, { /* opts */ });
```

### `ctx.config`

Whatever your Zod schema parses out of `process.env`. Plugins should
namespace their env vars (`MYPLUGIN_API_KEY`, not `API_KEY`) to avoid
collisions. `process.env` values are strings, so coerce in the schema:

```ts
const configSchema = z.object({
  MYPLUGIN_PORT: z.coerce.number().default(8080),
  MYPLUGIN_DEBUG: z.coerce.boolean().default(false),
});
```

`configSchema` is typed structurally (anything with a `.parse()`), so a
zod v3 or v4 schema both work and your `TConfig` flows from the parse
result.

### `ctx.log`

Pino logger, pre-tagged with `{ plugin: "<name>" }`:

```ts
ctx.log.info({ count: 3 }, "processed events");
ctx.log.warn("retrying connection");
ctx.log.error({ err }, "send failed");
```

Don't log decrypted secrets or PII-bearing payloads without redaction.

---

## 9. `ctx.core` — capability-gated core services

`ctx.core` is a capability membrane: a revocable Proxy assembled
method-by-method from your granted capabilities. Surfaces you didn't
declare aren't there, and reaching for them throws + audits. The current
surface, with the capability each field requires:

| Field | Capability | Use |
|---|---|---|
| `db` | `db.scoped` / `db.access` | Drizzle handle (scoped or raw) for plugin-owned tables (§10). |
| `encryption` | `encryption.encrypt` / `.decrypt` | AES-256-GCM via the master vault key. |
| `integrations` | `integrations.read.*` / `.write` | Read + mutate `user_integrations` rows. |
| `profiles` | `profiles.read` | Read agent profiles by id/user. |
| `profileResolver` | `profiles.resolve` | Get full `ResolvedProfile` (env, tools, claude_md, …). |
| `workspaces` | `workspaces.read` / `.write` | Read/list/update `workspaces` rows. |
| `tasks` | `tasks.submit` | Submit new tasks (chat surfaces use this for inbound). |
| `sessionLifecycle` | `sessions.*` | Create/extend/status-change sessions. |
| `orchestrator` | `orchestrator.wake` | `wakeWorkspaceContainer(sessionId, profile)`. |
| `eventLog` | `events.append` / `.read` | Append + read session timeline. |
| `connectionManager` | `dashboard.push` | Push events to dashboard WS clients. |
| `imageRewriter` | `images.rewrite` | Strip inline images, get signed URLs. |
| `modelList` | `models.list` | List models available to a profile. |
| `sessionPresence` | `presence.register` | Register a chat-surface presence provider (§13). |
| `authHook` | `auth.gate` | Opt route scopes into the user-auth hook. |

### `ctx.core.encryption`

```ts
const encrypted = ctx.core.encryption.encrypt(JSON.stringify({ token: "..." }));
// later:
const decrypted = JSON.parse(ctx.core.encryption.decrypt(encrypted));
```

Use it for any secret that lands in your DB (OAuth tokens, API keys).
The key lives in `ENCRYPTION_KEY` on the core side; plugins never see it.

### `ctx.core.integrations`

Manage rows in `user_integrations`. Read methods honour your read
capability — with `integrations.read.masked` the `opts.decrypt` flag is
clamped to false; `integrations.read.decrypted` returns plaintext config:

```ts
// Read (decrypt available only with integrations.read.decrypted)
await ctx.core.integrations.getByUserAndType(userId, "myplugin", { decrypt: true });
await ctx.core.integrations.listByUserAndType(userId, "myplugin");
await ctx.core.integrations.findByTypeAndExternalId("myplugin", externalId);

// Create / update / delete (integrations.write)
await ctx.core.integrations.create(userId, "myplugin", { token: "..." });
await ctx.core.integrations.update(id, { config: ..., enabled: false });
await ctx.core.integrations.delete(id);
```

Notes:
- `config` is stored encrypted by core; pass plaintext in, request
  `{ decrypt: true }` to get it back (with the decrypted read cap).
- `update(id, ..., { expectUpdatedAt })` is a compare-and-swap for
  race-safe pairing flows (e.g. telegram's `/link <code>`): the loser
  sees a null return and refuses without echoing "Linked."
- The row's `type` is the discriminator. Pick a stable short string
  (`"telegram"`, `"slack"`, `"github"`) and use it consistently.
- Each row carries `scope` (`"all" | "agents"`) and `profile_ids`. To
  honour the user's per-profile visibility when surfacing a row to an
  agent (e.g. an MCP tool), filter with
  `scope === "all" || profile_ids.includes(profileId)` — where
  `profileId` comes from `ctx.mcpSessions.resolve(token)` (§15).

---

## 10. Data access: storage vs scoped DB

New plugins should reach for **`ctx.storage`** (the `storage.kv`
capability) before a DB handle. It's a per-plugin namespaced key/value
store backed by a core-owned table; every read/write is filtered
server-side by your plugin id, so one plugin has no API path to another's
keys. No migrations, no schema to own.

```ts
// gated by storage.kv
await ctx.storage.set("config:v1", { webhookUrl: "...", retries: 3 });
const cfg = await ctx.storage.get<{ webhookUrl: string }>("config:v1");
await ctx.storage.delete("config:v1");
const all = await ctx.storage.list("config:");   // optional key prefix
```

Values round-trip as parsed JS objects (stored as JSONB).

### When you need a real DB handle: `db.scoped`

If you need relational queries, indexes, or joins, declare `db.scoped`
and a `schemaPrefix`. The loader hands you a Drizzle handle wrapped so
that:

- every table reference in `.from` / `.insert` / `.update` / `.delete` /
  joins must be a table whose name starts with `<schemaPrefix>_` (or
  lives in a Postgres schema named the prefix) — an out-of-scope table
  throws `DbScopeViolationError`;
- raw SQL escape hatches (`.execute`, `.transaction`, `.$client`) are
  refused outright;
- your migrations are prefix-checked: every DDL object must be under your
  prefix, and dynamic SQL (`DO`/`EXECUTE`) is rejected.

```ts
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { myThing } from "./db/schema.js";  // pgTable("myplugin_things", ...)

const db = ctx.core.db as NodePgDatabase<Record<string, never>>;
await db.insert(myThing).values({ ... });
```

External plugins must additionally be opted in with
`VONZIO_ALLOW_SCOPED_DB_PLUGINS=1`. Built-ins can declare `db.access` for
an unscoped raw handle, but externals cannot.

> The scoped-DB wrapper catches honest mistakes (a builder pointed at the
> wrong table) and makes cross-schema attempts visible. It is not a
> containment boundary — a plugin that opens its own pool from
> `DATABASE_URL` bypasses it. Treat it as hygiene, not enforcement.

For cross-cutting data you don't own (a user's integrations, their
workspaces, their profiles), don't query the tables — use the typed
`ctx.core.integrations` / `ctx.core.workspaces` / `ctx.core.profiles`
surfaces (§9), which carry their own capabilities.

---

## 11. Outbound HTTP + mTLS secrets

### `ctx.http` — audited outbound HTTP

Declare `http.outbound` and a non-empty `outboundHosts`, and you get
`ctx.http.fetch`. Every call resolves the hostname, blocks SSRF targets
(private/link-local IPs, DNS-rebinding), requires the host to match your
`outboundHosts` ∩ the operator's approved hosts, and is logged. Use it
instead of the global `fetch` — raw `fetch` is flagged by the loader's
best-effort anomaly detector (and the no-raw-fetch lint).

```ts
// manifest: "capabilities": ["http.outbound"], "outboundHosts": ["api.example.com"]
const res = await ctx.http.fetch("https://api.example.com/accounts", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ... }),
  timeoutMs: 5000,            // capped at 30s
});
const data = await res.json();
```

`fetch` returns a real WHATWG `Response`, so `.json()` / `.ok` /
`.text()` / `.arrayBuffer()` all work — binary downloads via
`.arrayBuffer()` are byte-preserved. Per-call ceilings: 30s timeout,
5 MiB response.

### `ctx.secrets` — mTLS client certs

If an upstream requires a client certificate (mutual TLS — e.g. a banking
API), you never handle the private key yourself. Declare `secrets.mtls`
and the logical cert names; the operator provisions the PEM files in
policy:

```jsonc
// package.json "vonzio" block
"capabilities": ["http.outbound", "secrets.mtls"],
"outboundHosts": ["api.example.com"],
"mtlsSecrets": ["example-client"]
```

```ts
const ref = ctx.secrets.mtls("example-client");        // opaque — no bytes
const res = await ctx.http.fetch("https://api.example.com/accounts", { mtls: ref });
```

The operator maps each name to host files in `vonzio-plugins.json`:

```jsonc
"mtls_secrets": {
  "example-client": { "cert": "/run/secrets/cert.pem", "key": "/run/secrets/key.pem", "ca": "...", "passphraseEnv": "..." }
}
```

Core reads the PEMs at load time and presents the cert server-side at
request time; your code only ever holds the opaque ref (`ctx.secrets.mtls`
mints a frozen, branded handle carrying just the logical name). A name
you didn't declare — or the operator didn't provision — throws
`CapabilityViolationError`. A declared-but-unreadable cert/key refuses
the plugin at boot rather than silently disabling its mTLS calls.

---

## 12. Notification bus

Core dispatches outbound notifications (playbook completion, ask-user
fallback) by `kind`. With `notifications.channel`, a plugin claims a kind
and handles the send:

```ts
import type { NotificationHandler } from "@vonzio/plugin-api";

const handler: NotificationHandler = async (req) => {
  // req.kind === "myplugin"; req.recipient is typically the integration id
  // req.text is the body; req.metadata is per-message metadata
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
- `{ ok: true }` — success.
- `{ ok: false, error, retryable }` — `retryable: true` for rate
  limits / transient network errors; `false` for invalid config /
  missing integration.

One handler per kind, registered once. Re-registering a kind throws
(caught at boot). Handlers must never throw — wrap unexpected errors into
`{ ok: false, retryable }`.

---

## 13. Session presence

The orchestrator needs to know whether a session is reachable on a chat
surface (to decide whether `AskUserQuestion` will hang, and to inform the
agent in the system prompt). With `presence.register`, each chat plugin
registers a presence provider:

```ts
ctx.core.sessionPresence.register({
  surface: "myplugin",  // stable key; registering two for the same key throws
  metadata: {
    label: "MyPlugin (slow surface — phone-typing latency)",
    slow: true,         // triggers the agent's "phrase as 2-4 button options" steer
  },
  async hasSession(sessionId) {
    // Is this session bound to a chat thread on my surface?
    const rows = await db.select(/* ... */);
    return rows.length > 0;
  },
  // Optional methods (the registry tolerates partial providers):
  async hasOwnerSurface(userId) {
    // Will my surface deliver to this user's account-wide channel
    // (e.g. a DM bot) regardless of session binding?
    return userHasLinkedBot(userId);
  },
  async resolveUserIdBySession(sessionId) {
    // Fallback: find user_id by walking my chat-binding table when the
    // in-memory registry doesn't have the session yet.
    return rows[0]?.user_id ?? null;
  },
  async listEngagedSessionIds() {
    // Session ids the user actively engaged on my surface (e.g. claimed a
    // playbook thread). Keeps them visible in the workspace list.
    return new Set(rows.map((r) => r.session_id));
  },
});
```

`hasSession` is required; the rest are optional. Core treats missing
methods (and provider errors) as "doesn't apply" — a flaky provider can't
block a task.

---

## 14. Session events

With `events.subscribe`, subscribe to five orchestrator events:

```ts
ctx.sessionEvents.on("task:token",    (taskId, sessionId, text) => {...});
ctx.sessionEvents.on("task:tool_use", (taskId, sessionId, tool, input?) => {...});
ctx.sessionEvents.on("task:ask_user", (taskId, sessionId, input) => {...});
ctx.sessionEvents.on("task:done",     (taskId, sessionId, result?) => {...});
ctx.sessionEvents.on("task:failed",   (taskId, sessionId, error?) => {...});
```

Use these to relay agent activity to a chat surface — streaming tokens,
posting final results, surfacing ask_user prompts.

Handlers fire in parallel and are not awaited by core; if you need
ordering, queue inside your handler. `sessionId` may be `undefined` for
tasks not bound to a session (one-off API calls) — early-return in that
case. Core calls `off()` for your handlers during teardown so a reloaded
plugin doesn't double-subscribe.

---

## 15. MCP servers

With `mcp.register`, contribute an MCP server agents can use:

```ts
ctx.mcpRegistry.registerServer({
  name: "myplugin",
  transport: { type: "http", url: "/plugins/myplugin/mcp" },
  // or: { type: "stdio", command: "...", args: [...], env: {...} }
});
```

For an `http` transport, `url` **must be an absolute path** — the plugin
serves the MCP route via `ctx.server`, and core resolves the path against
its internal server URL at injection time. External / protocol-relative /
traversing URLs are refused at `registerServer`, because core attaches a
per-task bearer token that must never leave the deployment.

When core injects your server into an agent container, it mints a
per-task token and adds the `Authorization: Bearer <token>` header
itself. Your MCP route resolves it via `ctx.mcpSessions` (also gated by
`mcp.register`):

```ts
const id = ctx.mcpSessions.resolve(token);   // { userId, profileId, orgId } | null
```

Use the resolved identity to scope the call to the right user/profile/
tenant — and to filter integration rows by per-profile visibility (§9).

---

## 16. Migrations

Plugins that own Drizzle tables (`db.scoped` / `db.access`) ship
migrations. Plugins using `ctx.storage` don't need any.

Layout:

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

Wire it onto the plugin export via `migrations: myPluginMigrations`.

The loader tracks applied migrations in `_migrations` keyed by
`<plugin-name>_<migration-name>` and applies them in declared order.
Keep them idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD
COLUMN IF NOT EXISTS`) so a partial-apply failure can be re-attempted on
next boot without leaving the schema half-built. Naming convention:
`NNNN_short_description` (`0001_initial_schema`, `0002_add_thread_label`).

For `db.scoped` plugins, every DDL object name must start with your
`schemaPrefix` (`myplugin_…`), and `DO`/`EXECUTE` dynamic SQL is rejected
at load — a static lexer can't verify what dynamic SQL would create.

---

## 17. Frontend slots

The dashboard exposes registry slots. A plugin contributes by
default-exporting a `PluginFrontendEntry` (a `() => void`) from
`frontend.tsx`:

```tsx
// src/frontend.tsx
import type { PluginFrontendEntry } from "@vonzio/plugin-api/frontend";
import {
  registerIntegrationRow,
  registerWorkspaceHeaderSlot,
  // ...
} from "@vonzio/dashboard-registry/api";
import { MyPluginRow } from "./dashboard/MyPluginRow.js";

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

`react` + `lucide-react` are peer deps of `@vonzio/dashboard-registry`.

### Frontend bundling requires operator approval

A plugin's frontend is bundled into the dashboard **only when the
operator approved it** (`approved_frontend: true`, set via
`vonzio plugin approve --frontend`). Built-ins are auto-approved.
The dashboard's build-time Vite plugin reads
`vonzio-plugins.builtins.json` + the operator's `vonzio-plugins.json`
and bundles a plugin's frontend only if its policy entry approves it;
the bundled set is recorded so the server can verify build↔runtime parity
at boot.

Frontend code runs in the dashboard origin with full DOM, `localStorage`,
cookie, and credentialed-fetch access — approving it is a real trust
grant; v1 has no DOM sandbox. The dashboard ships a strict CSP
(`script-src 'nonce-<per-request>' 'strict-dynamic'`, no `'self'`), so
**bundling is the only path code reaches the dashboard origin**: a script
served from a plugin's Fastify route (or injected via XSS) lacks the
per-request nonce and the browser refuses it. See
`docs/SECURITY_MODEL.md`.

### Available slots

| Slot | Use | Receives |
|---|---|---|
| `registerRoute` | Top-level route | `{ id, path, element, layout? }` |
| `registerNavItem` | Sidebar entry | `{ id, section, label, to, icon, ... }` |
| `registerSettingsSection` | Settings tab | `{ id, label, lede?, component, order? }` |
| `registerTopbarSlot` | Topbar control | `{ id, placement, component, order? }` |
| `registerWorkspaceHeaderSlot` | Workspace chat header button | `{ id, component, order? }` — receives `{ workspace }` |
| `registerComposerSlot` | Composer meta line | `{ id, component, order? }` — receives `{ workspaceId, profileId, attachedTunnel? }` |
| `registerIntegrationRow` | Row in Settings > Integrations | `{ id, component, section, order? }` — receives `IntegrationRowSlotProps` |
| `registerOnboardingStep` | First-run flow step | `{ id, component, predicate?, order? }` |
| `registerUserMenuItem` | Avatar dropdown | `{ id, label, to?, onClick?, ... }` |

### Slot guidance — sparse vs rich plugins

Two patterns established by the reference plugins:

- **Sparse**: just a row. Plugin contributes via `registerIntegrationRow`
  with inline actions (Connect, Disconnect). Example: slack (one OAuth
  button).
- **Rich**: row + drawer. The row opens a Modal containing a full
  settings UI when the user clicks Manage. Example: telegram (bot list,
  QR codes, multi-bot management).

Both use the same `registerIntegrationRow` slot — the difference is
content density inside the component.

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

Find your row by `integrations.find(i => i.type === "myplugin")`. The
plugin owns its own data fetching for plugin-specific endpoints.

### Plugin frontend API client

If your plugin makes dashboard-side calls to its own `/plugins/myplugin/*`
routes, ship a small `request()` helper in `dashboard/api.ts` (~30 LOC).
The dashboard's internal client isn't a public export, and keeping it
private avoids coupling every plugin to dashboard internals. See
`packages/plugins/telegram/src/dashboard/api.ts` and slack's equivalent;
a minimal version appears in §20.

---

## 18. Walkthrough: telegram (full-stack chat plugin)

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
    telegram-service.ts        # Bot API client
    platform-bot-service.ts    # platform-hosted bot (env-driven)
  dashboard/
    api.ts                       # plugin's frontend HTTP client
    TelegramIntegrationRow.tsx   # row + drawer
    TelegramSettings.tsx         # drawer content (bot list, QR, modal)
    WorkspaceHeaderTelegramButton.tsx
```

### `init()` highlights

```ts
async init(ctx) {
  const telegramService = new TelegramService();
  const platformBotService = new PlatformBotService(ctx.config, telegramService, ctx.log);
  void platformBotService.init();    // fire-and-forget setWebhook

  // Auth-gated routes inside an explicit child scope (fp() leak prevention, §20)
  await ctx.server.register(async (oauthScope) => {
    await oauthScope.register(telegramSetupRoutes, {
      /* ...ctx.core surfaces... */,
      authHook: ctx.core.authHook,
    });
  });

  // Public webhook route + 5 task:* subscriptions
  await ctx.server.register(telegramEventsRoutes, {
    db: ctx.core.db as NodePgDatabase</* ... */>,
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
  void resyncTelegramBotCommands({ /* ... */ });
}
```

The plugin owns three `telegram_*` tables; claims the `telegram`
notification kind, the `telegram` presence surface, the Telegram webhook
route, and the `/v1/integrations/telegram/*` setup routes; and
contributes a dashboard row + drawer plus a workspace header button. (As
a built-in it uses an absolute `routePrefix` to keep its externally
registered webhook + setup URLs.)

---

## 19. Walkthrough: slack (OAuth-based notify channel)

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

- **OAuth** instead of token-paste. The Slack callback decrypts the
  state, exchanges code for `bot_token`, creates the `user_integrations`
  row.
- **Slash commands** + **events** share `/api/slack/events`.
- **No rich UI** — `SlackIntegrationRow` is the entire dashboard surface.
- The OAuth path uses the `fp()` child-scope wrap (§20) because it adds
  an auth hook at the top of its route module.

---

## 20. Common patterns

### Auth scoping for fastify-plugins

`fastify-plugin` (`fp()`) intentionally un-encapsulates so a registered
plugin can decorate the parent server. If your fp'd plugin calls
`server.addHook("onRequest", authHook)`, the hook lifts to the parent —
and any route registered on the parent **after** your fp inherits that
auth check, which can wrongly reject public webhook requests.

The fix: wrap the auth-gated registration in an explicit child scope so
`fp()` only lifts to that scope, not the root server:

```ts
// In init():
await ctx.server.register(async (authedScope) => {
  await authedScope.register(myAuthedRoutes, { authHook: ctx.core.authHook });
});

// Public routes register on ctx.server directly — outside the wrapping scope.
await ctx.server.register(myPublicRoutes, { /* ... */ });
```

Inside `myAuthedRoutes` (which is `fp()`'d),
`server.addHook("onRequest", authHook)` now lifts to `authedScope`, not
root. The public routes stay unauthed.

### Dashboard `request()` helper

The dashboard's internal `request()` helper isn't a public export.
Ship ~30 LOC of your own in `dashboard/api.ts`:

```ts
const BASE = "/v1";
const ORG_ID_STORAGE_KEY = "vonzio_current_org_id";

function readCurrentOrgId() {
  if (typeof localStorage === "undefined") return null;
  try { return localStorage.getItem(ORG_ID_STORAGE_KEY); }
  catch { return null; }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(options.headers as Record<string, string>) };
  if (options.body) headers["Content-Type"] = "application/json";
  const orgId = readCurrentOrgId();
  if (orgId) headers["X-Org-Id"] = orgId;
  const res = await fetch(`${BASE}${path}`, { ...options, credentials: "include", headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? "Request failed");
  }
  return res.json();
}
```

### Webhook dedup for at-least-once delivery

Chat-surface webhooks redeliver on retry. Without dedup, every retry
spawns a duplicate reply:

```ts
const seenUpdateIds = new Set<number>();
const DEDUP_TTL_MS = 5 * 60 * 1000;
function remember(updateId: number) {
  seenUpdateIds.add(updateId);
  setTimeout(() => seenUpdateIds.delete(updateId), DEDUP_TTL_MS).unref?.();
}

// In the webhook handler, AFTER the 200 ACK:
if (seenUpdateIds.has(update.update_id)) {
  request.log.info({ updateId: update.update_id }, "skipping duplicate");
  return;
}
remember(update.update_id);
```

Bounded by TTL; trivial memory cost.

### Boot failures

If your `init()` throws, the loader logs and continues without your
routes. So:

- Don't throw on a disabled feature — return early with a `log.warn`.
- Make migration errors meaningful — migration failures **do** propagate
  (better to fail boot than run with a half-migrated schema).

---

## 21. Testing

### Unit tests

Plugins ship Vitest. Run with `npm test --workspace=packages/plugins/myplugin`.

For services that take a `PluginContext`, mock the surfaces you use:

```ts
const ctx = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  storage: { get: vi.fn(), set: vi.fn() },
  core: {
    integrations: {
      get: vi.fn().mockResolvedValue({ id: "i1", user_id: "u1", config: {} }),
    },
    // ... only what you need
  },
} as unknown as PluginContext;
```

### Integration tests with the real backend

For end-to-end webhook tests, the smoke-test setup in
`scripts/start-dev.sh` boots the full stack. For automated CI, spin up
Postgres + a fake-provider mock server.

The loader's own gate behavior (membrane, scoped DB, outbound HTTP,
policy cross-check) is covered by the attack corpus at
`packages/core-server/src/plugins/attack-corpus.test.ts`, which drives
the real gate functions against deliberately-malformed plugins in
`examples/plugin-hello-attacks/`.

---

## 22. Publishing & loading

### Local development (built-in)

Add your plugin to `package.json` workspaces and to the `core-server` +
`dashboard` deps (`{ "@vonzio/plugin-myplugin": "*" }`), then list it in
`VONZIO_PLUGINS`:

```yaml
# docker-compose.dev.yml
- VONZIO_PLUGINS=${VONZIO_PLUGINS:-@vonzio/plugin-telegram,@vonzio/plugin-slack,@vonzio/plugin-myplugin}
```

Mount the source for hot reload:

```yaml
volumes:
  - ../packages/plugins/myplugin/src:/app/packages/plugins/myplugin/src
```

For the frontend half, register it in
`packages/dashboard/src/plugins.ts`:

```ts
import myPluginRegister from "@vonzio/plugin-myplugin/frontend";
const plugins: PluginEntry[] = [
  // ...
  { name: "myplugin", register: myPluginRegister },
];
```

### Installing + approving an external plugin

On the operator's host:

1. `npm install @vonzio/plugin-myplugin`
2. Add it to `VONZIO_PLUGINS`.
3. `vonzio plugin approve @vonzio/plugin-myplugin` (add `--frontend` to
   grant the dashboard frontend). This pins the package hash + the
   approved capabilities/hosts into `vonzio-plugins.json` (§6).
4. Restart. Any later change to the installed package requires
   re-approval (the hash won't match).

`vonzio plugin list` dry-runs the loader validation against
`VONZIO_PLUGINS` without importing any plugin code — handy to confirm
what a plugin would be granted.

### CI

Add a typecheck step:

```yaml
- run: npx tsc --project packages/plugins/myplugin/tsconfig.json --noEmit
```

If your frontend imports from the dashboard via its public exports, your
tsconfig may need the `@/*` path alias the dashboard uses internally:

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

## 23. When the contract changes

`@vonzio/plugin-api` is at `1.1.0`. The loader refuses a plugin unless
its `apiVersion` major equals core's and its minor is ≤ core's — so a
plugin built against `1.0` loads on `1.1` (additive), but one built
against a newer minor than core is refused. Adding a capability or a
`ctx.core` field is a minor (additive) bump; removing or renaming one is
a major bump that needs a migration guide. `1.1.0` added
`scope`/`profile_ids` to integration rows — additive, so plugins
targeting `1.0` are unaffected.

If you need a `ctx.core` surface that doesn't exist:

1. Open an issue describing the use case + the minimum shape.
2. Propose a structural type (don't bind to a concrete service class).
3. The contract gets the addition (a new capability + surface), the
   loader threads it through, and existing plugins are unaffected.

Pin your `apiVersion` to the minor you built + tested against; don't
silently drift.

---

## See also

- Reference plugins: `packages/plugins/telegram/`, `packages/plugins/slack/`
- Minimal example: `examples/plugin-hello/`
- Contract source: `packages/plugin-api/src/index.ts`,
  `packages/plugin-api/src/capabilities.ts`,
  `packages/plugin-api/src/manifest.ts`
- Loader: `packages/core-server/src/plugins/loader.ts`
- Dashboard registry: `packages/dashboard-registry/`
- Security model: `docs/SECURITY_MODEL.md`
- Hardening guide: `docs/HARDENING.md`
</content>
</invoke>
