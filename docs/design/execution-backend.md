# Design: Pluggable execution backends

> Status: **draft for discussion.** Tracks vonzio/vonzio#334. Nothing here is
> built yet. Decisions marked "Proposed" are recommendations to settle in
> review, not commitments.

## TL;DR

Every conversation runs the agent inside its own Docker container on the same
host as the server. That is the right default and stays the default. This
document turns the existing `ContainerManager` interface into a deliberate
**execution-backend contract**, so the same agent can also run on a remote
Docker host, Railway Sandboxes, Daytona, E2B or a microVM runtime, without
forking the orchestrator.

The contract has to answer six questions. The proposed answers:

| # | Question | Proposed answer |
|---|----------|-----------------|
| D1 | How do the server and the agent talk? | The agent dials back to the server over one WebSocket ("runner link"). `docker exec` stays as the Docker backend's bootstrap only. |
| D2 | Who owns the workspace files? | The backend, plus a mandatory export/import so the server can persist a workspace when a backend destroys an idle sandbox. |
| D3 | What if a backend can't do something? | It declares capabilities; the orchestrator and UI degrade per capability. |
| D4 | How is egress enforced? | Either the backend enforces an allowlist natively, or the sandbox routes through vonzio's egress proxy. A backend that can do neither runs only with egress explicitly off. |
| D5 | How do previews and server endpoints get reached? | The backend resolves both directions: the server URL as seen from the sandbox, and a URL for a sandbox port as seen from the server. |
| D6 | How are backends packaged and chosen? | Docker and remote Docker built in; others as plugins on the plugin API. One backend per instance first, per agent later. |

Build order: refactor with Docker parity, then remote Docker (proves the seam
with no vendor), then Railway Sandboxes (after the spike), then hosted
plugins.

## Why now

Three concrete consumers, where a year ago there were none:

- **One-click cloud deploys.** Railway containers are non-privileged, so the
  current model cannot run there at all. Railway Sandboxes (isolated VMs with
  a TypeScript SDK) can host the agent, which makes a Railway template
  possible. Same story for most PaaS platforms.
- **Laptop plus remote compute.** Users who run the server on a laptop but
  want agents on a VPS or a beefier box: a remote Docker host.
- **Hosted sandboxes.** Daytona and E2B offer per-task sandboxes with SDKs;
  heavy playbook runs are a natural fit.

None of these should change the core architecture: the Claude Agent SDK keeps
running **inside** the sandbox and executes its own tools there (see
`docs/LOCAL_EXEC.md` §2). Only *where* the sandbox lives changes.

## What the server needs from a runner today

The interface is `ContainerManager` (`packages/shared/src/types/container.ts`),
implemented by `DockerContainerManager` and `NoopContainerManager`. Grouped by
what the server actually uses it for:

