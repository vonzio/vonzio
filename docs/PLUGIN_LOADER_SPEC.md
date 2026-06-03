# External plugin loader — specification

Specification for the external plugin loader landing in vonzio v0.2.x.
Authority for implementation of `core-server/src/plugins/loader.ts`,
the `@vonzio/plugin-api` capability surface, and the loader's
operator-facing contract.

For the plugin-author guide (how to write a plugin), see
[PLUGINS.md](./PLUGINS.md). For the project security model in
general, see [SECURITY_MODEL.md](./SECURITY_MODEL.md). This spec is
the **loader**'s contract — what it guarantees and what it does not.

---

## 1. Why this exists

Today, vonzio's two plugins (`@vonzio/plugin-slack`,
`@vonzio/plugin-telegram`) ship as workspace packages and are
statically imported by core-server at boot. We need an additional
loading path for plugins that live **outside the OSS workspace** —
extracted built-ins (`@vonzio/plugin-gmail`, `@vonzio/plugin-teller`)
and third-party packages.

The loader is **additive**. Built-ins continue to load via their
workspace symlink. External plugins are discovered via the
`VONZIO_PLUGINS` env list at boot. Both go through the same
manifest validation, the same capability-gating membrane, and the
same audit logging — the technical pathway is uniform; the trust
framing differs by source (see §2).

---

## 2. Trust model

vonzio's plugin loader is not a sandbox. It is an
**audited trusted plugin system with capability-shaped APIs**. The
right mental model is closer to a privileged Linux daemon's config
review than to browser plugin sandboxing — the operator vets each
plugin's source code before installing it, and the loader exists to
shape that code's access into legible, auditable surfaces. The
membrane catches honest mistakes; the operator's review catches
malice.

### The structural tension worth naming

vonzio runs *agent code* in per-session Docker containers — strong
isolation because agent output is the least-trusted code in the
system. But *plugin code* runs **in-process** in core-server, the
process that holds integration secrets, the DB handle, and the
encryption keys. So our least-trusted code is sandboxed, and our
plugin code (which is far more privileged) is not. This is
defensible under the operator-reviewed-npm-package model, but an
operator who internalized "vonzio isolates everything" will be
wrong about plugins. Read [SECURITY_MODEL.md](./SECURITY_MODEL.md)
for the agent isolation story; this section is the plugin story,
and the two are different.

### Plugin code runs in-process

We do not VM-isolate, we do not worker-thread-isolate, we do not
process-isolate plugins. A plugin that wants to read your
filesystem can. A plugin that wants to spawn `bash` can. A plugin
that wants to import `node:fs` or walk `require.cache` to grab the
raw core module reference can. This is intrinsic to how Node.js
dynamic imports work, and pretending otherwise would mislead
operators.

### Trust = audit + capability shape

Installing a plugin means trusting:

1. The plugin's source code, which you reviewed.
2. **The plugin's entire transitive dependency tree**, which loads
   at `require` time with the same Node capabilities the plugin
   itself has. A malicious transitive dep (think a hijacked deep
   utility package) runs before any manifest check. This is the
   actual residual risk — supply-chain compromise, not the plugin's
   own first-party code. The operator policy hash attestation
   (§4) catches *tampering* after install but does not protect
   against *malicious-as-published* in a transitive dep.
3. **The plugin's frontend dependency tree**, if the operator
   approved `approved_frontend: true`. The dashboard build feeds
   the plugin's `frontendEntry` through Vite, which pulls in the
   plugin's own frontend deps. The policy hash covers the source
   tree fed to Vite; it does not cover Vite's bundled output (a
   compromised build host could substitute one for the other).
   Your audit should include the frontend source tree, not just
   the backend.

### Time-of-presence asymmetry

Backend plugin code runs continuously inside core-server. Frontend
plugin code runs only while an operator has the dashboard open in
a browser tab — and runs *for that operator*, not as a background
process. This changes the risk window (frontend only fires during
admin sessions, not 24/7) but not the impact (a malicious frontend
during an admin session can still steal the session). Operators
reasoning about exposure should know which surface fires when, but
the trust decision is roughly equivalent in v1.

The loader's job is to make trust-decisions legible at install
time and observable at runtime. It is not to enforce trust
against unbounded malice.

### What the loader does enforce

The loader stands between core-server and the plugin module to
enforce the following invariants — none of which require
out-of-process isolation:

1. **Manifest-before-import.** The plugin's `package.json` is read
   and validated from disk **before** `await import(packageName)` is
   called. Plugins without a valid manifest never have their entry
   point executed. This closes the "arbitrary code at import time"
   window for *rejected* plugins. Accepted plugins still execute
   their entry point with full Node access.
2. **Operator policy gate.** Beyond the plugin's manifest, an
   operator policy file (§4) declares which capabilities are
   *approved*. The manifest is the plugin author's request; the
   policy is the operator's grant. Capabilities declared in the
   manifest but absent from policy are refused at load.
3. **Capability membrane.** The plugin receives a
   `Proxy<PluginCore>` that throws on any property access outside
   declared *and approved* capabilities. See §7 for the membrane
   mechanics and its honest scope (hygiene against honest mistakes;
   not a containment boundary against in-process malice).
4. **Per-plugin Fastify scope.** Routes are registered on a child
   Fastify instance scoped to `/plugins/<name>` (or
   `routePrefix.kind === "absolute"` for legacy URLs, declared in
   manifest and logged loudly). Global decorators, content types,
   and error handlers are not reachable through the plugin's
   server reference (§8).
5. **Per-plugin DB scope.** Plugins declaring `db.scoped` receive
   a Drizzle handle wrapped to refuse cross-schema queries; raw
   SQL is **refused entirely** for `db.scoped` (`db.execute` only
   works under `db.access`, which is built-ins only). See §9 for
   the honesty about what the wrapper catches and what it does not.
6. **Outbound HTTP via `ctx.http.fetch`.** Plugins declaring
   `http.outbound` get a single wrapped fetch helper that enforces
   SSRF blocks + the manifest's per-plugin `outboundHosts`
   allowlist. Plugins not declaring `http.outbound` cannot use the
   helper. See §10.
7. **External frontends require per-plugin operator opt-in.**
   External plugins (anything discovered via `VONZIO_PLUGINS`) can
   declare `frontendEntry`, but the loader refuses load entirely
   unless the operator policy entry (§4) sets
   `approved_frontend: true`. A plugin declaring `frontendEntry`
   whose policy entry omits or sets `approved_frontend: false` is
   **refused at load** with a clear error pointing at
   `vonzio plugin approve --frontend` — silently dropping the
   frontend would leave the operator with a partially-broken
   plugin and the wrong mental model of what's running. Built-ins
   are auto-approved via the shipped builtins policy. The trust
   statement is uniform with the rest of the policy: externals
   get the trust the operator chose to grant, and granting "code
   in the dashboard origin" is a separate, visible flag in
   `vonzio-plugins.json`. Iframe isolation in v2 lifts the audit
   requirement for unaudited externals; see §15 for the trigger.
8. **Audit log.** Each plugin's load emits a structured event:
   package name, version, resolved real path, content hash, manifest
   contents (declared + approved capabilities), `outboundHosts`,
   api version, backend entry. Runtime audit events fire for every
   `ctx.http.fetch` call, every capability violation, every
   prototype mutation, and every `outboundHosts` mismatch (§11).
9. **Per-plugin error isolation.** A throw during `init()` or
   manifest validation is caught, logged, and the plugin is skipped.
   The server continues to boot.
10. **Best-effort tamper detection.** Before each plugin load the
    loader snapshots `process.env` keys and the hashes of
    `Object.prototype` / `Array.prototype` / `Function.prototype`.
    After load, mismatches are **logged loudly** but boot continues.
    A determined plugin can defeat this trivially by polluting on
    first request, after the snapshot. The detection is
    defense-in-depth against accidentally-broken transitive deps,
    not a malice control.

### What the loader does NOT enforce

These are explicitly out of v1 scope. Operators relying on plugin
trust should not assume protection here:

- Plugins can call `fs.readFile`, `fs.writeFile`, `child_process.exec`,
  raw `net.Socket`, or any other Node API. The capability list
  scopes `PluginCore` surfaces — it does **not** sandbox the Node
  runtime.
- Plugins can read `process.env` directly. The `configSchema`
  pattern (plugin receives a Zod-parsed subset as `ctx.config`)
  is a *convention* for clean code, not a sandbox.
- Plugins can `require('node:fs')` or `require('@vonzio/core-server')`
  directly — the membrane gates only the reference we hand them
  via `ctx.core`. We rely on operator review of the plugin source
  to catch this pattern at install time.
- Plugins can hold long-running CPU or block the event loop. There
  is no per-plugin resource quota.
- A plugin can DoS another plugin by exhausting shared resources.
- Plugins can mount React components into the dashboard tree —
  built-ins by default, externals only when the operator policy
  approves the plugin's frontend (see §3 + §4).

### Trust source distinction

| Source | Trust posture | Frontend allowed | DB access pattern |
|---|---|---|---|
| **Built-in** (workspace package shipped with OSS) | Maintained by the OSS project, reviewed in PRs, included in CI. Threat model = same as core-server. | Yes (auto-approved in shipped builtins policy; bundled into dashboard at OSS build time). | `db.access` permitted. |
| **External, operator-trusted** (operator installs the npm package after auditing it, declares it in `VONZIO_PLUGINS`, approves in policy file) | Same trust the operator gives any npm dependency on their server. The membrane is the runtime gate; operator audit of the package + transitive tree is the source gate. | Per-plugin opt-in. `frontendEntry` in manifest requires `policy.approved_frontend: true`; default off, CLI flow asks explicitly. v2 iframe isolation removes the "must audit frontend" requirement. | `storage.kv` (default). `db.scoped` only with `VONZIO_ALLOW_SCOPED_DB_PLUGINS=1`. `db.access` refused. |
| **External, third-party at scale** (a community marketplace, plugins the operator did not review) | **Not supported in v1.** The threat model requires process isolation we do not have. | n/a | n/a |

