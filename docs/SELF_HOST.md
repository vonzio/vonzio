# Self-hosting vonzio

This guide walks you through running vonzio on your own machine or server. The single-user OSS mode is the supported self-host configuration — one human, their agents, their data, their API key.

If you want multi-user invites, plans, billing, and an admin panel, those live in the proprietary control plane and the easiest path is the managed service at [vonzio.com](https://vonzio.com).

## Requirements

The default install **pulls prebuilt images** and fetches only the compose files (no source tree), so the host needs no build toolchain — just Docker and a couple of shell utilities:

- **Docker** 24+ with Compose v2
- **curl**, **make**, **openssl** — `curl` runs the one-liner; the installer checks for `make` + `openssl` and offers to install them if missing
- An **Anthropic API key** (`sk-ant-...` from console.anthropic.com), an Anthropic subscription token (from claude.ai cookies), or an **Ollama Cloud API key**
- ~3 GB free disk for the pulled images + the postgres volume
- **git** and **Node.js** 22+ — *optional*. `git` is only needed for the build-from-source / contributor path (`--build`, which clones the repo); Node is for host-mode dev (`make dev-oss`) and the CLI tools. A normal pull install needs neither.

## Quickstart (one-liner)

```bash
curl -fsSL https://raw.githubusercontent.com/vonzio/vonzio/main/install.sh | bash
```

The installer handles everything below automatically — dep checks, secret generation, postgres, Better Auth schema, stack boot. Flags: `--dir <path>`, `--name <slug>`, `--tag <tag>`, `--build`, `--yes`, `--no-start`, `--uninstall`, `--help`.

By default it **fetches just the two compose files** (no `git clone`, no source tree) and **pulls vonzio's prebuilt multi-arch images** (amd64 + arm64), bringing the stack up with no compiling — usually under a minute on a warm machine. It drops a small management `Makefile` in the install dir so `make docker-logs` / `docker-down` still work.

Pass `--build` to instead clone the full source and build the images locally (for contributors, or an unreleased ref). `--build` is also the escape hatch if prebuilt images aren't published yet for the version you pick.

It installs the **latest tagged release** unless you pin a specific version via `VONZIO_VERSION` (env) or `--tag` (flag):

```bash
VONZIO_VERSION=v0.1.3 curl -fsSL https://raw.githubusercontent.com/vonzio/vonzio/main/install.sh | bash
```

Use a pinned install when you need reproducibility, are following a security advisory, or want to stay off the in-flight `main` branch.

The manual recipe below is the same steps without the wrapper, for readers who want to understand what's happening or run them individually.

### Running more than one instance on a host

Each install is bound to a **compose project** derived from its install directory (or `--name`), and everything is namespaced under it — containers (`<project>-server-1`), volumes (`<project>_pgdata`), and the agent network (`<project>-network`). So a second install to a different directory just works:

```bash
# first instance → project "vonzio", on :3000
curl -fsSL https://raw.githubusercontent.com/vonzio/vonzio/main/install.sh | bash

# second instance → project "vonzio-staging", auto-bumped to :3001
curl -fsSL .../install.sh | bash -s -- --dir ~/vonzio-staging
# or name it explicitly:
curl -fsSL .../install.sh | bash -s -- --dir ~/eu --name prod-eu
```

The installer detects the busy `:3000`/`:5173` and bumps the second instance to the next free pair; the two stacks have separate databases, secrets, and networks and never cross-talk. Re-running the installer for an **already-running** instance is detected and refuses to start a duplicate (stop it first with `make docker-down`). `--uninstall --dir <path>` removes only that instance.

The default single install (`~/vonzio`, no `--name`) stays project `vonzio` with the `vonzio-network` network — unchanged from before.

## First-time setup (manual)

### 1. Clone and configure

```bash
git clone https://github.com/vonzio/vonzio.git
cd vonzio
cp .env.example .env
```

Edit `.env` and set the two mandatory secrets to 32+ random characters each:

```bash
ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)
BETTER_AUTH_SECRET=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)
```

You can paste those into `.env` directly. Don't lose them — `ENCRYPTION_KEY` decrypts your stored API keys and secrets; losing it bricks every credential in the database.

### 2. Start the stack

**Pull-based — prebuilt images, no build (recommended):**

```bash
make docker-pull-oss
```

This pulls the prebuilt `server` + `agent` images and starts the stack with its own internal postgres — no compiling on your machine. The server container's startup wrapper runs Better Auth's schema migration before launching the API, so the four Better Auth tables (`user`, `session`, `account`, `verification`) exist before the Drizzle migrations look for them. Pin a version with `VONZIO_IMAGE_TAG=0.3.9 make docker-pull-oss` (defaults to `latest`).

In this mode the production server serves the built dashboard **and** the API on one port: open **`http://localhost:3000`**.

**Build from source — for contributors / hot reload:**

```bash
make docker-dev-oss
```

Builds the images locally and runs the dashboard through Vite with hot reload. First boot builds the agent base image (~3 min cold on Apple Silicon, ~5 sec warm). Dashboard on **`http://localhost:5173`**, API on `:3000`.

For host mode (faster iteration, requires you to manage postgres yourself):

```bash
# Start a postgres reachable on localhost:5432
docker run --rm -d \
  -e POSTGRES_DB=vonzio \
  -e POSTGRES_USER=vonzio \
  -e POSTGRES_PASSWORD=vonzio_dev \
  -p 5432:5432 \
  --name vonzio-pg \
  postgres:17-alpine

# One-time: create the Better Auth tables in that pg
make better-auth-migrate

# Run host-mode dev (tsx watch + vite directly on your machine)
make dev-oss
```

Host mode serves the dashboard via Vite on `http://localhost:5173`, API on `:3000`.

**Which URL?** Pull-based (`make docker-pull-oss`) → **`:3000`** (the prod server serves the dashboard itself). Build-from-source or host mode (`make docker-dev-oss` / `make dev-oss`) → **`:5173`** (Vite). The installer's closing summary always prints the correct one for the mode it used. No Traefik or wildcard DNS required in the OSS install either way.

### 3. Walk through the wizards

Visit your URL. You'll see:

1. **`/setup`** — creates the lone admin account. Fill in name, email, password (≥8 chars). Submit.
2. **`/login`** — sign in with the credentials you just created.
3. **`/onboarding`** — pick a credential type (Anthropic API key, Anthropic subscription, or Ollama Cloud), paste your key, click Continue.
4. **`/onboarding` step 2** — pick a default model from your provider's available list. Click Finish setup.
5. **Workspace** — type "Hello" to chat. First message spins up a fresh agent container (~5 sec).

If anything 500s during onboarding, check the API log for the actual error.

## Knowing where things are

Once the stack is up it prints a summary; re-print it any time with:

```bash
make urls
#   Dashboard   http://localhost:5173   ← open this
#   API         http://localhost:3000   (/health, /v1)
#   Webhooks    none — run `make dev-tunnel` for Slack/Telegram webhooks
```

`make urls` reports the build-from-source / dev ports. On a **pull-based** install the dashboard and API share `http://localhost:3000` — that's the address to open.

## Local webhook testing (Slack / Telegram)

Webhook-based integrations need a **public** URL to receive callbacks, which
`localhost` isn't. For **local development only**, expose the stack through a
tunnel (run it in a second terminal alongside `make docker-dev-oss`):

```bash
make dev-tunnel                          # cloudflared — no account/token
VONZIO_DEV_TUNNEL=ngrok make dev-tunnel  # ngrok — needs an authtoken
```

It prints a public URL (also shown by `make urls`). Use it as your Slack/Telegram
webhook URL; inbound webhooks work immediately. For OAuth-redirect plugins (Slack),
set `BETTER_AUTH_URL=<that url>` in `.env` and restart the stack so the redirect
matches.

> **Never use a tunnel for production.** It bypasses your firewall, TLS, and auth.
> A real deployment must sit behind your own TLS reverse proxy — see
> [HARDENING.md](./HARDENING.md). `dev-tunnel` refuses to run when `NODE_ENV=production`.

## Updating

**Pull-based install** — fetch the new release's images and restart:

```bash
VONZIO_IMAGE_TAG=<new-version> make docker-pull-oss   # e.g. 0.3.10
```

Or just re-run the one-liner — it installs the latest tagged release. No host rebuild, no `make better-auth-migrate` (the server image runs the schema migration at boot).

**Build-from-source install** — pull the new code and rebuild:

```bash
git pull
make better-auth-migrate   # safe to re-run; only applies new Better Auth tables
make docker-dev-oss        # rebuild + restart
```

Either way, the data migrations under `packages/core-server/src/db/migrations.ts` are applied automatically at boot.

## Backup

The state lives in two places:

1. **Postgres** — everything user-visible. Dump with `docker exec vonzio-pg pg_dump -U vonzio vonzio > backup.sql`.
2. **Encrypted secrets** — credentials in postgres are encrypted with `ENCRYPTION_KEY`. Back up `.env` (or at least save `ENCRYPTION_KEY` somewhere you trust) — a postgres dump alone is useless without the key.

## Configuration reference

The full env var reference is in [packages/core-server/src/config.ts](../packages/core-server/src/config.ts). The ones you're most likely to touch:

| Variable | Default | What it does |
|---|---|---|
| `ENCRYPTION_KEY` | (none — required) | 32+ char secret for the credential vault |
| `BETTER_AUTH_SECRET` | (none — required) | 32+ char secret for session tokens |
| `DATABASE_URL` | `postgres://vonzio:vonzio_dev@localhost:5432/vonzio` | Postgres connection string |
| `REGISTRATION_ENABLED` | `false` | OSS keeps this false — single user only |
| `OLLAMA_ENABLED` | `false` | Show Ollama Cloud as a credential option |
| `RESEND_API_KEY` | unset | Enable password-reset emails via Resend |
| `EMAIL_FROM` | `Vonzio <noreply@app.vonz.io>` | From-address for reset/invite emails |
| `BETTER_AUTH_URL` | `http://localhost:3000` | Public URL where vonzio is reachable |
| `CORS_ORIGIN` | `*` | Comma-separated allowed origins |
| `AGENT_IMAGE` | `vonzio-agent:latest` | Container image for agent sessions |
| `DOCKER_HOST` | `tcp://docker-proxy:2375` (in compose) | Docker API endpoint. Takes precedence over `DOCKER_SOCKET`. Accepts `unix:///path` or `tcp://host:port`. |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Legacy fallback. Used only when `DOCKER_HOST` is unset. |
| `POOL_MIN_SIZE` | `0` | Warm container count |
| `SESSION_IDLE_TTL_SECS` | `14400` | How long a paused session sticks around |
| `SESSION_IDLE_PAUSE_SECS` | `900` | Idle seconds before a chat's container is paused (`docker pause`) — near-zero CPU while parked, instant resume on the next message. `0` disables. Persistent workstations use `WORKSTATION_IDLE_PAUSE_SECS` instead. |

OAuth integrations (GitHub, Google, Slack, etc.) require their client id/secret pairs — see `config.ts` for the variable names.

### Git provider access: OAuth App vs GitHub App

Agents clone and push with a token from a connected git provider (Settings →
Integrations → Git providers). For GitHub there are three ways to connect, in
descending order of how well they handle **org** repositories:

| Method | Repo scope | Org-restricted repos | Token |
|---|---|---|---|
| **GitHub App** (recommended) | Pick exactly which repos | Org owner approves the install — no separate step | Short-lived, minted per session |
| OAuth App | All repos the account can reach | Needs a **separate** owner approval of the OAuth app | Long-lived user token |
| Personal access token | Whatever the PAT is scoped to | Honors the PAT's scope | Long-lived PAT |

If your org has **"OAuth App access restrictions"** enabled, an OAuth App token
gets `403`s on org repos until an org owner approves the app
([GitHub docs](https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions)).
A **GitHub App** sidesteps this: the org owner approves the installation (with a
repo allow-list) as part of the normal install flow, and vonzio mints
short-lived, least-privilege installation tokens on demand.

To enable the "Install GitHub App" button:

1. Create a GitHub App at **github.com/settings/apps/new** (or under your org).
   - **Repository permissions →** Contents: *Read & write*, Metadata: *Read-only*
     (add more as needed).
   - **Setup URL:** `<BETTER_AUTH_URL>/api/git/app/callback` and tick
     **"Redirect on update"**.
   - **Tick "Request user authorization (OAuth) during installation".** This is
     required, not optional: on the install callback vonzio uses the returned
     OAuth `code` to confirm the installer actually owns the installation before
     binding it. A GitHub `installation_id` is a small, enumerable integer — if
     it were trusted blindly, one user could bind another org's installation to
     their account and mint tokens for its repos. Without this enabled, the
     install button stays hidden.
   - Generate a **private key** (downloads a `.pem`) **and a client secret**
     (under "Client secrets" on the same settings page).
2. Set the id, slug, and OAuth client creds (see `.env.example`):
   ```bash
   GITHUB_APP_ID=123456
   GITHUB_APP_SLUG=your-app-slug          # the github.com/apps/<slug> name
   GITHUB_APP_CLIENT_ID=Iv1.xxxxxxxx      # App settings → "Client ID"
   GITHUB_APP_CLIENT_SECRET=…             # App settings → "Client secrets"
   ```
3. Provide the private key — **how depends on whether you run under Docker:**

   **Docker (recommended): mount the `.pem` as a file secret.** Docker Compose
   loads `.env` via `env_file`, which is line-based and **mangles a multi-line
   PEM** (it can break env loading and server boot). So do *not* inline the key.
   Drop the downloaded `.pem` next to your compose files and bind-mount it, then
   point the path env var at it:
   ```yaml
   # docker/docker-compose.override.yml (compose auto-loads it)
   services:
     server:
       volumes:
         - ./secrets/github/app.pem:/run/secrets/github/app.pem:ro
   ```
   ```bash
   # .env
   GITHUB_APP_PRIVATE_KEY_PATH=/run/secrets/github/app.pem
   ```
   This mirrors the Teller mTLS file-secret pattern. The mounted file wins over
   any inline value.

   **Host mode / non-Docker only:** you may instead inline the PEM with literal
   `\n` escapes (single line, double-quoted):
   ```bash
   GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----\n"
   ```
4. Restart the stack. "Install GitHub App" now appears in the Git providers
   dialog; clicking it opens GitHub's install/repo-picker, and on return the
   installation is saved as a `github_app` provider.

The OAuth App (`GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`) and PAT paths remain
available and unchanged — the GitHub App is purely additive.

### Customizing the system prompt and tools

The default agent **system prompt** (`config/vonzio.md`) and the **example tool** (`tools/example-weather.js`) are baked into the server image, so a pull-based install runs without them on disk. (The legacy name `config/system-prompt.md` still works as a fallback.) To customize without rebuilding, drop your own copies next to the compose files and bind-mount them over the baked-in defaults — add this to a small override file (e.g. `docker/docker-compose.override.yml`):

```yaml
services:
  server:
    volumes:
      - ./config:/app/config   # your vonzio.md
      - ./tools:/app/tools      # your tool .js files (TOOLS_DIR=/app/tools)
```

Compose auto-loads `docker-compose.override.yml`; restart the stack to pick up changes. (The build-from-source dev stack already mounts the repo's `config/` + `tools/` for live editing.)

### Docker access (nested Docker-in-Docker)

Off by default. When enabled, a workspace whose profile has `docker_access` runs a
**nested docker daemon** so the agent can build images and run `docker compose` dev
stacks. It is **opt-in per host** and there are real trade-offs — a nested daemon
has its own network, so **egress enforcement and VPN are bypassed** for that
workspace (it is forced to allow-all egress).

To enable:

1. **Build the docker-flavored agent image** and point profiles at it:
   ```bash
   make docker-flavors   # builds vonzio-agent:dind (+ the other flavors)
   ```
   Or build just this one: `docker compose -f docker/docker-compose.yml build agent-dind`.
   Then set a profile's **Container image** to `vonzio-agent:dind`.
2. **Turn on a host mode** via `DOCKER_ACCESS_MODE` in your `.env`:
   - `dind-privileged` — nested dockerd in a **privileged** container. Zero host
     setup, but it disables container confinement, so **only on a single-tenant
     box you own** — never next to other users' workspaces. Works with the
     hardened `docker-socket-proxy` (it filters by API endpoint, not request body,
     so a privileged create passes) — no need to expose the raw socket.
   - `sysbox` — nested dockerd via the **[Sysbox](https://github.com/nestybox/sysbox)**
     runtime (`sysbox-runc`), unprivileged. Requires installing Sysbox on the host
     (kernel ≥ 5.12). The only mode safe to expose to multiple users.
3. **Flag the profile.** Only an **admin** may enable `docker_access` on a profile
   (it voids the egress/VPN guarantees). Toggling it applies to containers created
   *after* the change — restart the workspace to pick it up.

Tuning knobs (defaults are usually fine): `CONTAINER_MEMORY_LIMIT_DOCKER_ACCESS`
(default `8g`) and `CONTAINER_PIDS_LIMIT_DOCKER_ACCESS` (default `4096`) — a real
compose stack + inner daemon needs more headroom than an ordinary workspace.

## Production deploy

Use the production compose file:

```bash
cd docker
docker compose --env-file ../.env -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

The production stack:
- Replaces the hot-reload dev server (Dockerfile.server.dev, which mounts source) with the built `vonzio-server` production image
- Adds Traefik HTTPS via Let's Encrypt (needs `DOMAIN` set in `.env`)
- Sets `REGISTRATION_ENABLED=false` by default

There's also a `deploy.sh` script that bootstraps a fresh Debian/Ubuntu server end-to-end — read the script before running it.

**Before deploying anywhere with sensitive data**, read
[SECURITY_MODEL.md](./SECURITY_MODEL.md) for the threat model and
[HARDENING.md](./HARDENING.md) for opt-in steps (gVisor runtime,
restricted Docker socket, network policies) beyond the defaults.

## Troubleshooting

### "relation \"user\" does not exist" on first boot

The Better Auth schema migration didn't run. In Docker mode it's part of the container startup wrapper; if you see this it usually means the `scripts/start-dev.sh` mount is missing — check `docker compose config` and confirm `scripts/start-dev.sh` is bind-mounted at `/app/scripts/start-dev.sh`. In host mode, run `make better-auth-migrate` explicitly.

### Onboarding rejects my API key with "non-ASCII character"

The key was copy-pasted with hidden characters (smart quote, em-dash, zero-width space). Re-copy from the source (console.anthropic.com or ollama.com), or paste through a plain-text editor first.

### Setup page won't render — it bounces to /login

The user table isn't empty. To re-test the setup wizard:

```bash
docker exec -i vonzio-pg psql -U vonzio -d vonzio -c \
  'TRUNCATE "user", account, session, verification CASCADE;'
```

Hard-refresh the browser.

### Agent base image build is slow on Apple Silicon

This only affects the **build-from-source** path (`make docker-dev-oss` / `--build`): first boot runs `make agent-base-local`, which builds `ghcr.io/vonzio/vonzio/agent-base:latest` for your arch (3 min cold). Subsequent boots reuse the cached image. The default **pull-based** install skips this entirely — it downloads the prebuilt image instead.

### "Cannot find native binding" for @tailwindcss/oxide in dev container

The dev Dockerfile already uses `npm install` (not `npm ci`) to work around this npm bug. If you see it, rebuild without cache:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml build --no-cache server
```

### WebSocket fails to connect

Three common causes:
- **Token typo in URL** — `?key=rc_...` (one r). The widget URL is sensitive to a stray character.
- **Vite proxy** — host-mode dev relies on `packages/dashboard/vite.config.ts` proxying `/v1` to `:3000`. If you changed it, restore the original.
- **API down** — `curl http://localhost:3000/health` should return 200.

## Need help

- [GitHub Issues](https://github.com/vonzio/vonzio/issues) for bugs and feature requests
- [GitHub Discussions](https://github.com/vonzio/vonzio/discussions) for questions
- `security@vonz.io` for vulnerability reports (please don't open public issues)