| Need | Today (Docker) | Main call sites |
|------|----------------|-----------------|
| Create, start, stop, remove a sandbox | Docker API through the socket proxy | `orchestrator.ts`, `container/pool.ts`, `ensure-running.ts` |
| Run the agent and stream its output | `execInContainer`: stdin carries one JSON task, stdout streams JSON lines | `orchestrator/agent-comms.ts` |
| Abort a turn without killing the sandbox | PID file + `kill` via exec | `agent-comms.ts` |
| Pause idle sandboxes, resume on demand | `pause` / `unpause` (#333) | `orchestrator.ts`, `ws/handler.ts` |
| Workspace and SDK state that survive restarts | Named volumes per session (`ws`, `sdk`, `docker`) | `orchestrator.ts`, `session-registry.ts` |
| File browser, uploads, downloads | `readFile`, `copyToContainer` (tar) | `routes/workspace-files.ts`, `skill-storage.ts` |
| Interactive terminal | PTY via exec | `routes/workspace-terminal.ts` |
| Live preview of an app in the sandbox | Server proxies to `containerIp:port` | `routes/preview.ts` |
| Which ports are listening | `listListeningPorts` | `routes/workspaces.ts` |
| Memory limits, usage and live resize | Docker update / stats (feature 0041) | `orchestrator.ts`, admission control |
| Why a sandbox died (e.g. OOM) | Inspect | `orchestrator.ts` |
| Warm pool for fast first turns | Pre-created idle containers | `container/pool.ts` |
| Docker inside the agent | DinD sidecar / `docker_access` mode | `orchestrator.ts` |

### Docker assumptions outside the interface

These are what make the interface Docker-shaped even though the orchestrator
never calls Docker directly:

- **Workspace = local named volumes.** Volume names are built in
  `session-registry.ts` and created from the orchestrator.
- **Networking.** The server reaches MCP endpoints, the egress proxy and
  previews over the internal Docker network (`INTERNAL_SERVER_URL`, container
  IPs). Egress enforcement relies on an internal network with no external
  route plus the shared `egress-proxy` and a signed per-container token
  (`orchestrator/egress.ts`).
- **The in-container gateway** listens on `127.0.0.1:11434` and is started by
  the agent's entrypoint; provider routing arrives as env vars. This part is
  already portable: it only needs outbound HTTPS.
- **Images.** `docker/Dockerfile.agent*` define the agent environment. A
  non-Docker backend needs the same environment built its own way (e.g. a
  Railway sandbox template).
- **The Noop manager fakes parity** by throwing or no-oping, which is the smell
  capabilities are meant to replace.

## Decisions

### D1. Transport: agent dials back (Proposed)

**Today:** the server starts the agent with `docker exec`, writes one JSON
task to stdin and reads JSON lines from stdout. Abort, reconnect and timeouts
are Docker-exec semantics.

**Options:**

1. *Keep exec everywhere.* Every backend implements a streaming exec with
   stdin. Railway's SDK can (durable sessions, stdin, reattach); others vary.
   Reconnect after a server restart stays backend-specific.
2. *Agent dials back.* The sandbox starts a small long-lived runner that opens
   one authenticated WebSocket to the server and receives tasks over it.

**Proposed: option 2, staged.** The runner link is the only thing that works
the same on every backend, including ones behind NAT or with no exec API. It
also gives one place for reconnect, heartbeats (which double as idle
keep-alives on billed backends), abort, and resuming a stream after a server
restart. Docker keeps using exec to *start* the runner, so the Docker backend
loses nothing.

Cost: the server must be reachable from the sandbox (see D5), and the link
needs its own auth: a per-sandbox token minted at create time, scoped to that
session, rotated on restart.

### D2. Workspace ownership: backend-owned, with export/import (Proposed)

**Options:**

1. *Backend-owned:* volumes on Docker, the sandbox disk or checkpoints on
   Railway. Fast, native.
2. *Server-owned:* the server stores the workspace and syncs it in and out.
   Portable, but slow for large trees and complex to keep consistent.

**Proposed: backend-owned, plus a required `exportWorkspace` /
`importWorkspace` (tar stream).** Backends that bill for idle time
(Railway: memory is billed while a VM waits) should destroy idle sandboxes,
not pause them. Export lets the server persist the workspace on its own
volume before destroy and restore it on the next turn. It also gives
migration between backends and backups for free.

What must survive vs. what is disposable:

| State | Durable? |
|-------|----------|
| `/workspace` (user files) | Yes |
| SDK session state (conversation resume) | Yes |
| Installed packages, caches, running dev servers | No; rebuilt or restarted |
| DinD images and containers | No |

### D3. Capabilities instead of fake parity (Proposed)

Each backend declares what it supports; the orchestrator and UI degrade per
flag instead of assuming Docker:

```ts
interface BackendCapabilities {
  persistentWorkspace: boolean;   // survives sandbox stop without export
  pauseResume: boolean;           // cheap freeze (Docker pause)
  memoryResize: boolean;          // live limit change (feature 0041)
  dockerInside: boolean;          // DinD / docker_access mode
  terminal: boolean;              // interactive PTY
  previewPorts: boolean;          // reach a sandbox port from the server
  egress: "native" | "proxy" | "none";  // see D4
  warmPool: boolean;              // pre-create idle sandboxes (real cost on hosted)
  billedWhileIdle: boolean;       // drives destroy-vs-pause policy
}
```

Examples of degradation: no `dockerInside` hides the Docker access toggle on
agents; no `memoryResize` hides the memory slider; `billedWhileIdle` switches
the idle policy from pause to export-and-destroy.

### D4. Egress (Proposed)

Egress enforcement is on by default since v0.5.16, so every backend needs an
answer:

- **`proxy`:** the sandbox routes outbound traffic through vonzio's
  `egress-proxy` (the `HTTPS_PROXY` + signed token mechanism already used on
  Docker). Requires the proxy to be reachable from the sandbox and direct
  egress to be blocked by the backend's own network isolation.
- **`native`:** the backend enforces a host allowlist itself; vonzio passes
  the same allowlist (built-in hosts, model endpoint, `EGRESS_ALLOWED_HOSTS`,
  per-agent list).
- **`none`:** the backend can't enforce. It runs only when the operator sets
  `EGRESS_ENFORCEMENT=0`, and the dashboard says so.

The Railway spike must find out which of the three Railway Sandboxes can do.

### D5. Reachability in both directions (Proposed)

Two URLs the backend must resolve:

- **Server as seen from the sandbox:** for the runner link (D1), MCP
  endpoints, and the egress proxy. Docker: the internal network. Remote Docker:
  an SSH reverse tunnel or an overlay such as Tailscale. Railway: the project's
  private network. Hosted sandboxes: a public server URL (pairs with the
  trusted-access work: Tailscale or a tunnel).
- **A sandbox port as seen from the server:** for live preview. Docker:
  container IP. Railway and Daytona: the platform's per-port domain or private
  address. The preview proxy keeps its auth and rewriting; only the upstream
  address comes from the backend.

### D6. Packaging and selection (Proposed)

- The contract moves to `@vonzio/plugin-api` so backends can ship as plugins.
- **Built in:** `docker` (reference, default) and `docker-remote`
  (`DOCKER_HOST` over SSH or TLS).
- **Plugins:** `railway-sandboxes`, `daytona`, `e2b`, community backends.
- **Selection:** `EXECUTION_BACKEND=<id>` per instance first. Per agent later
  (chat agents local, heavy playbooks on a hosted backend), which needs the
  scheduler to know a session's backend for its whole life.
- **Non-goal:** one session spanning two backends.

## Proposed contract (sketch)

```ts
interface ExecutionBackend {
  id: string;
  capabilities(): BackendCapabilities;

  // Lifecycle
  create(spec: SandboxSpec): Promise<SandboxHandle>;  // image/template, env, resources, egress
  get(sandboxId: string): Promise<SandboxHandle | null>;
  list(): Promise<SandboxInfo[]>;                     // orphan sweep

  // Workspace (D2)
  exportWorkspace(sandboxId: string): Promise<ReadableStream<Uint8Array>>;
  importWorkspace(sandboxId: string, tar: ReadableStream<Uint8Array>): Promise<void>;

  // Reachability (D5)
  serverUrlFromSandbox(): Promise<string>;
  portUrl(sandboxId: string, port: number): Promise<string | null>;
}

interface SandboxHandle {
  id: string;
  status(): Promise<"running" | "paused" | "stopped" | "gone">;
  startRunner(link: RunnerLinkConfig): Promise<void>;  // D1: boots the runner that dials back
  stop(): Promise<void>;
  destroy(): Promise<void>;
  pause?(): Promise<void>;                              // capability-gated
  resume?(): Promise<void>;
  files: { read(path: string): Promise<Uint8Array>; write(dir: string, files: FileSpec[]): Promise<void> };
  terminal?(opts: TerminalSessionOptions): Promise<TerminalSession>;
  listeningPorts?(): Promise<number[]>;
  memory?: { limit(): Promise<number>; usage(): Promise<number>; resize(bytes: number): Promise<void> };
  exitReason(): Promise<{ oomKilled: boolean; exitCode: number | null } | null>;
}
```

`ContainerManager` becomes the Docker backend's internal API; the
orchestrator, routes and pool talk only to `ExecutionBackend`.

## Candidate backends

| Backend | Fit | Notes |
|---------|-----|-------|
| **Docker (local)** | Reference | Unchanged behavior; all capabilities. |
| **Docker (remote host)** | First proof | Same semantics over `DOCKER_HOST`. Gaps it exposes: server reachability (tunnel), preview upstreams, volume locality. No vendor bet. |
| **Railway Sandboxes** | Unlocks the Railway template | Isolated VMs; templates and checkpoints for the agent image; durable exec with stdin; idle timeout + heartbeat; per-port domains; private network. Billed while idle, checkpoint count capped by plan. Spike on the board measures cold start and cost. |
| **Daytona, E2B** | Hosted plugins | Per-task sandboxes with SDKs and preview URLs. Good for heavy playbooks; needs a public server URL. |
| **Firecracker / Kata** | Isolation upgrade | Better as a Docker *runtime* option (Kata, firecracker-containerd) for self-hosters who want VM-grade isolation than as a separate backend. Mostly configuration, little code. |

## Security model

`docs/SECURITY_MODEL.md` states guarantees scoped to a host kernel. Each
backend must document its own:

- isolation primitive (namespaces, VM, platform sandbox);
- where workspace data lives and who can read it (your host vs. your account
  on a provider);
- how the runner-link token and provider credentials reach the sandbox, and
  that they never cross sessions;
- egress mode (D4).

Marketing copy must follow the backend: "your box" for Docker, "your Railway
account" for Railway.

## Plan

1. **P0 (this doc):** settle D1 to D6 in review.
2. **P1, refactor with parity:** introduce `ExecutionBackend`, wrap Docker
   behind it, move volume naming and network setup inside the Docker backend,
   add capabilities. No behavior change; e2e-full must stay green.
3. **P2, runner link:** the dial-back transport, used by Docker too once it
   matches exec on latency and abort behavior.
4. **P3, remote Docker backend** behind `EXECUTION_BACKEND=docker-remote`.
5. **P4, Railway Sandboxes backend** if the spike says go; then the Railway
   template (server + Postgres + `RAILWAY_API_TOKEN`).
6. **P5, publish the contract** in `@vonzio/plugin-api`; hosted backends as
   plugins.

## Open questions

- **Latency budget.** Runner start plus MCP round trips over a WAN: what is
  acceptable for a first token? The Railway spike gives the first numbers.
- **Warm pool on hosted backends.** A warm sandbox costs money; probably a
  Docker-only optimization, with checkpoints as the hosted equivalent.
- **Per-agent backends** need the scheduler, admission control and the session
  registry to track a backend per session. Worth it only once two backends are
  in real use.
- **Server reachability for hosted backends** depends on the trusted-access
  work (Tailscale, tunnels). Order those together.