---

## 3. Manifest format

The manifest lives in the plugin package's `package.json` under a
top-level `vonzio` block. Separate-file alternatives were rejected
to keep one source of truth — when the operator policy file (§4)
records a hash of the package directory, both code and manifest
are covered by the same attestation, and there is no second file
to keep in sync.

### Required fields

```json
{
  "name": "@vonzio/plugin-hello",
  "version": "0.1.0",
  "main": "./dist/index.js",
  "vonzio": {
    "apiVersion": "1.0",
    "backendEntry": "./dist/index.js",
    "capabilities": [
      "notifications.channel",
      "storage.kv",
      "http.outbound"
    ],
    "outboundHosts": [
      "hello-plugin.example.com"
    ],
    "schemaPrefix": "hello"
  }
}
```

| Field | Required | Description |
|---|---|---|
| `apiVersion` | yes | Plugin-API semver. Loader refuses unless `plugin.major === core.major` AND `plugin.minor <= core.minor`. |
| `backendEntry` | yes | Path to the backend bundle. Must be a real file inside the package root. |
| `frontendEntry` | no | Path to the frontend bundle. For built-ins, allowed unconditionally. For externals, allowed only when the operator policy entry (§4) sets `approved_frontend: true`; default off. The dashboard build's virtual module (§16) reads the policy and bundles only approved frontends. |
| `capabilities` | yes | Array of `PluginCapability` strings (see §5). |
| `outboundHosts` | only when `http.outbound` is declared | Array of hostname patterns. Hostname only — schemes (`https://`), ports, paths, and userinfo are rejected by JSON-schema validation. Glob `*` allowed for one subdomain level (`*.slack.com` matches `files.slack.com`, not `a.b.slack.com`). Multi-level wildcards (`**.x.com`) are rejected. See "Outbound host matching" below for the runtime comparison rules. |
| `schemaPrefix` | only when `db.scoped` or `db.access` is declared | The DB schema prefix the plugin owns (e.g. `slack`). Loader refuses migrations / queries that touch tables outside this prefix. |
| `mtlsSecrets` | only when `secrets.mtls` is declared | Array of logical mTLS client-cert names (e.g. `["teller-client"]`; each matches `^[a-z][a-z0-9-]{0,62}$`). The operator maps each to host PEM paths via policy `mtls_secrets`. See §5. |
| `routePrefix` | no | `{kind: "auto"}` (default; mount under `/plugins/<name>`) or `{kind: "absolute", prefix: "/x"}` (logs a warning at load; reserved for legacy URLs the plugin author cannot change). |

Unknown fields in the `vonzio` block are **rejected**. Loader uses
strict JSON-schema validation. This prevents typos
(`capabilites: [...]`) from silently leaving a plugin ungated.

### Outbound host matching (runtime rules)

The loader compares `url.hostname` against each `outboundHosts`
entry using these rules:

- **Hostnames only.** Manifest entries that contain `/`, `:`, `?`,
  `#`, or `@` are rejected at validation time. Schemes and ports
  are not part of the match — both `http://api.x.com` and
  `https://api.x.com:8080` match a manifest entry of `api.x.com`.
  Future v2 may introduce port-scoped allowlists; v1 is hostname-only.
- **Case insensitive, lowercased.** Both sides are lowercased
  before comparison.
- **Trailing dots stripped.** `api.x.com.` is normalized to
  `api.x.com` before matching, defeating the "FQDN with trailing
  dot" bypass.
- **IDNA / punycode.** Manifest entries and runtime URLs are both
  encoded to ASCII via IDNA (`url.hostname` already does this in
  Node). An entry of `münchen.de` is accepted at manifest validation
  and stored as its punycode form (`xn--mnchen-3ya.de`); matches
  succeed against either user input form.
- **Glob `*` matches exactly one DNS label.** `*.x.com` matches
  `a.x.com` but not `a.b.x.com` and not `x.com` itself. The bare
  apex must be listed separately if you want it.

### Policy file JSON schema

The operator policy file (§4) uses strict JSON-schema validation
matching the manifest stance — unknown fields are rejected.
Required keys per entry: `version`, `approved_hash_sha256`,
`approved_capabilities` (array of `PluginCapability` strings),
`approved_outbound_hosts` (array; may be empty when the plugin
does not declare `http.outbound`). Optional: `approved_frontend`
(boolean; default false when absent), `mtls_secrets` (object mapping
each `manifest.mtlsSecrets` name to `{ cert, key, ca?, passphraseEnv? }`
host file paths — see §5), `approved_at` (ISO 8601), `approved_by`
(string), `approval_reason` (string, from `--reason`). Top-level:
`policy_version` is required and pinned to `"1"` for v1.

### Validation order

```
1. resolve VONZIO_PLUGINS env entry → real path via fs.realpath
2. open package.json
3. parse + JSON-schema validate the vonzio block
4. assertApiCompatible(manifest.apiVersion, core PLUGIN_API_VERSION):
     refuse unless plugin.major === core.major AND plugin.minor <= core.minor
5. determine plugin source (workspace = builtin, node_modules = external)
6. if external AND manifest.frontendEntry present AND
     policy.approved_frontend !== true → REFUSE LOAD
     (fails loudly rather than silently dropping the frontend —
     operator must either re-approve with frontend or the plugin
     author must remove frontendEntry to install backend-only)
7. if external AND "db.access" in capabilities → REFUSE
8. if external AND "db.scoped" in capabilities AND
     process.env.VONZIO_ALLOW_SCOPED_DB_PLUGINS !== "1" → REFUSE
9. if external AND combination ["integrations.read.decrypted", "db.access"]
     OR ["integrations.read.decrypted", "db.scoped"] declared → REFUSE
     (pair is effectively root; v2 may add an explicit opt-in)
10. assert backendEntry exists and is a child of the package root
    after `fs.realpath()`. For external plugins, additionally
    require the real path to be within `node_modules/<name>` —
    refuses symlinks that escape into other packages or the
    workspace. Built-ins resolve from workspace packages (outside
    `node_modules`), so the `node_modules/<name>` rule does NOT
    apply to them; the child-of-package-root + realpath check
    still does. Apply the same checks to `frontendEntry` when
    present.
11. assert each capabilities[] entry is in the PluginCapability union
12. if "http.outbound" in capabilities, require non-empty outboundHosts
13. if "db.scoped" or "db.access" in capabilities, require schemaPrefix
14. assert schemaPrefix matches "^[a-z][a-z0-9_]{1,30}$" (DB-safe identifier)
15. compute SHA-256 of package directory (excluding node_modules)
16. look up operator policy (§4) for this package name; refuse on:
    - policy entry absent
    - policy.approved_hash_sha256 !== computed hash
    - manifest.capabilities not a subset of policy.approved_capabilities
    - manifest.outboundHosts not a subset of policy.approved_outbound_hosts
    - manifest.frontendEntry present AND policy.approved_frontend !== true
      (with the "vonzio plugin approve --frontend" remediation hint
      in the error message)
17. log audit entry
18. await import(backendEntry)  ← code does not execute before this point
```

Steps 1-17 are pure I/O + validation; they read disk and reject
without running plugin code. The malicious-code-at-import window is
closed for any plugin failing 1-17.

---

## 4. Operator policy file

The manifest is the plugin author's *request*. The operator's *grant*
lives in a separate file the operator owns:

`vonzio-plugins.json` (next to `.env` in the working directory, or
path override via `VONZIO_PLUGIN_POLICY=/path/to/file.json`):

```json
{
  "policy_version": "1",
  "plugins": {
    "@vonzio/plugin-gmail": {
      "version": "0.3.1",
      "approved_hash_sha256": "9a7f4e2b...",
      "approved_capabilities": [
        "storage.kv",
        "http.outbound",
        "integrations.read.masked",
        "integrations.write",
        "notifications.channel"
      ],
      "approved_outbound_hosts": [
        "oauth2.googleapis.com",
        "gmail.googleapis.com",
        "www.googleapis.com"
      ],
      "approved_frontend": true,
      "approved_at": "2026-06-15T14:22:00Z",
      "approved_by": "amen@vonz.io"
    }
  }
}
```

`approved_frontend` is the operator's explicit grant for the plugin's
frontend code (if any) to be bundled into the dashboard at build
time, where it runs in the dashboard origin with full DOM, session,
and credentialed-fetch access. The flag is optional; absent or
`false` means the plugin loads backend-only (and is refused with a
loud error if the manifest also declares `frontendEntry`).

### Loader behavior against the policy

- **Policy entry absent for a `VONZIO_PLUGINS` member** → refuse load.
- **`approved_hash_sha256` mismatch** → refuse load. Catches tampered
  installs and unintended in-place edits.
- **Manifest `capabilities` not a subset of `approved_capabilities`** →
  refuse load. The plugin author cannot grant themselves new
  surfaces; an upgrade that adds a capability requires the operator
  to re-approve.
- **Manifest `outboundHosts` not a subset of
  `approved_outbound_hosts`** → refuse load. New hosts also require
  operator re-approval.
- **Manifest declares `frontendEntry` AND policy
  `approved_frontend` is not `true`** → refuse load with a clear
  error pointing the operator at `vonzio plugin approve --frontend`.
  The frontend is the highest-impact grant an operator can give a
  plugin (full session + DOM access in the dashboard origin); we
  do not silently drop it. Built-ins are auto-approved in the
  shipped `vonzio-plugins.builtins.json`.
