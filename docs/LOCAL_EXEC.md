# Local-exec mode — design & spike plan (`vonzio chat --local-exec`)

> Status: **design draft, not yet scheduled.** OSS seam first; cloud consumer + security
> review gate before any GA. Author: design session 2026-06-24.

## 1. Goal

Let a user run `vonzio chat --local-exec .` so the **cloud (or any) Vonzio server stays the
"brain"** — model routing, provider creds, history, knowledge base, goal-loop — while the
agent's **filesystem + shell operate on the user's local project** at full speed, with files
never leaving the machine in bulk.

This is "Option D" from the design discussion: *local exec, cloud brain, explicit boundary.*
It is **OSS by construction** — every server-side piece is shared runtime that lives in
`vonzio/` and the CLI is already instance-agnostic. The cloud only adds the things it already
owns (tenancy pinning, billing, managed creds).

## 2. The load-bearing constraint (read this first)

Vonzio **does not sit in the agent's tool-execution loop.** The agent is a Claude Code SDK
run *inside* the per-session container; the SDK executes `Bash`/`Read`/`Write`/`Edit` itself
against the container filesystem. The orchestrator only *observes* tool use (it emits
`task:tool_use` events, `orchestrator.ts:1654`) — it does not mediate execution.

Consequence: **there is no "intercept the Bash call and forward it" seam to add.** To make the
agent operate on local files we must change *what the SDK's tools are bound to*. Two viable
mechanisms:

| Mechanism | How | Verdict |
|-----------|-----|---------|
| **A. Reverse FS mount** — container mounts the laptop's project over the tunnel (FUSE/9p/sshfs), built-in Bash/Edit run in-container against the mount | Transparent to the SDK; agent uses normal tools | Heavy: per-session tunnel mount, latency on every stat/read, fragile across NAT, big security surface. **Rejected for v1.** |
| **B. MCP tool swap** — disable the SDK's built-in FS/shell tools; inject `local_bash` / `local_read` / `local_write` / `local_edit` MCP tools that proxy to an executor in the CLI | Reuses the platform-MCP pattern already in the codebase; explicit, auditable, per-tool gating | **Chosen for v1.** |

v1 = **B**. The agent's working directory *concept* lives on the laptop; the container becomes
a thin host for the SDK. (A stays on the roadmap for a future "transparent" mode if latency of B
proves annoying for read-heavy work.)

### S0 feasibility (verified 2026-06-24 against agent-sdk 0.3.161) — two findings that shape B
1. **Tool swap is honored.** The SDK respects `allowedTools` as a strict allowlist — the goal-loop
   **judge** already runs with `allowedTools: ["Read","Grep","Glob"]` and cannot write. So a
   `cli-local` session sets `allowed_tools` to **exclude** built-in `Bash/Edit/Write/Read` and
   include only `mcp__local-fs__*`. No SDK fork, no hook gymnastics.
