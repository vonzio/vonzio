# Design: Externalizing Vonzio's MCP Servers

> Status: PLAN ONLY (no code). Lets external agents / third-party MCP clients call
> Vonzio's MCP servers using durable `rc_*` personal API tokens. Author: PM-delegated
> multi-agent design pass, 2026-06-28.

## TL;DR

The MCP servers are *already* HTTP JSON-RPC routes (`/mcp/{platform,memory,notify,gmail,localfs}`).
They are "internal" only because (a) auth is an **ephemeral, in-memory, per-task token**
that no external party ever holds, and (b) the routes aren't published through public ingress.

Externalizing = four changes, all building on existing seams:
1. **Auth bridge** — make MCP route auth fall back to the durable `rc_*` `TokenValidator`.
2. **Scope model** — a new per-token capability column (`mcp_scopes`), default-deny.
3. **Surface tiering** — expose a safe read-only subset first; structurally exclude RCE-class tools.
4. **Ingress + tenancy** — a separate public route; pin org via the existing `resolveOrgIdForUser` seam.

No new tenancy seam is required — `runForPrincipal` + `resolveOrgIdForUser` already exist (OSS-defined, cloud-supplied).

---

## 1. Current state (grounded)

- 5 hand-rolled Fastify routes, no `@modelcontextprotocol/sdk` dep. Each: `initialize` →
  hard-coded `protocolVersion: "2024-11-05"`, `tools/list`, `tools/call`. Plain JSON POST
  (no SSE, no GET, no `Mcp-Session-Id`, no `Origin` check). `memory-mcp.ts:174-233` is the
  canonical shape; the other 4 are copy-paste.
- Auth: `Authorization: Bearer <token>` → per-server `resolveSession(token)` wired in
  `server.ts:805-864` to the orchestrator's **in-memory** token maps (`mem_/notify_/gmail_/
  platform_/localfs_<nanoid>`), minted per task in `orchestrator.ts:1329-1417`, swept on task end.
- `orgId` is captured at mint from `taskOrgId` — so the internal path never needs `runForPrincipal`.
- Durable credential `rc_*` (`api_tokens` table, `TokenValidator`) is used by REST + WS auth,
  but **never consulted by the MCP routes**. This is the core gap.
- Egress (feature 0005): agents reach internal `http://server:3000/mcp/*` directly via
  `noProxyHosts`. Public ingress = Traefik host-router → `server:3000`, no path routing today.

## 2. Auth bridge (the enabling change)

In the `resolveSession` seam (`server.ts`, type at `platform-mcp.ts:61`): two-stage resolver.
1. ephemeral in-memory lookup (unchanged hot path);
2. else if `token.startsWith("rc_")` → `tokenValidator.validate(token)` →
   synthesize session `{ userId, profileId, orgId, sessionId, capabilities }`.

Consequences:
- `resolveSession` becomes **async** (ephemeral branch stays sync-fast; only `rc_` hits DB).
- Inject `tokenValidator` into MCP plugin options (already a `CoreDeps` seam).
- `profileId`: default profile, or explicit `?profile=` validated against `allowedProfileIds`.
- `orgId`: OSS → `null`; cloud → `await coreDeps.resolveOrgIdForUser(userId)`, wrapped in
  `runForPrincipal({userId}, fn)` so async-context org scoping is also satisfied.
- `sessionId`: surrogate `apitoken:<tokenId>` for audit.
- `capabilities`: from the token's `mcp_scopes`, NOT from a profile.
- Reuse `ValidatedToken.rateLimitRpm` via the existing `SlidingWindowRateLimiter`, keyed on `tokenId`.

## 3. Scope model (default-deny)

Add OSS column: `apiTokens.mcp_scopes jsonb null` (idempotent `ADD COLUMN IF NOT EXISTS` migration).
- `null` (default for all existing tokens) → **no MCP access**. Safe by default.
- populated array → reuses the existing `TOOL_DEFINITIONS[].group` vocabulary, fed into the
  *same* capability filter platform-mcp already runs (`tools/list` `:1507`, `tools/call` `:1523`).
- Carry `mcpScopes` through `ValidatedToken` + `DefaultTokenValidator`.
- Issuance UI/routes accept scopes; a token minted without scopes is MCP-denied.

## 4. Surface tiering (what to expose)

- **Tier 0 — never external (structural allowlist exclude):** all of `local-fs` (host RCE, CLI-WS-bound,
  no coherent external principal); the write/exec half of `platform` (task/playbook/subagent/skill
  create-run-update-delete, workspace terminate/delete, profile writes, preview_set_access).