- **Plugin version differs from policy `version`** → refuse load by
  default. `VONZIO_PLUGIN_POLICY_TRACK_VERSIONS=loose` softens this
  to "warn but proceed if the hash matches" — for operators who
  treat the directory hash as the authoritative attestation and
  don't want version-string ceremony for in-place upgrades. The
  loose mode **only** relaxes the version-string equality check;
  every other policy check (hash match, capability subset,
  outbound host subset, `approved_frontend` flag) still applies.

### CLI helper

A loader-shipped tool generates the policy entry from a plugin
that's already installed:

```bash
$ vonzio plugin approve @vonzio/plugin-gmail
@vonzio/plugin-gmail@0.3.1
  hash:         sha256:9a7f4e2b...
  capabilities: storage.kv, http.outbound, integrations.read.masked,
                integrations.write, notifications.channel
  outbound:     oauth2.googleapis.com, gmail.googleapis.com,
                www.googleapis.com
  frontend:     yes (declared frontendEntry: ./dist/frontend.js)

Reminder: approving this plugin commits you to having reviewed its
source code AND its full transitive dependency tree. Backend code
runs in core-server with full Node access. Frontend code, if
approved, runs in your dashboard origin (see prompt below).

Approve backend (membrane + scoped capabilities + audited outbound)? [y/N] y

This plugin includes frontend code that will run in your dashboard
origin with full DOM, localStorage, cookie, and credentialed fetch
access — equivalent to giving the plugin full access to your
dashboard session and anything you view or type in it. The frontend
has its own transitive dependency tree built by Vite; your audit
should cover that source tree, not just the backend. v1 has no DOM
sandbox; iframe isolation arrives in v2. Dashboard CSP blocks
scripts loaded from plugin Fastify routes — bundling via the policy
file is the only path frontend code reaches the browser, but once
bundled it has full same-origin power.

Approve frontend bundling? [y/N] y

✓ Added entry (approved_frontend: true).
  Re-run vonzio with VONZIO_PLUGINS=@vonzio/plugin-gmail.
  IMPORTANT: rebuild the dashboard so the frontend is picked up —
  the server's parity check will refuse to boot until the build
  artifact matches this policy entry.
```

On re-approval of an existing entry (version bump, hash change,
new capability requested), the prompt shows a diff:

```bash
$ vonzio plugin approve @vonzio/plugin-gmail
@vonzio/plugin-gmail: changes since last approval (2026-06-15)
  version:      0.3.1  →  0.4.0
  hash:         9a7f...  →  c2b1... (changed: src/index.ts, src/oauth.ts)
  capabilities: + scheduler.run    (NEW — review what this enables)
                - integrations.read.masked  (removed)
  outbound:     + accounts.google.com  (NEW host — review purpose)

Run `vonzio plugin diff @vonzio/plugin-gmail --files` to see the
file-level changes that affect the bundle.

Approve all changes? [y/N]
```

`vonzio plugin approve --frontend` skips the frontend prompt and
approves frontend in one shot; `--no-frontend` does the inverse
(approves backend, refuses frontend even if declared — useful when
the operator wants to install the plugin headless on purpose).
`--reason "..."` records an arbitrary rationale string into the
policy entry (`approval_reason`) — used automatically for dangerous
approvals (root-equivalent combinations) and available for any
approval the operator wants to annotate.

Refusal: the tool will not approve a plugin that requests
`db.access` (built-in territory). For the
`integrations.read.decrypted + db.{scoped|access}` combination
(root-equivalent), the v1 answer is **simply no** — no override
flag, no rationale escape hatch, because the loader would refuse
the resulting policy entry at boot anyway (per §3 step 9 and §5).
v2 may add an explicit opt-in path with a recorded rationale; for
v1, plugins requesting that combination need to be reshaped to
ask for less. The `--reason` flag remains useful for
non-root-equivalent approvals the operator wants to annotate.

### Why this is the v1 attestation, not lockfile integrity

A previous draft proposed comparing the installed package directory
hash against `package-lock.json`'s `integrity` field. That math
doesn't work — npm's `integrity` is the SHA of the published
*tarball* (with its tar framing, file ordering, and mtime metadata),
not the extracted on-disk tree. The directory-vs-tarball hashes
will never equal.

The operator policy approach attests against a hash the *operator*
recorded at approval time. The chain of trust is:

1. Operator inspects the plugin source + transitive tree.
2. Operator runs `vonzio plugin approve`, which records the current
   on-disk hash into `vonzio-plugins.json`.
3. Every subsequent boot, the loader re-hashes and compares against
   the policy-recorded value.

`vonzio-plugins.json` is checked into the operator's deployment
repository. Changes to it are reviewed like any infra config.

---

## 5. Capability enum

`PluginCapability` is a TypeScript string-literal union exported from
`@vonzio/plugin-api`. Adding a capability is additive (minor version
bump); removing or renaming is breaking (major bump).

```typescript
export type PluginCapability =
  // ── Storage (preferred for new plugins) ────────────────────
  /** Per-plugin namespaced key/value store backed by plugin_storage. */
  | "storage.kv"

  // ── Database (use sparingly) ───────────────────────────────
  /** Scoped Drizzle handle restricted to manifest.schemaPrefix tables.
   *  Raw SQL via db.execute is REFUSED for db.scoped plugins.
   *  External plugins additionally require VONZIO_ALLOW_SCOPED_DB_PLUGINS=1. */
  | "db.scoped"
  /** Unscoped Drizzle handle + raw SQL. REFUSED for external plugins;
   *  built-ins only. */
  | "db.access"

  // ── Crypto ─────────────────────────────────────────────────
  /** Encrypt plugin-owned secrets for persistence. */
  | "encryption.encrypt"
  /** Decrypt plugin-owned secrets. Encryption keys are scoped per plugin —
   *  plugins can decrypt only blobs they encrypted. */
  | "encryption.decrypt"

  // ── Integrations ───────────────────────────────────────────
  /** Read integration rows with secrets MASKED (config keys present,
   *  decrypted values replaced with sentinels). Use when you need the
   *  shape, not the secrets. */
  | "integrations.read.masked"
  /** Read integration rows with secrets DECRYPTED. Highest-risk
   *  capability — pairs with operator review of the plugin source.
   *  External plugins cannot declare BOTH integrations.read.decrypted
   *  AND db.scoped/db.access (the combination is effectively root). */
  | "integrations.read.decrypted"
  /** Create / update integration rows. */
  | "integrations.write"

  // ── Profiles ───────────────────────────────────────────────
  /** Narrow read-only profile lookup (list / get). */
  | "profiles.read"
  /** Full ResolvedProfile lookup (credentials, env, setup_commands).
   *  Use only when calling orchestrator.wake. */
  | "profiles.resolve"

  // ── Workspaces ─────────────────────────────────────────────
  /** Workspace get + list. */
  | "workspaces.read"
  /** Workspace mutations (name, starred, archived, tags, model_override). */
  | "workspaces.write"

  // ── Auth ───────────────────────────────────────────────────
  /** Opt route scopes into the user-auth hook. */
  | "auth.gate"

  // ── Presence ───────────────────────────────────────────────
  /** Register a chat-surface presence provider. */
  | "presence.register"

  // ── Tasks / sessions / orchestration ───────────────────────
  /** Submit new tasks. */
  | "tasks.submit"
  /** Register a new session row. */
  | "sessions.register"
  /** Push session expiry forward. */
  | "sessions.extend"
  /** Move sessions between status states. */
  | "sessions.setStatus"
  /** Read the set of dashboard-connected session ids. */
  | "sessions.getConnectedIds"
  /** Wake a workspace container before submitting a task. */
  | "orchestrator.wake"

  // ── Event log + dashboard push ─────────────────────────────
  /** Append entries to the dashboard timeline. */
  | "events.append"
  /** Read entries from the dashboard timeline. */
  | "events.read"
  /** Subscribe to orchestrator session events (task:token, task:done). */
  | "events.subscribe"
  /** Push messages to dashboard WebSocket clients. */
  | "dashboard.push"

  // ── Chat-surface utilities ─────────────────────────────────
  /** Strip inline images from agent output. */
  | "images.rewrite"
  /** List models available to a profile. */
  | "models.list"

  // ── Plugin-contributed surfaces ────────────────────────────
  /** Claim a notification kind ("telegram", "slack", "email"). */
  | "notifications.channel"
  /** Contribute an MCP server. */
  | "mcp.register"
  /** Register cron + interval scheduled work. */
  | "scheduler.run"

  // ── Outbound HTTP ──────────────────────────────────────────
  /** Use ctx.http.fetch. Required + manifest.outboundHosts populated. */
  | "http.outbound"

  // ── Secrets (operator-provisioned material) ────────────────
  /** Resolve an operator-provisioned mTLS client cert/key (declared in
   *  manifest.mtlsSecrets, mapped to host files in policy) into an opaque
   *  ref for ctx.http.fetch({ mtls }). The plugin never reads the bytes. */
  | "secrets.mtls";
```

Total: **31 capabilities** (the runtime tuple in `capabilities.ts` is
authoritative; `capabilities.test.ts` asserts the count).

### mTLS client certs (`secrets.mtls` + `ctx.secrets`)

Some upstreams (e.g. the Teller banking API) require **mutual TLS** — the
client presents a certificate during the handshake. A plugin gets this without
ever touching the private key:

1. **Manifest** declares logical names: `mtlsSecrets: ["teller-client"]`
   (required + non-empty iff `secrets.mtls` is declared; names match
   `^[a-z][a-z0-9-]{0,62}$`).
