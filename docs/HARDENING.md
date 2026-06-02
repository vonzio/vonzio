# Hardening guide

vonzio's default configuration targets single-tenant and trusted-team
use. The [security model](./SECURITY_MODEL.md) documents what that
posture protects against and what it does not.

This guide describes opt-in changes that strengthen the deployment for
higher-trust scenarios — running agents that handle sensitive data,
operating in regulated environments, or accepting input from sources
you don't fully trust.

None of these changes are required for vonzio to work. They are stack
on top of the defaults; pick the ones that match your threat model.

## Quick checklist

- [ ] Run agent containers under gVisor or Kata Containers
- [ ] Front the Docker socket with `docker-socket-proxy`
- [ ] Set restrictive egress firewall rules on agent containers
- [ ] Rotate `BETTER_AUTH_SECRET` and OAuth client secrets on a schedule
- [ ] Encrypt the Postgres data volume at rest
- [ ] Terminate TLS in front of core-server (reverse proxy or load balancer)
- [ ] Pin agent base images to specific digests, not tags
- [ ] Monitor `agent_runs`, `audit_log`, and Docker daemon logs
- [ ] Restrict who can install plugins (Phase 3, when shipped)

## Kernel-level isolation (gVisor)

The single most impactful change for an untrusted-workload deployment.
gVisor intercepts syscalls in userspace and runs them against a
minimal in-process kernel, dramatically reducing the attack surface
exposed to container code.

Install gVisor on the host (see
[gVisor install docs](https://gvisor.dev/docs/user_guide/install/)),
then either set the agent container runtime to `runsc` per-launch or
make it the default runtime in `/etc/docker/daemon.json`:

```json
{
  "runtimes": {
    "runsc": { "path": "/usr/local/bin/runsc" }
  },
  "default-runtime": "runsc"
}
```

Trade-offs: ~5-15% syscall overhead, some syscalls unsupported (most
agent workloads don't hit them), cold-start a few hundred ms slower.

Kata Containers (lightweight VMs) is the alternative if gVisor's
syscall compatibility is a blocker. Higher overhead, stronger
boundary.

## Docker socket access (default-on as of v0.2)

The reference compose stack ships with
[docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)
in front of `/var/run/docker.sock`. core-server talks to the daemon
over TCP (`DOCKER_HOST=tcp://docker-proxy:2375`) and the proxy enforces
a narrow verb allowlist — CONTAINERS, EXEC, IMAGES, VOLUMES, EVENTS,
PING. Everything else (NETWORKS, BUILD, SWARM, SYSTEM, SECRETS, …) is
default-deny.

Net effect: a core-server RCE can no longer reconfigure the daemon,
pull-then-run arbitrary privileged images, manipulate networks, or
read Swarm secrets. It can still create and exec into containers,
which on a default Docker install can still be used to escape to the
host via privileged flags or host-path binds in the image spec. To
close that residual gap, layer gVisor (above) on top of the proxy.

**To tune the allowlist** (e.g. you write your own integration that
needs `NETWORKS`), edit the `docker-proxy` service's environment block
in `docker/docker-compose.yml`. Keep the changes minimal — every flag
you flip from `0` to `1` widens the blast radius of a core-server RCE.

**To remove the proxy entirely** (not recommended): set
`DOCKER_HOST=unix:///var/run/docker.sock` in `server.environment`, add
the socket back to `server.volumes`, and remove the `docker-proxy`
service. You're trading the v0.2 hardening for whatever you gain by
running with the raw socket — usually nothing for the OSS use case.

## Restrict agent egress

By default, agent containers can reach any host the Docker network
allows. For agents that should only talk to specific LLM endpoints and
nothing else, attach them to a custom network with explicit egress
rules.

Option A — Docker user-defined network with iptables rules on the host:

```bash
# Allow only Anthropic + the org's MCP endpoint
iptables -I DOCKER-USER -s 172.20.0.0/16 -d api.anthropic.com -j ACCEPT
iptables -I DOCKER-USER -s 172.20.0.0/16 -d <your-mcp-host> -j ACCEPT
iptables -I DOCKER-USER -s 172.20.0.0/16 -j DROP
```

Option B — pin agents to a VPN-attached sidecar (vonzio's built-in
Tailscale tunnel feature already supports this; see the Tunnels section
in the dashboard).

## Secret rotation

`BETTER_AUTH_SECRET` is the master key — it derives every credential
encryption key. Rotating it requires re-encrypting every stored
credential. Plan for:

- Quarterly rotation as a baseline
- Immediate rotation if you suspect the host or `.env` file has been
  exposed
- OAuth client secrets: rotate per the provider's recommendation
  (typically yearly)

The re-encryption tooling is on the v0.3 roadmap; for now, rotation
means logging back into each integration after the secret change.

## Encrypt data at rest

The Postgres volume contains credential ciphertext, conversation
history, and uploaded files (if any). Encrypt the underlying volume:

- LUKS on bare-metal Linux
- EBS encryption (AWS), persistent disk encryption (GCP), managed-disk
  encryption (Azure)
- Cloud-managed Postgres (RDS, Cloud SQL, etc.) provides this out of
  the box

## TLS termination

Run core-server behind a reverse proxy (Caddy, nginx, Traefik) that
handles TLS. Do not expose core-server's HTTP port directly to the
internet.

Sample Caddy block:

```caddy
agents.example.com {
  reverse_proxy localhost:3001
}
```

## Custom agent images for runtime dependencies

The default agent image runs strictly as the unprivileged `agent` user
with no `sudo`. If your agents need tools beyond the base image's
preinstalled set (curl, git, gh, jq, ripgrep, language runtimes,
database clients, Chromium, the Claude Agent SDK, etc.), extend the
base image rather than letting the agent escalate at runtime:

```dockerfile
FROM ghcr.io/vonzio/vonzio/agent-base:latest

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    <your-extra-packages> \
    && rm -rf /var/lib/apt/lists/*
USER agent
```

Build, push to your own registry, and point a profile at the new image
via the dashboard's container-image picker. This keeps runtime
behavior reproducible and prevents prompt-driven `sudo apt install`
patterns that would otherwise punch through container isolation.

## Pin base images

The reference compose file pulls `latest` tags for some images. For a
reproducible, audit-friendly deployment, pin to digests:

```yaml
services:
  agent:
    image: node:22-bookworm-slim@sha256:<digest>
```

`docker buildx imagetools inspect <image>:<tag>` will give you the
current digest.

## Monitor

vonzio writes structured logs for every agent run (`agent_runs` table),
every auth event (`audit_log` table), and every tool/MCP call. Forward
both to your log pipeline.

Worth alerting on:

- A spike in failed auth attempts
- A spike in agent runs from a single user or workspace
- Docker daemon events that don't correspond to a core-server-initiated
  container action
- Any process inside an agent container that opens an unexpected port

## Restrict plugin installation (Phase 3)

When the plugin system ships, the `VONZIO_PLUGINS` env var becomes a
code-execution boundary — anyone who can edit it can run code in
core-server's process. Treat it like a binary deployment: same
review/approval as a core-server image change.

---

If you implement hardening beyond what's documented here — especially
gVisor or a stricter network policy — we'd be glad to incorporate the
recipe. Open a PR against this file.