- **Tier 1 — safe subset, ship first:** `memory` reads, `notify_user` (rate-limited), platform
  **read-only** tools (`*_list/get/events/transcript`) = the roadmap "workspace observability MCP".
- **Tier 2 — write-capable, opt-in per token:** `memory_write/update/delete`, gmail reads, `gmail_create_draft`.
- **Tier 3 — rarely-granted, loud + audited:** `gmail_send_message`, `slack_post_message`, scoped `task_submit`.

Mechanism: add `audience: "internal"|"external"` to the resolved session; internal keeps
default-allow (untagged tool visible), external flips to **default-deny** (untagged unreachable).
Generalize the platform-mcp group filter into a shared `mcp/tool-gate.ts` applied to all routes.

**v1 ship = Tier 1 only.** Exclude localfs, all platform writes, gmail entirely.

## 5. Network + tenancy

- **Separate public surface**, do NOT publish existing `/mcp/*`. Recommend path prefix
  `/mcp-ext/*` (or `/v1/mcp/*`) on a higher-priority Traefik router → `server:3000`; optional
  `mcp.${DOMAIN}` subdomain on cloud later. Internal routes only accept session tokens;
  external route only accepts `rc_*` (cross-use rejected).
- Egress invariant untouched: external ingress is consumed from outside the Docker net, never
  traverses the egress proxy. Do NOT leak `${DOMAIN}`/`mcp.${DOMAIN}` into agent egress allowlists.
- Exclude the new host/path from the vonz.io→vonzio.com canonical redirect (`.saas` overlay gotcha).
- OSS/cloud split: route + `rc_*` auth + scope column + flag (`MCP_EXTERNAL_ENABLED`, default OFF in
  OSS like `EGRESS_ENFORCEMENT`) all in `vonzio/`. Cloud only: Traefik labels, flag=1, plan-aware
  rate-limit override. **Zero new tenancy code in cloud** (`resolveOrgIdForUser` already wired).

## 6. Protocol / client compat

- Static `rc_*` bearer works with config-file clients (Claude Code/Desktop `.mcp.json`) — the 80% path.
- Phase-1 fixes to be spec-shaped: return **HTTP 401 + `WWW-Authenticate`** on bad/missing token
  (today: JSON-RPC -32000 with HTTP 200); add **GET → 405**; **negotiate protocolVersion** (echo
  client's, support up to `2025-06-18`) instead of hard-coding; add `Origin`/CORS validation.
- Phase-2 (optional, defer): full OAuth 2.1 Resource Server + `/.well-known/oauth-protected-resource`
  for discovery-driven connectors (Claude Desktop connector store, ChatGPT). Only if those are a target.
- Discovery: per-token `GET /mcp` listing the servers/tools that token may use (absolute URLs).
- Treat externally-exposed tool names/schemas as a semver contract; add a regression test.
- Centralize the 5 copy-paste handlers into `createMcpRoute(handler)` to stop version/auth drift.

Client config example:
```jsonc
{ "mcpServers": { "vonzio-memory": {
  "type": "http", "url": "https://HOST/mcp-ext/memory",
  "headers": { "Authorization": "Bearer rc_..." } } } }
```

## 7. Cross-cutting risks / open questions

1. **External token lifecycle** — `rc_*` is long-lived/revocable; ephemeral tokens were task-bounded.
   Need TTL/rotation/revocation-on-every-call story. Biggest unspecified piece.
2. **TokenValidator perf** — was O(n) bcrypt scan; MCP is chattier. Confirm hashed-lookup validator +
   short-TTL validation cache before `/mcp/*` traffic.
3. **profile/sessionId for stateless callers** — default vs explicit profile; audit when no session.
4. **gmail read sensitivity** — full-mailbox exfil; arguably Tier 3 even for reads.
5. **Rate-limit window sharing** — one `rate_limit_rpm` shared by task-submit + MCP, or split?
6. **Post-sync smoke** — after `sync-oss`, build cp-server + smoke an external call that creates a
   workspace (the org_id-NOT-NULL failure class) before tagging deploy.

## 8. Suggested phasing

- **Phase 0 (this doc):** design — DONE.
- **Phase 1:** auth bridge + `mcp_scopes` column + `tool-gate.ts` + Tier-1 read-only surface
  (memory reads, notify, platform read-only) behind `MCP_EXTERNAL_ENABLED` (off). Spec-shaped
  401/405/version. `/code-review`, then STOP for eyeball.
- **Phase 2:** ingress (Traefik route) + cloud org-pin wiring + per-token discovery endpoint. Smoke on SaaS.
- **Phase 3:** Tier-2 (writes, gmail reads) with audit; optional OAuth discovery.