2. **Operator policy** maps each name to host PEM file paths:
   ```jsonc
   "mtls_secrets": {
     "teller-client": {
       "cert": "/run/secrets/teller/cert.pem",
       "key":  "/run/secrets/teller/key.pem",
       "ca":   "/run/secrets/teller/ca.pem",   // optional: trust a private server cert
       "passphraseEnv": "TELLER_KEY_PASS"       // optional: env var NAME, never the value
     }
   }
   ```
   Every declared name must be provisioned here or the loader refuses the
   plugin (`policy_mtls_secret_drift`). The cert/key/ca files are read **once at
   load**; an unreadable file (or an unset passphrase env) refuses the plugin
   (`mtls_secret_unreadable`) — fail-closed.
3. **Runtime**: the plugin calls `ctx.secrets.mtls("teller-client")` to get an
   opaque `MtlsRef` (it carries only the name), then passes it to
   `ctx.http.fetch(url, { mtls: ref })`. Core resolves the ref to the pre-loaded
   PEM bytes **server-side** and presents the cert on the undici connection —
   composing with the existing SSRF IP-pin, so a host stays both pinned and
   mutually authenticated. The bytes never enter plugin-readable memory, so the
   plugin can't exfiltrate the key even through an allowed outbound host. This
   is why `secrets.mtls` is external-allowed and not a root-equivalent combo.

```typescript
interface MtlsRef { readonly __vonzioMtls: true; readonly name: string }
interface PluginSecrets { mtls(name: string): MtlsRef }   // ctx.secrets
// ctx.http.fetch(url, { mtls: ctx.secrets.mtls("teller-client") })
```

Resolution + each mTLS outbound call are audited (`plugin mtls secret
resolved`, and `mtls_secret` on the `plugin outbound call` event).

### Three-tier storage story

| Tier | Capability | Who | Why |
|---|---|---|---|
| Key-value | `storage.kv` | All plugins, default. | Plugins using `storage.kv` are not given a vonzio API path to other tables. They can still defeat this by importing `node:fs` or `@vonzio/core-server` directly, which is what operator audit catches. |
| Scoped relational | `db.scoped` | Plugins with relational needs. External requires `VONZIO_ALLOW_SCOPED_DB_PLUGINS=1`. No raw SQL. | Schema-prefix-enforced Drizzle builder calls. Raw SQL refused. |
| Unscoped relational | `db.access` | Built-ins only. Loader refuses externals declaring this. | Escape hatch for OSS-shipped plugins where the threat model is vetted code. |

`storage.kv` API on `PluginContext`:

```typescript
interface PluginStorageKv {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
}
```

Backed by a `plugin_storage` core-owned table:
`(plugin_id, key, value JSONB, updated_at)`. Reads/writes are
filtered server-side by `plugin_id`.

### Capability combinations refused for external plugins

These pairs are too close to "root" to grant via the normal review
flow. External plugins requesting them are refused at load. Built-ins
are exempt.

- `integrations.read.decrypted` + `db.scoped`
- `integrations.read.decrypted` + `db.access` (already refused since
  `db.access` is built-in only, but called out for clarity)

v2 may add an explicit opt-in (`VONZIO_APPROVE_ROOT_LIKE_PLUGINS=1`
plus a CLI flow that records the operator's name + reason in the
policy file). For v1, the answer is simply "no."

---

## 6. Discovery

External plugins are listed in the `VONZIO_PLUGINS` env var, comma-
separated:

```bash
VONZIO_PLUGINS=@vonzio/plugin-gmail,@vonzio/plugin-teller,my-custom-plugin
```

### Name validation

Each entry is validated against `^(@[\w.-]+\/)?[\w.-]+$`. Rejected:
`./...`, `../...`, absolute paths, `file:` / `http:` / any URL form,
strings with whitespace. Loader refuses to boot if any entry is
malformed.

### Resolution

For each name:

1. `require.resolve(name, { paths: [process.cwd()/node_modules] })`
   resolves to a file inside the installed package.
2. The package root is the nearest ancestor with `package.json`.
3. `fs.realpath()` is applied — symlinks are followed but the
   resolved path must remain within `node_modules/<name>`.
   Symlinked-out plugins are refused (defense against path-escape
   tricks).

### No naming-convention auto-discovery

Auto-loading anything in `node_modules` matching `@vonzio/plugin-*`
was considered and rejected: too implicit, hides what's running, and
a transitive dependency that happens to match the pattern would load
without explicit operator consent. Explicit `VONZIO_PLUGINS` is the
only path.

### Dry-run mode

`vonzio --list-plugins` flag (or `VONZIO_PLUGINS_DRY_RUN=1`) runs
loader steps 1-17 from §3 for every declared plugin and prints the
audit-log block, then exits before step 18. Operators can review
hashes, capabilities, and `outboundHosts` lists before letting any
plugin code execute. Also useful for CI checks against a deployment
config.

---

## 7. The capability membrane

**Framing first.** The membrane is **hygiene against honest mistakes
and a tool to make capability use legible at runtime** — not a
containment boundary against in-process malice. A determined plugin
author can defeat it trivially by doing `require('@vonzio/core-server')`
or `require('node:fs')` directly; the loader cannot prevent that
without VM isolation (deferred to v2). What the membrane *does*
prevent is the plugin accidentally reaching surfaces it didn't
declare, and it makes any attempt to do so via the supplied `ctx.core`
reference visible in the audit log.

Re-read §2 if that framing isn't clear. The detail in this section
matters for getting the legibility right; it does not turn the
membrane into a sandbox.

### Construction

`Proxy.revocable(PluginCore, traps)` per plugin. Plugins receive
**only** the proxied reference via `ctx.core` — the raw `PluginCore`
is never stored in a place the plugin's call frame can reach via
the supplied API.

### Trap behavior summary

| Trap | Behavior on undeclared capability |
|---|---|
| `get(target, key)` | Throws `CapabilityViolationError({plugin, capability})` and emits an audit event. Returning `undefined` would turn a capability violation into a confusing `TypeError` later when the plugin called a method on it; throwing names the underlying bug at the violation site. |
| `has(target, key)` | Returns `false`. `"db" in core` reports false if not declared. (`has` is non-throwing because plugins legitimately probe for optional surfaces via `in`; throwing here would break feature-detection patterns.) |
| `ownKeys(target)` | Returns only declared keys. `Object.keys(core)`, `Reflect.ownKeys(core)`, spread, `JSON.stringify(core)` all see only declared surfaces. |
| `getOwnPropertyDescriptor(target, key)` | Returns `undefined` for undeclared keys. |
| `set` / `defineProperty` | Throw. The membrane is read-only; plugins cannot patch surfaces. |
| `getPrototypeOf` | Returns the prototype of an empty object. Prevents `Object.getPrototypeOf(core).constructor.name` recon. |
| `setPrototypeOf` | Throws. |
| `apply` / `construct` | The membrane is an object proxy, not a function proxy — `apply`/`construct` traps on `ctx.core` itself never fire. The methods plugins call (`ctx.core.tasks.submit(...)`) are reached via `get`, which returns a bound wrapper function. The wrapper does the declared-method gate before invoking the underlying method. `construct` on `ctx.core` would attempt `new ctx.core(...)`, which is not a meaningful call shape; refused for hygiene. |

### Nested wrapping

Any object returned from a declared capability is itself wrapped.
A method returning a rich object cannot be used to escape into
surfaces the manifest didn't declare. The corpus tests (§12) probe
for this.

### Per-plugin revocation

On graceful unload (rare in v1; just rollover for testing), the
plugin's revocable proxy is revoked. Captured references in
closures throw on next use. This is preparation for v2's hot-reload
story; v1 doesn't expose unload to operators.

### Method binding + freeze

All methods are pre-bound to stable receivers and the membrane is
`Object.freeze`d. Plugins cannot replace a method, capture `this`
to call it against another target, or mutate the membrane.

### Test corpus

See §12. The negative-test suite actively attempts known bypasses
of the supplied `ctx.core` reference and asserts they fail. None
of those tests prove the runtime is sandboxed — they prove the
membrane catches the easy mistakes.

---

## 8. Per-plugin Fastify scope

The plugin's `ctx.server` is a Fastify child instance created via:

```typescript
server.register(async (child) => {
  await plugin.init({ ...ctx, server: child });
}, { prefix: "/plugins/" + plugin.name });
```

The child instance carries forward typed `request.user` and core
decorators but **cannot**:

- Register routes outside its prefix (Fastify enforces).
- Decorate the parent instance (`server.decorate(...)` writes only
  to the child).
- Register a global error handler (the parent's handler still
  wins; child handler is scope-local).
- Override the parent's content-type parsers.

A determined plugin can still call into the parent via
`require('@vonzio/core-server')` — that's the same in-process
limitation §2 names. The Fastify child instance closes the
"register a /v1/admin/* route via ctx.server" path, not the
"reach into the parent server module" one.

### Legacy URL escape hatch

For plugins like Slack OAuth where the callback URL is registered
in the third-party app config and changing it would break every
operator's Slack app, the manifest can opt into an absolute prefix:

```json
"routePrefix": { "kind": "absolute", "prefix": "/v1/slack" }
```

This requires:

1. Explicit declaration (no silent absolute paths)
2. The prefix is logged with the audit entry
3. The prefix is matched against a deny-list (`/v1/auth/*`,
   `/v1/admin/*`, `/v1/orgs/*`, `/health`, `/metrics`, `/assets/*`,
   `/api/*`). `/assets/*` reserves Vite's hashed-output path so a
   plugin cannot claim a route that would mask or override built
   dashboard assets; `/api/*` reserves the public REST namespace.
4. The loader refuses on deny-list overlap

---

## 9. Per-plugin database scope

**Framing first.** Same caveat as §7: the scoped Drizzle wrapper is
hygiene against honest mistakes by plugins using the supplied
`ctx.core.db` reference. A plugin that wants to reach other tables
can `require('@vonzio/core-server/db')` directly, or open its own
connection using `DATABASE_URL` from `process.env`. The wrapper
catches the typo case (Drizzle builder picking the wrong table) and
makes cross-schema attempts visible in the audit log; it does not
prevent in-process malice.

