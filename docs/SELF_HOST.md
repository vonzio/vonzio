# Self-hosting vonzio

This guide walks you through running vonzio on your own machine or server. The single-user OSS mode is the supported self-host configuration — one human, their agents, their data, their API key.

If you want multi-user invites, plans, billing, and an admin panel, those live in the proprietary control plane and the easiest path is the managed service at [vonzio.com](https://vonzio.com).

## Requirements

- **Docker** 24+ with Compose v2
- **Node.js** 22+ (for `make better-auth-migrate` and host-mode dev)
- **make**
- An **Anthropic API key** (`sk-ant-...` from console.anthropic.com), an Anthropic subscription token (from claude.ai cookies), or an **Ollama Cloud API key**
- ~2 GB free disk for the agent base image (built locally on first boot)

## Quickstart (one-liner)

```bash
curl -fsSL https://raw.githubusercontent.com/vonzio/core/main/install.sh | bash
```

The installer handles everything below automatically — dep checks, secret generation, postgres, Better Auth schema, stack boot. Flags: `--dir <path>`, `--yes`, `--no-start`, `--uninstall`, `--help`.

The manual recipe below is the same steps without the wrapper, for readers who want to understand what's happening or run them individually.

## First-time setup (manual)

### 1. Clone and configure

```bash
git clone https://github.com/vonzio/core.git
cd core
cp .env.example .env
```

Edit `.env` and set the two mandatory secrets to 32+ random characters each:

```bash
ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)
BETTER_AUTH_SECRET=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)
```

You can paste those into `.env` directly. Don't lose them — `ENCRYPTION_KEY` decrypts your stored API keys and secrets; losing it bricks every credential in the database.

### 2. Start the stack

For Docker mode (recommended — single command, no host postgres needed):

```bash
make docker-dev-oss
```

The compose stack brings up its own postgres internally. The server container's startup wrapper runs Better Auth's schema migration before launching the API, so the four Better Auth tables (`user`, `session`, `account`, `verification`) exist before the Drizzle migrations look for them.

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

URL: `http://vonz.localhost` (Docker mode, via Traefik) or `http://localhost:5173` (host mode).

First boot of `docker-dev-oss` builds the agent base image (~3 min cold on Apple Silicon, ~5 sec warm). Subsequent boots reuse the cached layer.

### 3. Walk through the wizards

Visit your URL. You'll see:

1. **`/setup`** — creates the lone admin account. Fill in name, email, password (≥8 chars). Submit.
2. **`/login`** — sign in with the credentials you just created.
3. **`/onboarding`** — pick a credential type (Anthropic API key, Anthropic subscription, or Ollama Cloud), paste your key, click Continue.
4. **`/onboarding` step 2** — pick a default model from your provider's available list. Click Finish setup.
5. **Workspace** — type "Hello" to chat. First message spins up a fresh agent container (~5 sec).

If anything 500s during onboarding, check the API log for the actual error.

## Updating

```bash
git pull
make better-auth-migrate   # safe to re-run; only applies new Better Auth tables
make docker-dev-oss        # rebuild + restart
```

Migrations under `packages/core-server/src/db/migrations.ts` are applied automatically at boot.

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
| `POOL_MIN_SIZE` | `0` | Warm container count |
| `SESSION_IDLE_TTL_SECS` | `14400` | How long a paused session sticks around |

OAuth integrations (GitHub, Google, Slack, etc.) require their client id/secret pairs — see `config.ts` for the variable names.

## Production deploy

Use the production compose file:

```bash
cd docker
docker compose --env-file ../.env -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

The production stack:
- Replaces the dev `docker-server.dev` (which mounts source for hot reload) with the built `docker-server` image
- Adds Traefik HTTPS via Let's Encrypt (needs `DOMAIN` set in `.env`)
- Sets `REGISTRATION_ENABLED=false` by default

There's also a `deploy.sh` script that bootstraps a fresh Debian/Ubuntu server end-to-end — read the script before running it.

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

First `make docker-dev-oss` runs `make agent-base-local`, which builds `ghcr.io/vonzio/core/agent-base:latest` for your arch (3 min cold). Subsequent boots reuse the cached image.

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

- [GitHub Issues](https://github.com/vonzio/core/issues) for bugs and feature requests
- [GitHub Discussions](https://github.com/vonzio/core/discussions) for questions
- `security@vonz.io` for vulnerability reports (please don't open public issues)