2. **The bridge is server-hosted, NOT in the agent-runner.** The agent-runner is **one-shot**: it
   reads a *single* JSON line on stdin and only streams messages *out* on stdout
   (`agent-runner/src/index.ts`; orchestrator writes stdin once, `agent-comms.ts:92`). There is
   **no inbound mid-run channel into the container** — `ask_user` ends/parks the turn, it is not a
   blocking round-trip. Therefore the `local-fs` tool handlers must NOT live in-process in the
   agent-runner (they'd have nowhere to send the call). Instead `local-fs` is a **server-hosted
   HTTP MCP**, injected exactly like platform-mcp is today (`{ url: localFsMcpUrl, headers: {
   Authorization: Bearer <perTaskToken> } }`, orchestrator ~`:1236`). The in-container agent makes
   an ordinary MCP HTTP call over the internal network; the *server* — which already holds the
   session WS — fans that call out as `localtool.call`, blocks on `localtool.result`, and returns
   it as the MCP tool result. **The container and agent-runner need no changes** beyond receiving
   the extra allowed-tool names + one more MCP server URL (both already orchestrator-driven).

## 3. Architecture (mechanism B)

```
  ┌─ laptop ────────────────┐    WS /v1/stream     ┌─ server (OSS or cloud) ──────────────────┐
  │ vonzio CLI               │ session.start        │ ws/handler.ts: surface:cli-local         │
  │  ├ chat TUI              │ caps:[local-exec] ──▶ │ orchestrator: allowed_tools = local_* ;  │
  │  └ local executor        │                      │   inject local-fs HTTP MCP (url+bearer)  │
  │     • cwd = ./project    │ ◀ localtool.call ──── │ ┌─ local-fs MCP (server-hosted) ───────┐ │
  │     • 3 permission modes │ ─ localtool.result ─▶ │ │ handler: fan to session WS, await res│ │
  │     • runs bash/read/... │                      │ └──────────────▲───────────────────────┘ │
  └──────────────────────────┘                      │   MCP HTTP call│ (internal net, bearer)   │
                                                     │   ┌─ container: agent (Claude Code SDK) ─┐ │
   files stay local; only tool I/O crosses          │   │ built-in Bash/Edit/Read/Write OFF     │ │
   creds/model/history stay server-side             │   │ only mcp__local-fs__* allowed         │ │
                                                     │   └───────────────────────────────────────┘ │
                                                     └───────────────────────────────────────────┘
```
Note the inbound channel is **server↔CLI over the WS**, never server↔container. The container
makes a stateless MCP HTTP call (like platform-mcp) and the server is the one holding the WS.

### Frame additions (WS `/v1/stream`)
Extend the existing discriminated union (`ws/handler.ts` `switch (msg.type)`):

- `session.start` → add optional `capabilities: ["local-exec"]` and `local_root` (display only;
  the path is never trusted server-side, it's the CLI's own cwd label).
- **server→client** `localtool.call` `{ call_id, tool: "local_bash"|"local_read"|"local_write"|"local_edit", input }`
- **client→server** `localtool.result` `{ call_id, ok, output?, error?, exit_code? }`
- **client→server** `localtool.deny` `{ call_id, reason }` (user rejected at the confirm gate)

These mirror the request/response shape of the existing `session.answer` round-trip, so the
connection-manager plumbing is reused.

### Server seam (all in `vonzio/`, OSS)
1. **`surface:cli-local`** — new surface value. Drives a system-prompt note (reuse the
   `surface:cli` note muscle from `project_cli_exec_and_surface`): *"Your file and shell tools
   execute on the USER'S machine at `<root>`, which is outside this container's sandbox. Confirm
   before destructive operations; the user may reject any call."*
2. **Server-hosted HTTP MCP `local-fs`** — `local_bash/read/write/edit`, hosted on the server and
   injected into the task payload as a URL+bearer MCP server exactly like platform-mcp
   (orchestrator ~`:1236`), gated on `surface:cli-local`. Each tool handler runs **on the server**,
   emits `localtool.call` over the session WS, and awaits the matching `localtool.result`. The
   orchestrator removes built-in `Bash`/`Read`/`Write`/`Edit` from `allowed_tools` and adds the
   `mcp__local-fs__*` names, so the agent cannot silently touch the container FS. **The agent-runner
   is unchanged** (see S0 finding 2: it has no inbound mid-run channel, so the handler cannot live
   in-process there).
3. **Knowledge / workspace files** still resolve server-side (the `/knowledge` mount is the
   server's, not the laptop's) — only the *project* tools localize.

### CLI seam (in `cli/`, OSS, published)
- **Local executor** with three modes mirroring the egress deny-by-default philosophy:
  - `read-only` — `local_read`/`local_bash`(non-mutating allowlist) only; writes auto-denied.
  - `confirm` (**default**) — every write/edit/exec shows a diff/command preview + y/n gate.
  - `trusted` — no per-call gate (still bounded to `cwd`, still killable).
- Persistent footer: current mode + `local_root` + a kill key. Path-escape guard: reject any
  resolved path outside `cwd` (no `../` breakout, no abs paths outside root).
- Reuses the container-exec hardening already specced (exit codes, kill-on-timeout, output caps)
  — same executor, pointed at the host instead of `docker exec`.

## 4. OSS vs cloud split

- **OSS ships the whole mechanism** — CLI executor + WS frames + `surface:cli-local` + the
  `local-fs` MCP pack all live in shared runtime / the CLI repo. A self-hoster runs
  `vonzio chat --local-exec .` against their own `localhost:3000` and it works end to end.
- **Cloud adds only what it already owns:** org/tenancy pinning for the session
  (`runForPrincipal` seam — itself OSS, consumed by cloud), billing, managed provider creds
  (the selling point: `sk-ant-…` stays server-side, never on the laptop).
- **vs Option C** (agent container on the user's own Docker): C is the more self-host-native
  mode. For a self-hoster whose server is already `localhost`, C and D nearly converge — the
  only difference is *where the container runs*. Offer both from one codebase later; D first
  because it's the one that also serves SaaS.

## 5. Security review gate (blocking — do not GA without it)

This inverts the trust model: the server now drives execution on a user's machine. Per
`feedback_security_flexibility_scrutiny`, bake the controls in at design time:

- **Default-deny:** `confirm` mode is the default; `trusted` is an explicit opt-in flag per
  session, never sticky across instances.
- **Capability-gated:** `local-exec` only active when the *client* advertised the capability AND
  the user passed `--local-exec`. Server can never initiate it.
- **Bounded:** all paths confined to `cwd`; path-escape + symlink-escape guard; output/time caps.
- **Audited:** every `localtool.call`/`result`/`deny` appended to the event log (already the
  transport), so there's a full local-action trail.
- **Creds boundary:** provider keys never sent to the CLI; the laptop holds no model creds.
- **Kill switch:** one keypress ends local-exec and the session.
- Run a `/code-review ultra`-grade pass on the executor + the MCP proxy + the path guard before
  GA. Treat the path-escape guard as the highest-risk unit — fuzz it.

## 6. Spike plan (independently shippable slices)

**S0 — proof of latency (throwaway).** Wire one `local_bash` MCP tool over the WS against a
hardcoded `echo`/`pwd`; measure round-trip laptop↔server↔SDK. Decide if B's per-call latency is
tolerable for read-heavy sessions (if not, revisit A sooner). *No UI, no gating.*

**S1 — OSS happy path.** `surface:cli-local` + the full `local-fs` MCP pack (`read/write/edit/bash`)
+ CLI executor in **confirm mode only** + path guard + footer. Demo: `vonzio chat --local-exec .`
against `localhost:3000` reads a file, proposes an edit, runs a test — all on local disk. This is
the **independently demoable OSS milestone**; stop here for the per-feature review gate.

**S2 — modes + hardening.** Add `read-only`/`trusted` modes, kill switch, output/time caps,
event-log audit lines. Security review pass here.

**S3 — cloud consumer.** Tenancy pinning via `runForPrincipal`, billing meter for local-exec
sessions, "keys stay server-side" messaging. Sync OSS seam → cloud, smoke, then deploy.

**S4 (roadmap).** Mechanism A transparent-mount mode for read-heavy work; `vonzio chat --local`
(Option C) as a sibling self-host mode.

## 7. Open questions

- ~~Does the SDK let us remove built-in `Bash`/`Edit` while adding MCP equivalents?~~
  **Resolved (S0):** yes — `allowedTools` is an honored allowlist (judge proves it). Mechanism B
  stands, with `local-fs` server-hosted (not in-agent-runner). Remaining unknown: does the model
  *behaviorally* adapt to `mcp__local-fs__local_bash` as readily as native `Bash` (naming/prompt
  affordance), or does the renamed tool degrade tool-use quality? S1 should eyeball this.
- Per-call confirm latency on a 50-edit refactor — batch-approve UX? (a "trust this run" escalate
  from `confirm`→`trusted` mid-session).
- Big-output streaming (`local_bash` running `pnpm build`) — stream chunks vs. one result frame.
- Multi-root / monorepo: single `cwd` for v1; revisit.
```