A plugin declaring `db.scoped` receives a Drizzle handle wrapped by
an interceptor:

```typescript
function scopedDb(rawDb: NodePgDatabase, schemaPrefix: string) {
  return new Proxy(rawDb, {
    get(target, key) {
      const orig = target[key];
      if (typeof orig !== "function") return orig;
      return (...args: unknown[]) => {
        const result = orig.apply(target, args);
        return wrapQueryBuilder(result, schemaPrefix);
      };
    },
  });
}
```

`wrapQueryBuilder` intercepts every method that takes a table
identifier:

- Top-level: `.from(t)`, `.update(t)`, `.insert(t)`, `.delete(t)`,
  `.with(...)` (CTE definitions).
- Join methods: `.leftJoin(t, ...)`, `.rightJoin(t, ...)`,
  `.innerJoin(t, ...)`, `.fullJoin(t, ...)`, `.crossJoin(t, ...)`.
- Subquery composition: when `t` is itself a query builder, the
  same checks recurse into its `.from` / joins.

Every table identifier reaching the builder must start with the
schema prefix or the call throws `DbScopeViolationError`. Cross-
schema joins are the most common bypass attempt and are covered by
explicit negative tests in §12. Drizzle's schema-qualified-identifier
form (`schema.tableObj`) is checked against the prefix on the
generated SQL identifier, not just the JS variable name — the
wrapper does not assume the table's `Symbol.toStringTag` is the
canonical name.

### Raw SQL is refused for `db.scoped`

`db.execute(sql\`...\`)` throws `DbScopeViolationError` if the
plugin holds only `db.scoped`. The previous draft attempted regex-
based prefix checking and was correctly flagged as false confidence
(CTEs, schema-qualified names, quoted identifiers all defeat the
regex). Removing the option is the honest fix.

Plugins that need raw SQL need `db.access`, which means they're
built-ins (loader refuses `db.access` for external plugins, §3).

### Migration prefix enforcement

`migrations[]` entries from the plugin go through a SQL-AST check:
every `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX`, etc.
identifier must start with `schemaPrefix_`. Migrations failing this
are refused at load. The check uses a SQL lexer, not regex; comment
blocks and string literals are not searched.

### v2 trigger

True per-plugin DB isolation needs Postgres-level controls: a
dedicated schema + role per plugin, RLS on shared core tables.
Trigger to revisit: third-party plugin marketplace, multi-tenant
deployment, or first plugin-to-plugin DB access incident.

---

## 10. Outbound HTTP

Plugins making outbound HTTP requests use `ctx.http.fetch`:

```typescript
interface PluginHttp {
  fetch(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response>;
}
```

The helper:

1. Parses the URL. Refuses non-http(s).
2. Routes through `safeWebhookFetch` (SSRF blocks: 127/8, 10/8,
   172.16/12, 192.168/16, 169.254/16, 100.64/10, IPv6 loopback /
   link-local / ULA, IPv4-mapped IPv6 — same v0.1.2 patch).
3. Matches `url.hostname` against the manifest's `outboundHosts`,
   intersected with the operator policy's `approved_outbound_hosts`.
   Glob `*` matches one subdomain level. Failure throws
   `OutboundHostViolationError`.
4. Logs `{plugin, host, method, status, duration}` per call.
5. Default timeout 10s, max response 1 MiB (configurable per call
   up to 30s / 5 MiB; over-cap raises an error).

### Built-in plugin migration grace period

Built-in plugins (Slack, Telegram) currently call raw `fetch()`.
The migration to `ctx.http.fetch` happens in the same PR that ships
the loader; the built-ins are the first consumers. A CI lint
(`no-raw-fetch-in-plugins`) prevents regression after.

External plugins get no grace period — by the time an external
plugin ships, `ctx.http.fetch` is the only audited path. Direct
`fetch()` from external plugin code cannot be prevented, and the
detection here is **best-effort only with explicit limits**:

- The loader tags each plugin's `init()` async context with
  `{plugin: name}` via Node's `AsyncLocalStorage`.
- A wrapper around `globalThis.fetch` reads the active context on
  each call. When a plugin context is on the async stack but
  `http.outbound` isn't declared, it logs a security anomaly
  (not refused — would self-DoS on legitimate use of a non-vonzio
  library that happens to fetch internally).
- **The detection only covers `globalThis.fetch`.** A plugin that
  imports `fetch` directly from `undici`, uses
  `http.request` / `https.request`, opens a raw `net.Socket`, or
  loads a library that does any of these is **not** detected.
  The same in-process Node access §2 names: the operator's audit
  of the plugin source catches these patterns at install time;
  the loader does not prevent them.

Operators reading this section should not treat the AsyncLocalStorage
detection as a security control. It is an observability aid for
catching authors who reached for the global `fetch` by habit.

### WebSockets, EventSource, and other outbound surfaces

The `outboundHosts` allowlist + SSRF block applies to **every**
outbound network surface vonzio mediates for plugins, not just
HTTP fetch. Specifically:

- `ctx.http.webSocket(url, init)` — same allowlist check + SSRF
  block. Hostname must match `outboundHosts`.
- `ctx.http.eventSource(url, init)` — same.
- Lower-level surfaces (`net.Socket`, `dgram`, `tls.connect`) are
  **not** mediated. A plugin can use these directly. The same
  trust-model reasoning as `node:fs`: the operator's audit catches
  this pattern at install time, the loader does not prevent it.

`safeWebhookFetch` (the SSRF helper, shipped in v0.1.2) is the
chokepoint. Plugin surfaces above all route through it. The
helper resolves the URL's hostname BEFORE the connection,
checks the resolved IP against the SSRF blocklist, and pins
to the resolved address to defeat DNS rebinding (a second
resolution after the check returning a private IP). Plugin
allowlist matching happens after the SSRF check passes — the
two are AND'd.

---

## 11. Audit log

The loader emits a structured event per plugin at boot. Format:

```json
{
  "level": "info",
  "msg": "plugin loaded",
  "loader_version": "1.0.0",
  "node_version": "v22.10.0",
  "plugin": {
    "name": "@vonzio/plugin-hello",
    "version": "0.1.0",
    "source": "external",
    "resolved_path_fingerprint": "node_modules/@vonzio/plugin-hello@0.1.0",
    "package_hash_sha256": "9a7f...3e",
    "api_version": "1.0",
    "capabilities_declared": [
      "notifications.channel",
      "storage.kv",
      "http.outbound"
    ],
    "capabilities_granted": [
      "notifications.channel",
      "storage.kv",
      "http.outbound"
    ],
    "outbound_hosts_declared": ["hello-plugin.example.com"],
    "outbound_hosts_granted": ["hello-plugin.example.com"],
    "schema_prefix": null,
    "route_prefix": { "kind": "auto" },
    "frontend_approved": false
  }
}
```

`capabilities_declared` and `outbound_hosts_declared` are from the
manifest; `capabilities_granted` and `outbound_hosts_granted` are
from the operator policy. They will normally match; when they
diverge, the audit entry shows both so operators can spot drift.

### Privacy / path handling

`resolved_path_fingerprint` defaults to the last two path segments
(`@vonzio/plugin-hello/0.1.0`) plus the package-root content hash.
Operators wanting absolute paths in logs (e.g. for forensic review)
can set `VONZIO_AUDIT_LOG_FULL_PATHS=1`. Default is the abridged
form to keep absolute paths out of routine logs.

### Refusal events at load

When the loader refuses to load a plugin, it emits a structured
event before returning. Includes the refusal reason, the
remediation hint, and the diff between manifest and policy where
applicable. Examples:

```json
{
  "level": "warn",
  "msg": "plugin refused",
  "plugin_name": "@vonzio/plugin-foo",
  "reason": "unapproved_frontend",
  "manifest_declared": ["frontendEntry: ./dist/frontend.js"],
  "policy_state": "approved_frontend not set",
  "remediation": "run: vonzio plugin approve --frontend @vonzio/plugin-foo"
}
```

Refusal reason codes: `manifest_invalid`, `api_version_incompatible`,
`external_db_access`, `external_db_scoped_not_opted_in`,
`external_root_combination`, `policy_missing`,
`policy_hash_mismatch`, `policy_capability_drift`,
`policy_outbound_host_drift`, `unapproved_frontend`,
`schema_prefix_invalid`, `frontend_path_escape`,
`backend_path_escape`.

### Runtime audit events

Beyond load, the loader logs:

- Every `ctx.http.fetch` / WebSocket / EventSource call
  (host, method, status, duration).
- Every capability-violation throw (`{plugin, capability, key}`).
- Every prototype-tampering detection (logged loudly; does not
  refuse boot — see §2.10).
- Every `outboundHosts` mismatch.
- Every detected raw `fetch` call from a plugin without
  `http.outbound` declared (best-effort, via AsyncLocalStorage
  context tagging — see §10).

These flow to the same audit channel as security events from
core-server. Operators tail this channel during plugin onboarding.

---

## 12. Negative-test corpus

The PoC plugin lives at `examples/plugin-hello/` with a sibling
attack corpus at `examples/plugin-hello-attacks/`. The attack
corpus deliberately violates every loader invariant. Each test
asserts its **expected outcome** — refusal at the gate where the
gate refuses; the documented audit signal where the gate is
informational; the documented limitation where the loader cannot
prevent the attack at all. The latter two are not security
guarantees; they are the loader's *honest contract* (see §2).

### Attack test cases

