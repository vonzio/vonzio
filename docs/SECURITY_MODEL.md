# Security model

This document describes vonzio's security boundary: what we protect, what
we explicitly do **not** protect, and where the trust roots sit. Read it
before deploying vonzio anywhere that handles data you'd be unhappy
losing.

For instructions on **reporting a vulnerability**, see
[SECURITY.md](../SECURITY.md).

For instructions on **hardening a deployment** beyond the defaults, see
[HARDENING.md](./HARDENING.md).

## TL;DR

vonzio runs agents in **Docker containers, not microVMs**. The host
kernel is shared between the host, core-server, and every agent
container. We provide strong application-layer tenant isolation (org
scoping, credential encryption, auth gates) but we do **not** provide
kernel-level isolation against malicious code running inside an agent
container.

**Use vonzio if:** you're a single user, a trusted team, or a small
organization running agents on infrastructure you own, with code and
prompts you trust.

**Do not use vonzio (without further hardening) if:** you intend to run
arbitrary untrusted code, host hostile multi-tenant workloads, or
operate in a regulated environment that requires hardware-level
isolation.

The [HARDENING.md](./HARDENING.md) guide describes the changes — gVisor
runtime, docker-socket-proxy, network policies — that close the gap for
higher-trust deployments.

## What we protect

These are the guarantees vonzio's code is designed and tested to
provide. Bugs in any of these are in-scope for security reports.

- **Tenant isolation at the application layer.** Every request resolves
  to an active organization context that is propagated via
  AsyncLocalStorage to every downstream service. Workspaces, profiles,
  credentials, memories, and playbooks are filtered by org id at the
  query layer. A user in org A cannot read or mutate org B's data via
  the API.
- **Credential encryption at rest.** API keys, OAuth tokens, and
  integration secrets are encrypted with AES-256-GCM. Per-record
  salt and IV; the master key is derived via HKDF from
  `BETTER_AUTH_SECRET`. Plaintext only exists in memory during request
  handling.
- **Authentication on every data-plane route.** Better Auth gates all
  routes except `/health`, `/setup` (one-time bootstrap), and the
  public widget endpoint (which is scoped to a single profile and
  bearer-protected).
- **No default admin credentials.** First-run lands on `/setup`; no
  default username or password ships in the image.
- **CSRF protection** on cookie-authenticated routes.
- **Signed widget tokens** for embedded chat sessions, scoped per profile.

## What we do NOT protect against

These are explicitly out of scope for the OSS default configuration.
Reports about these classes of issue will be acknowledged but closed as
"by design" unless they describe a way to *amplify* the impact beyond
what's documented here.

- **Container escape via kernel exploit.** Agent containers share the
  host kernel. A kernel-level exploit inside an agent container can
  reach the host. Mitigation: deploy with gVisor or Kata Containers
  (see [HARDENING.md](./HARDENING.md)).
- **Malicious or untrusted code executed by the agent.** If your agent
  is allowed to run arbitrary code (shell, `npm install`, etc.) and is
  prompted by an untrusted party, that code runs with the agent's
  privileges inside the container. Treat agent prompts as a code
  injection surface.
- **Side-channel attacks** (Spectre, Meltdown, cache timing, etc.). Out
  of scope for shared-kernel containers in general; a hardware-isolation
  backend is the only mitigation.
- **The Docker daemon's privilege boundary.** core-server has access to
  the Docker socket. A core-server compromise implies Docker daemon
  compromise, which implies host root. Reduce blast radius with
  docker-socket-proxy (see HARDENING.md).
- **A compromised host.** vonzio assumes the host running it is trusted
  and patched. We do not defend against an attacker with root on the
  host.
- **Denial of service.** Resource limits on agent containers are
  best-effort (cgroup-based). vonzio does not implement billing-style
  rate limits or fair scheduling for the OSS configuration.

## Trust boundaries

```
┌────────────────────────────────────────────────────────────────────┐
│  Host (TRUSTED)                                                    │
│                                                                    │
│  ┌──────────────────────┐         ┌──────────────────────┐         │
│  │  core-server          │ exec   │  Agent container      │         │
│  │  (TRUSTED)            │───────▶│  (SEMI-TRUSTED)       │         │
│  │                       │        │                       │         │
│  │  - has Docker socket  │        │  - shares host kernel │         │
│  │  - has DB credentials │        │  - has bind-mounted   │         │
│  │  - has all OAuth      │        │    workspace dir      │         │
│  │    tokens (decrypted  │        │  - has API key for    │         │
│  │    in memory)         │        │    its own LLM call   │         │
│  └──────────────────────┘         └──────────────────────┘         │
│                                                                    │
│  ┌──────────────────────┐                                          │
│  │  Postgres             │                                          │
│  │  (TRUSTED data store) │                                          │
│  └──────────────────────┘                                          │
└────────────────────────────────────────────────────────────────────┘
```

- **Host** is the root of trust. Postgres, secrets in `.env`, and the
  Docker daemon all live here. Anyone with root on the host can read
  everything.
- **core-server** is fully trusted. It holds the master encryption key,
  the Docker socket, and the database credentials. A core-server RCE
  is total compromise.
- **Agent containers** are semi-trusted. They have the credentials they
  need for their own session (one LLM API key, the workspace dir), but
  not the master key, not other tenants' credentials, not the Docker
  socket. Treat the inside of an agent container as compromised if you
  cannot vouch for the prompts or code it runs.
- **Plugins** (Phase 3, planned) run in-process with core-server. A
  malicious plugin is equivalent to a core-server compromise. Only
  install plugins from sources you trust.

## Known limitations in the current release

The following are known weaknesses we are actively hardening. They are
documented here so deployers can make informed decisions; the project
roadmap tracks fixes.

- The agent container image grants the in-container user passwordless
  `sudo`. This will be narrowed or removed in v0.2.
- core-server has direct access to `/var/run/docker.sock`. A
  docker-socket-proxy is on the v0.2 roadmap.
- The reference `docker-compose.yml` ships with fallback secret strings
  for development. The installer overwrites these; production users who
  run `docker compose up` directly without `.env` get insecure
  defaults. Fail-fast required-secret syntax is on the v0.2 roadmap.

See the [HARDENING.md](./HARDENING.md) guide for mitigations available
today.

## Reporting issues

Report vulnerabilities privately via the process in
[SECURITY.md](../SECURITY.md). Issues that fall in the "What we do NOT
protect against" section above are not vulnerabilities by themselves;
please describe a concrete amplification beyond the documented behavior
before reporting.