| File | Attempts | Expected outcome |
|---|---|---|
| `attempt-undeclared-capability.ts` | Read `core.db` when only `storage.kv` was declared | Throws `CapabilityViolationError`; loader audit shows the violation |
| `attempt-membrane-bypass-reflect.ts` | `Reflect.ownKeys(core)` to enumerate hidden surfaces | Returns only declared keys |
| `attempt-membrane-bypass-spread.ts` | `{...core}` to leak surfaces via spread | Returns only declared keys |
| `attempt-membrane-bypass-bind.ts` | `core.tasks.submit.bind(otherTarget)` to escape | Method receiver is frozen; bind has no effect on the membrane gate |
| `attempt-route-collision.ts` | Register route at `/v1/admin/hello` | Fastify scope rejects at registration |
| `attempt-route-collision-absolute.ts` | Manifest declares `routePrefix.absolute: "/v1/auth"` | Loader refuses load (deny-list match) |
| `attempt-db-cross-schema.ts` | Plugin with `db.scoped` queries `users` table | Wrapped Drizzle interceptor throws `DbScopeViolationError` |
| `attempt-db-raw-sql.ts` | Plugin with `db.scoped` calls `db.execute(sql\`SELECT 1\`)` | Throws `DbScopeViolationError` — raw SQL refused for `db.scoped` |
| `attempt-outbound-undeclared-host.ts` | Plugin with `http.outbound: ["slack.com"]` fetches `evil.com` | `ctx.http.fetch` throws `OutboundHostViolationError` |
| `attempt-outbound-private-ip.ts` | Plugin fetches `http://169.254.169.254/` (declared as host) | `safeWebhookFetch` SSRF block fires |
| `attempt-frontend-entry-external-unapproved.ts` | External plugin declares `frontendEntry`; policy omits `approved_frontend` | Loader refuses load at step 6 / step 16 of §3 with the "approve --frontend" hint |
| `attempt-frontend-entry-external-approved.ts` | External plugin declares `frontendEntry`; policy sets `approved_frontend: true` | Loads successfully; dashboard build picks up the frontend via virtual module |
| `attempt-frontend-entry-symlink-escape.ts` | `frontendEntry` is a symlink that points outside the package root | Loader refuses load at step 10 of §3 (path escape) |
| `attempt-db-cross-schema-via-join.ts` | Plugin with `db.scoped` does `.from(myTable).leftJoin(users, ...)` | `wrapQueryBuilder` throws `DbScopeViolationError` on the join (§9 join coverage) |
| `attempt-db-cross-schema-via-cte.ts` | Plugin uses `.with(cte).from(cte)` where `cte` queries another schema | Throws `DbScopeViolationError` from the CTE definition step |
| `attempt-dashboard-csp-bypass.ts` | Plugin registers a Fastify route `/plugins/foo/payload.js` and embeds a `<script src="/plugins/foo/payload.js">` somewhere | CSP blocks the script load; dashboard does not execute it. Verified via headless browser in CI |
| `attempt-dev-server-unapproved-frontend.ts` | Run Vite dev server with an external plugin declaring `frontendEntry` but no `approved_frontend` | Dev server refuses to serve the plugin's frontend bundle (same gate as prod build) |
| `attempt-outbound-websocket-undeclared.ts` | Plugin declares `outboundHosts: ["api.example.com"]`; tries `ctx.http.webSocket("wss://evil.com")` | Throws `OutboundHostViolationError` (WebSocket subject to same hostname allowlist) |
| `attempt-policy-missing-capability.ts` | Manifest declares `storage.kv` + `db.scoped`; policy approves only `storage.kv` | Loader refuses load at step 16 of §3 |
| `attempt-policy-hash-mismatch.ts` | Edit a file in the package directory after approval | Loader refuses load — hash differs from policy |
| `attempt-root-combination.ts` | External plugin declares `integrations.read.decrypted` + `db.scoped` | Loader refuses load at step 9 of §3 |
| `attempt-prototype-pollution.ts` | Plugin mutates `Object.prototype.foo` | Loader's intrinsics check logs loudly; boot continues (per §2.10) |
| `attempt-raw-fetch.ts` | Plugin imports `globalThis.fetch` directly | Audit log warns; documented limitation |
| `attempt-import-time-side-effect.ts` | Manifest is valid but `backendEntry` does network IO at top-level | Loader pre-import validation cannot prevent this; documented limitation |

The corpus serves three purposes: it proves the gates work, it's
example code for plugin authors learning the contract boundaries,
and it's a regression suite — any future loader refactor must
preserve all detections.

---

## 13. Built-in plugin migration

Slack and Telegram migrate to the loader contract in the same PR
that ships the loader. The shape of the change:

| Surface | Before | After |
|---|---|---|
| Load path | Static import in `core-server/src/index.ts` | Workspace path resolved via the loader; same membrane + audit as externals; bypass for the `external-only` rules (frontend allowed, `db.access` allowed) |
| `package.json` | No `vonzio` block | Adds `vonzio.capabilities` listing the actual surfaces used + `outboundHosts: ["slack.com", "*.slack.com"]` etc. |
| `fetch()` calls | Direct `fetch()` to `api.slack.com` etc. | Migrated to `ctx.http.fetch` |
| Drizzle access | Raw `db` handle from `core-server` | `ctx.core.db` with `db.access` declared |
| Frontend | Bundled into dashboard via workspace package | Same; auto-approved via `approved_frontend: true` in the shipped builtins policy. Externals can also opt into frontend bundling per-plugin (§4). |
| Operator policy | n/a | Built-ins are listed in a shipped `vonzio-plugins.builtins.json` (auto-`approved_frontend: true`) with hashes that the OSS build process keeps in sync. Operators do not need to approve built-ins separately. |

After migration, the differences between built-in and external are
encoded in §3 validation steps 5-9 (external rejected from `db.access`,
external-frontend-rejection, root-combination refusal) and in the
audit log `source` field. The pathway is uniform otherwise.

### Capabilities for the two built-ins

Drawn from a literal grep of what each plugin touches in its
current code:

**`@vonzio/plugin-slack`**:
```json
"capabilities": [
  "db.access",
  "encryption.encrypt", "encryption.decrypt",
  "integrations.read.decrypted", "integrations.write",
  "profiles.read", "profiles.resolve",
  "workspaces.read",
  "auth.gate",
  "presence.register",
  "tasks.submit",
  "sessions.register", "sessions.extend", "sessions.setStatus", "sessions.getConnectedIds",
  "orchestrator.wake",
  "events.append", "events.read", "events.subscribe",
  "dashboard.push",
  "models.list",
  "notifications.channel",
  "mcp.register",
  "scheduler.run",
  "http.outbound"
],
"outboundHosts": [
  "slack.com",
  "*.slack.com",
  "api.anthropic.com"
]
```

That Slack declares ~24 of 28 capabilities is a true reflection of
what a chat-surface integration needs — it doesn't reflect the
taxonomy failing. The capability enum's discriminating power is
highest for *small* plugins (`@vonzio/plugin-hello`, `@vonzio/plugin-webhook`),
where declaring 1-3 capabilities is the audit signal. For
integrated chat plugins, the value is in the audit trail and the
"future surface added to PluginCore can't be silently used"
property.

**`@vonzio/plugin-telegram`**: same shape, plus `images.rewrite`
(Telegram strips inline markdown images); replaces `slack.com`
with `api.telegram.org` in `outboundHosts`.

---

## 14. Anti-tampering snapshots

Before plugin init, the loader snapshots:

- `process.env` key set.
- Count of registered `uncaughtException` and `unhandledRejection`
  listeners.
- SHA-256 of the JSON.stringify of `Object.prototype`,
  `Array.prototype`, `Function.prototype` (descriptors of own
  properties).

After init returns, the loader recomputes. Differences are logged
loudly at the security level. Boot does **not** refuse on
mismatch (per §2.10) — that would make the detection a self-DoS
surface. The signal is for operator alerting; the response is
operator-side.

The snapshot covers the load window only. A plugin that wants to
pollute on first request, after the snapshot, will not be caught.
This is documented as a known limitation.

---

## 15. Deferred to v2 with explicit triggers

| Item | Trigger | What it requires |
|---|---|---|
| Iframe-isolated external frontends with postMessage bridge | First need to allow a frontend from a plugin the operator did **not** fully audit (marketplace plugin, managed-host vended plugin). v1 already supports frontends from operator-audited externals via the `approved_frontend` flag — what iframe isolation adds is the option to skip the audit. | Shared UX toolkit hosted at a known origin; tight per-iframe CSP; postMessage protocol; loader path to wire the iframe |
| Process / worker-thread isolation per plugin | First plugin hosted via marketplace; any plugin not operator-reviewed; multi-tenant SaaS deployment | IPC layer, async-over-IPC for every `ctx.*` call, debugging tooling rework |
| Postgres per-plugin role + RLS | >3 external plugins; or multi-tenant deployments; or first plugin-to-plugin DB access incident | Per-plugin schema + role; migrations refactor for RLS policies on shared tables |
| Per-plugin resource quotas (CPU, memory, network rate) | First plugin-induced DoS or near-miss | Process isolation is the practical path; same trigger as above |
| Explicit opt-in for root-equivalent capability combinations | First real plugin needing `integrations.read.decrypted` + `db.scoped` and operator willing to take the risk | CLI flow recording operator name + reason in policy file |
| Out-of-process dry-run | Hosting plugins we didn't review | Same IPC layer as process isolation |
| Manifest signing | Operators who cannot trust `package.json` integrity (compliance use) | Signing infrastructure, key distribution, rotation |
| `disablePlugin` / `revokePluginTokens` / `rollbackPluginMigrations` admin tooling | First reported "stuck on a broken plugin" support case | Mostly tooling, modest design work |
| Install-time approval UI in the dashboard | First non-CLI operator audience (managed-host deployments) | Dashboard plumbing; loader already emits the data |

For each deferred item, the trigger is the *event* that should
make us revisit, not a date. Don't pre-build for these — but when
the trigger hits, the items above are the ones we know are waiting.

---

## 16. Implementation order

The work fits in two PRs:

### PR 3J.1 — Backend loader + capability membrane + operator policy + scoped DB + audit log

`packages/plugin-api/`:
- Add `PluginCapability` union (§5)
- Add `outboundHosts`, `schemaPrefix`, `routePrefix.absolute` to manifest types
- Add `PluginStorageKv`, `PluginHttp` interfaces
- Add `ctx.storage`, `ctx.http`, `ctx.core` (proxied) to `PluginContext`
- Add error classes (`CapabilityViolationError`, `OutboundHostViolationError`, `DbScopeViolationError`, `PolicyViolationError`)
- Tighten `assertApiCompatible` to enforce `plugin.major === core.major && plugin.minor <= core.minor`

`packages/core-server/src/plugins/loader.ts`:
- Manifest-before-import validation pipeline (§3, all 18 steps)
- Operator policy file parsing + cross-check (§4)
- `Proxy.revocable` membrane construction (§7)
- Per-plugin Fastify scope wrapper (§8)
- Scoped Drizzle wrapper rejecting raw SQL (§9)
- `safeWebhookFetch`-backed `ctx.http.fetch` with allowlist (§10)
- Audit logger (§11)
- Intrinsics snapshot + log-on-mismatch (§14)

`packages/core-server/src/plugins/storage.ts`:
- `plugin_storage` migration
- `PluginStorageKv` implementation

`packages/core-server/src/plugins/cli.ts`:
- `vonzio plugin approve <name>` CLI subcommand (§4)
- `vonzio --list-plugins` dry-run (§6)

`vonzio-plugins.builtins.json` (shipped with OSS):
- Operator-policy entries for Slack + Telegram with hashes the OSS
  build process recomputes on every release tag. Operators do not
  need to approve built-ins; the build keeps this file in sync.

Built-in plugin migration:
- Slack: add `vonzio` manifest block + replace raw `fetch` with `ctx.http.fetch`
- Telegram: same

`examples/plugin-hello/`:
- PoC plugin demonstrating `storage.kv` + `notifications.channel` + `http.outbound`
- `examples/plugin-hello-attacks/` corpus (§12)

CI:
- Run `examples/plugin-hello/` against a test core
- Run negative-test corpus against the loader; each case asserts
  its documented outcome from §12 (refusal, audit signal, or
  documented limitation — see the table)
- `no-raw-fetch-in-plugins` lint

### PR 3J.2 — Frontend bundling via virtual module (built-ins + policy-approved externals)

`packages/dashboard/vite-vonzio-plugins.ts`:
- Vite plugin that reads two sources at build time:
  1. The shipped `vonzio-plugins.builtins.json` for built-in
     frontends (always bundled).
  2. The operator's `vonzio-plugins.json` (resolved via the same
     `$VONZIO_PLUGIN_POLICY` rule as the backend; both consumers
     must read the same file) for externals where
     `approved_frontend: true`.
- Validates each external `frontendEntry` the same way the loader
  validates `backendEntry` (realpath, child-of-package-root,
  within `node_modules/<name>`).
- Statically imports each approved plugin's `frontendEntry`,
  exposes the set via `virtual:vonzio-plugins`.
- Emits `dashboard/dist/.plugins.json` with `{name, source, hash}`
  per bundled plugin (hash = the package-directory SHA-256 the
  loader also recomputes at runtime) plus the resolved policy
  file path and its own SHA-256 for runtime parity.
- Refuses to build if the policy file references a plugin whose
  package isn't installed, or whose installed hash doesn't match
  `approved_hash_sha256` — keeps build-time and runtime in
  lockstep.
- Dev server (`vite dev`): enforces the same policy. Refuses to
  serve frontend chunks for externals that lack
  `approved_frontend: true`. The build-time and dev-time gates
  must use the same code path; "works in dev, refuses in prod"
  is the footgun this rule prevents.

`packages/dashboard/csp.ts`:
- Strict Content-Security-Policy header sent on every dashboard
  HTML response. The policy:
  ```
  default-src 'self';
  script-src 'nonce-<buildNonce>' 'strict-dynamic';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  connect-src 'self';
  frame-ancestors 'none';
  object-src 'none';
  base-uri 'self';
  ```
- **Why nonce + strict-dynamic, not `'self'` + hashes.** With
  `'self'` present, *any* same-origin script URL loads — including
  scripts served from `/plugins/<name>/...` Fastify routes — which
  would defeat the whole "bundling is the only path to executing
  code in the dashboard origin" property. CSP hash-sources also
  only apply to inline scripts, not external `.js` files, so a
  hash list is the wrong tool here. A per-build nonce + the
  `strict-dynamic` keyword is the correct directive: the Vite plugin
  injects the nonce on every emitted `<script>` tag at build time;
  any other script load (from a plugin Fastify route, from an
  injected `<script src=...>` tag, from `document.write`) lacks the
  nonce and the browser refuses to execute it.
- The Vite build generates a fresh `buildNonce` per build, emits it
  into the dashboard HTML's CSP header, and stamps the same nonce
  onto every script tag. core-server reads the nonce from the
  built artifact at serve time. Operators rebuilding the dashboard
  get a fresh nonce; the parity check (above) verifies the runtime
  policy matches the build.
- Dev mode (`vite dev`) loosens `script-src` to allow Vite's HMR
  runtime — documented and clearly out of scope for production
  hardening.

`packages/core-server/src/plugins/parity-check.ts`:
- At runtime, verify the dashboard's `.plugins.json` matches the
  backend's `VONZIO_PLUGINS` + policy approvals. The check is
  **set + hash equality**: every plugin in `.plugins.json` must
  appear in the runtime policy with a matching hash, and every
  policy entry with `approved_frontend: true` must appear in
  `.plugins.json`. Mismatch fails server boot with a structured
  log line naming which plugins disagreed.
- Also verifies the build's recorded policy-file path + SHA-256
  match the runtime's policy file. If the operator changed the
  policy after building, this catches it.
- The check assumes `dashboard/dist/.plugins.json` is protected
  by the same deployment integrity controls as the rest of
  `dist/` — if an attacker can rewrite the dashboard bundle they
  can also rewrite this file. The check catches operator drift
  (rebuild forgotten); it is not a defense against a compromised
  build host.

---

## 17. What this spec does not specify

These are intentionally out of scope; the spec stops at the loader
contract:

- The specific schema of `plugin_storage` (one column? JSONB?
  encrypted?) — implementation choice with a recommendation in §5.
- The exact wire format of the audit channel (pino structured
  fields recommended; format is implementation choice).
- The dashboard's plugin-management UI (v2 deferred).
- Plugin testing harness conventions — `examples/plugin-hello/` is
  the worked example; the doc on it lands in `PLUGINS.md`.
- Backwards-compatibility shims for capability splits. The
  capability enum in §5 is the v1 set; if it changes,
  apiVersion bumps and the policy file machinery handles drift
  via operator re-approval.

---

## 18. Changelog

- **2026-06-03 (revision 5, sign-off blockers + ambiguity pass)**
  — Applied Codex's revision-4 sign-off feedback. Two genuine
  spec bugs were flagged as blocking:
  - **§16 CSP bug**: `script-src 'self' 'sha256-<bundleHashes>'`
    does not enforce "bundling is the only path." With `'self'`
    present, any same-origin script URL loads — including
    `/plugins/<name>/...` JS served from a plugin's Fastify route.
    Also, CSP hash-sources only apply to inline scripts, not
    external `.js` files. Replaced with
    `script-src 'nonce-<buildNonce>' 'strict-dynamic'` — no
    `'self'`. Vite injects the nonce on every emitted `<script>`
    tag; scripts from any other path lack the nonce and the
    browser refuses to execute them.
  - **§4 CLI / §3.9 loader contradiction**: §4 CLI offered
    `--i-know-what-im-doing` to approve the root-equivalent
    `integrations.read.decrypted + db.{scoped|access}` combo,
    but §3.9 + §5 say the loader refuses that combination
    outright. The CLI would write a policy the loader then
    refuses at boot. Removed the override; for v1 the answer is
    "simply no, no escape hatch." v2 may add an explicit opt-in.
  - **Field name drift**: §3.16 referenced `policy.approved_hash`;
    §4 defined it as `approved_hash_sha256`. Standardized on
    `approved_hash_sha256` everywhere.
  - **§12 test example**: `["wss://api.example.com"]` corrected
    to hostname-only `["api.example.com"]` to match the manifest
    rule.
  - **§3 step 10 path checks**: `within node_modules/<name>`
    scoped to externals; built-ins use workspace paths so the
    rule does not apply. Child-of-package-root + realpath still
    applies to both.
  - **§11 audit log**: outbound hosts now logged as
    `outbound_hosts_declared` + `outbound_hosts_granted` mirroring
    the capabilities split, so drift between manifest and policy
    is visible at the log line.
  - **§10 raw-fetch detection**: explicit limitation note —
    AsyncLocalStorage tagging covers `globalThis.fetch` only.
    `undici`-imported `fetch`, `http.request`, raw `net.Socket`,
    etc. are not detected. Operators reading §10 should not treat
    the detection as a security control, only an observability
    aid.
  - **§7 apply/construct trap wording**: rewrote to clarify the
    membrane is an object proxy — `apply`/`construct` on `ctx.core`
    itself never fire under normal call shapes; the declared-method
    gate happens via the bound wrapper functions returned from
    `get`.
  - **§3 new "Outbound host matching" subsection**: makes the
    runtime comparison rules unambiguous — hostnames only, port
    behavior (ignored in v1), case insensitive, trailing dots
    stripped, IDNA / punycode handled, single-label `*` glob.
  - **§3 new "Policy file JSON schema" subsection**: pinned the
    exact set of required and optional policy keys with strict
    unknown-field rejection mirroring the manifest stance.
- **2026-06-03 (revision 4, security re-review pass)** — Applied
  Codex's revision-3 security re-review. (Gemini was unavailable
  due to quota cap; Codex's review was thorough enough for this
  round.) Net changes:
  - **Bug fix**: §2.7 said unapproved frontends would load
    backend-only, but §3 step 6 + §4 said REFUSE. The spec
    contradicted itself. Refuse is the correct behavior (silent
    drop would leave the operator with a half-broken plugin and
    the wrong mental model). §2.7 fixed.
  - **Bug fix**: §7 membrane `get` trap said "returns `undefined`"
    on undeclared keys; §2.3 and §12 expected throws. Returning
    undefined would turn a capability violation into a downstream
    `TypeError` that's harder to debug. Now throws
    `CapabilityViolationError` at the violation site. `has` trap
    still returns `false` (legitimate feature-detection pattern).
  - **New v1 control: Dashboard Content Security Policy**. The
    Vite virtual-module gate alone wasn't enough — an unapproved
    plugin could register a Fastify route serving JS, then have
    the dashboard load it. CSP with `script-src` restricted to
    Vite's hashed bundles closes this path at the browser layer.
    Added to §16 PR 3J.2 implementation.
  - **§3 step 10**: `frontendEntry` path validation mirrors
    `backendEntry` (realpath, child-of-package-root, within
    `node_modules/<name>` — refuses symlink escapes).
  - **§3 step 16**: now also subset-checks
    `manifest.outboundHosts` against
    `policy.approved_outbound_hosts`, and the
    `manifest.frontendEntry` vs `policy.approved_frontend` rule.
    Consolidates policy cross-check.
  - **§8 deny-list**: added `/assets/*` (Vite output path) and
    `/api/*` (public REST namespace) to the absolute-route
    deny-list.
  - **§9 DB scope**: `wrapQueryBuilder` now covers join methods
    (`leftJoin`, `rightJoin`, `innerJoin`, `fullJoin`,
    `crossJoin`), CTE definitions (`.with(...)`), and recurses
    into subquery composition. Two new negative tests in §12.
  - **§10 outbound HTTP**: AsyncLocalStorage named explicitly as
    the mechanism for raw-fetch detection; new subsection on
    WebSocket/EventSource (same allowlist) and DNS rebinding
    (handled by `safeWebhookFetch`, referenced not redundantly
    documented).
  - **§11 audit log**: new "refusal events at load" subsection
    with structured event shape and the full refusal-reason code
    enumeration. Runtime events list updated for WebSocket and
    AsyncLocalStorage context tagging.
  - **§12 corpus**: six new attack tests — frontendEntry symlink
    escape, DB cross-schema via join, DB cross-schema via CTE,
    dashboard CSP bypass attempt, dev-server unapproved frontend,
    outbound WebSocket undeclared host.
  - **§16 PR 3J.2**: significantly expanded with the CSP
    requirements, dev-server policy enforcement, frontendEntry
    validation, build-runtime parity check now using set+hash
    equality plus a recorded policy-file SHA-256, and an honest
    note that the parity check guards operator drift not a
    compromised build host.
  - **§4 CLI**: prompt language tightened ("equivalent to giving
    the plugin full access to your dashboard session and anything
    you view or type in it"), explicit pre-review reminder added,
    diff display on re-approval (capability/host/hash deltas),
    `--reason` flag for recording rationale, important rebuild
    reminder updated to mention the parity check.
  - **§4 policy file**: loose version mode clarified — it only
    relaxes version-string equality; every other check (hash,
    capabilities, outbound hosts, frontend approval) still
    applies.
  - **§2 trust**: added "frontend transitive dependency tree"
    paragraph (third trust item) and "time-of-presence
    asymmetry" subsection (backend continuous vs frontend
    session-bound).
- **2026-06-03 (revision 3, Option D — external frontend opt-in)**
  — Replaces revision 2's hard ban on external `frontendEntry` with
  a per-plugin operator opt-in in the policy file. Triggered by
  user pushback: real plugins (chat integrations, OAuth-heavy
  surfaces) need management UI; forcing them to v2 leaves Gmail /
  Teller / future externals headless and operationally awkward.
  Re-examined the trust model: for *operator-audited* externals
  (the v1 audience), frontend trust ≈ backend trust — both can
  steal sessions if compromised. The reviewer-Claude concern about
  frontend XSS was framed against a *third-party-marketplace*
  threat model, which is correctly deferred to v2 with iframe
  isolation. For v1's "operator explicitly adds + audits + runs
  `vonzio plugin approve`" flow, the safe default is opt-out with
  an explicit per-plugin flag.
  - §2.7: rewritten from "no external frontends" to "external
    frontends require per-plugin operator opt-in." Trust source
    distinction table updated.
  - §3 manifest table: `frontendEntry` no longer "built-ins only";
    now "built-ins unconditional, externals require
    `policy.approved_frontend: true`."
  - §3 validation step 6: refuses external + frontendEntry only
    when policy.approved_frontend !== true (loudly, not silent
    drop).
  - §4: added `approved_frontend` to the policy example with its
    own paragraph; added a refusal bullet; expanded the CLI helper
    transcript to ask the frontend question separately with an
    explicit-trust-prompt block, plus `--frontend` / `--no-frontend`
    flags.
  - §11 audit log: `frontend_approved` field per plugin block.
  - §12 corpus: split the single `attempt-frontend-entry-external`
    test into two — unapproved (refused) and approved (loads).
  - §13: built-ins note their auto-`approved_frontend: true` via
    the shipped builtins policy.
  - §15: v2 iframe-isolation trigger sharpened to "first need to
    allow a frontend from a plugin the operator did **not** fully
    audit." V1 already supports audited-external frontends.
  - §16: PR 3J.2 renamed from "Built-in frontend bundling" to
    "Frontend bundling via virtual module (built-ins +
    policy-approved externals)." Vite plugin now reads both the
    shipped builtins policy and the operator's policy file. Added
    build-runtime parity check via `dashboard/dist/.plugins.json`.
- **2026-06-03 (revision 2.1, sanity pass)** — Final language pass
  to catch remaining "isolation"-tone overclaims:
  - §2.7 ("No external frontends"): "closes the dashboard XSS gap"
    → "closes the *external-plugin* path to mounting code in the
    dashboard origin" (a compromised built-in still has the same
    access as any other built-in).
  - §2.3 ("Trust = audit + capability shape"): stale reference to
    "lockfile attestation in §11" → "operator policy hash
    attestation (§4)" (lockfile attestation was removed in
    revision 2, this was a dangling pointer).
  - §3 intro: stale rationale "let `npm` lockfile-integrity protect
    both code and manifest" → policy-file hash covers both. No
    integrity scheme depends on the lockfile.
  - §4 ("loose" policy mode): "for operators who rely on lockfile
    integrity" → "for operators who treat the directory hash as
    the authoritative attestation" — same correction.
  - §12 intro: "asserts each violation is **detected and refused**"
    → asserts each test produces its *expected outcome* (refusal,
    audit signal, or documented limitation). Several attacks in
    the corpus are informational-only by design (prototype
    pollution after the snapshot, raw `fetch` import, import-time
    side effects); the intro now matches the table.
  - §16 CI bullet: "assert all gates fire" → "each case asserts
    its documented outcome from §12" — same correction.
- **2026-06-03 (revision 2)** — Updated after independent security
  reviews from Codex, Gemini, an external Claude code review, and
  user-supplied research (WordPress anti-pattern). Net changes:
  - Reframed §2 from "secure plugin system" to "audited trusted
    plugin system with capability-shaped APIs." Added explicit
    structural-tension paragraph contrasting Docker per-session
    isolation for agents with in-process plugin code. Added
    explicit "operator audit covers transitive deps" paragraph.
  - Added §4 "Operator policy file" — separates plugin-author
    request (manifest) from operator grant (policy). Replaces the
    broken lockfile-attestation scheme from revision 1 (npm
    `integrity` is tarball-hash, not directory-hash; the math
    didn't work).
  - **Option A confirmed**: external plugins cannot declare
    `frontendEntry` in v1. Built-ins keep their frontends. Closes
    the dashboard XSS gap until iframe isolation (v2). §3 step 6
    enforces; §13 implementation drops external frontend handling;
    §15 v2 trigger sharpened.
  - `db.scoped` raw SQL refused (§9). The regex-based prefix check
    in revision 1 was false confidence; honest fix is no raw SQL
    for `db.scoped`. Raw SQL needs `db.access` (built-ins only).
  - External plugins forbidden from declaring
    `integrations.read.decrypted` combined with `db.scoped` /
    `db.access` (§5, §3 step 9). The combination is effectively
    root.
  - `db.scoped` for external plugins now requires
    `VONZIO_ALLOW_SCOPED_DB_PLUGINS=1` opt-in. Default off.
  - `apiVersion` check now enforces major-equal + minor-≤, not just
    major-not-exceed. Catches forward-minor incompatibility.
  - Prototype-tampering detection downgraded from "refuse boot" to
    "log loudly" (§2.10, §14). Refusing boot would self-DoS on a
    legitimate-but-broken transitive dep; log-and-alert is the
    right framing.
  - §7 (membrane) and §9 (DB) gain explicit "this is hygiene, not
    a containment boundary; re-read §2" callouts at the top.
  - Several language tweaks throughout to remove overstated
    isolation claims ("plugin literally cannot reach" →
    "plugin is not given an API path to").
- **2026-06-03 (revision 1)** Initial draft. Captures the security
  review outcomes from Codex + Gemini + WordPress-anti-pattern
  research plus the original user-confirmed decisions (explicit
  env var, virtual module, `@vonzio/plugin-hello`, `outboundHosts`
  blocking, three-tier storage, lockfile attestation in v1).
