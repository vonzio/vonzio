.PHONY: install check-lock build test e2e e2e-install e2e-fresh e2e-chat dev dev-oss better-auth-migrate plugin publish-sdk-dryrun setup bootstrap agent-image agent-base-local dashboard clean clean-all help
.PHONY: docker-build docker-dev docker-dev-detached docker-dev-oss-detached docker-dev-oss docker-pull-oss docker-prod docker-up docker-down docker-logs docker-clean docker-flavors chat uninstall nuke
.PHONY: add-credential update-credential list-credentials create-key test-watch typecheck migrate-to-pg api api-once

# Optional local/downstream extension hook. Any user can drop a `Makefile.saas`
# next to this file to add private targets without forking the upstream Makefile.
# The leading dash makes the include silent when the file is absent.
-include Makefile.saas

install: ## Install all dependencies
	npm install

# Host node_modules — needed for host-mode dev (make dev/api/dashboard) and the
# build/CLI targets, but NOT for the docker stack (its containers install their
# own). The installer deliberately skips host `npm install`; this target lets
# the host-mode entry points auto-install on first use. `package.json` as the
# prereq re-runs it when deps change.
node_modules: package.json
	npm install

check-lock: ## Fail if package-lock.json is out of sync with package.json (same gate CI runs)
	@bash scripts/check-lockfile.sh

build: node_modules ## Build all packages
	npx tsc --project packages/shared/tsconfig.json
	npx tsc --project packages/core-server/tsconfig.json
	cd packages/dashboard && npx vite build
	cd packages/widget && npx vite build

agent-image: ## Build the Docker agent image
	docker build -t vonzio-agent:latest -f docker/Dockerfile.agent .

# Builds the heavy agent-base locally so Dockerfile.agent's
# `FROM ghcr.io/<repo>/agent-base:latest` resolves on dev machines whose
# arch isn't in the registry manifest (Apple Silicon). Cold ~3min, warm
# ~5s — Docker's layer cache absorbs no-op rebuilds. docker-dev depends
# on this, so first `make docker-dev` after a clean is the only slow run.
agent-base-local: ## Build agent-base locally (required on non-amd64 dev machines)
	docker build -t ghcr.io/vonzio/vonzio/agent-base:latest -f docker/Dockerfile.agent.base .

api: node_modules ## Start the API server in dev mode (auto-reload)
	TOOLS_DIR=./tools SKILLS_DIR=./skills npx tsx watch --clear-screen=false packages/core-server/src/index.ts

api-once: node_modules ## Start the API server (no auto-reload, clean shutdown)
	TOOLS_DIR=./tools SKILLS_DIR=./skills npx tsx packages/core-server/src/index.ts

dashboard: node_modules ## Start the customer dashboard dev server (port 5173)
	cd packages/dashboard && npx vite

dev: node_modules ## Start API + dashboard together (clean container shutdown on Ctrl+C)
	@bash scripts/dev-urls.sh --wait &
	npx concurrently --kill-others-on-fail --kill-signal SIGINT --kill-timeout 10000 -n api,dash -c blue,magenta "make api-once" "make dashboard"

# OSS-mode shortcuts — force REGISTRATION_ENABLED=false so a fresh DB
# routes the first visit to the /setup wizard instead of /login, and
# the dashboard hides the multi-tenant /admin route. Use these for OSS
# end-to-end testing.
dev-oss: ## Same as `make dev` but with REGISTRATION_ENABLED=false (OSS single-user mode)
	REGISTRATION_ENABLED=false $(MAKE) dev

# Better Auth uses a raw pg pool and does NOT create its tables on boot.
# Run this once against a fresh dev DB to create user/session/account/
# verification before `make dev-oss` will boot past migration 9.
# Requires DATABASE_URL + BETTER_AUTH_SECRET in .env (or env).
better-auth-migrate: ## Create Better Auth tables on a fresh DB (run once after `docker run vonzio-pg`)
	npx @better-auth/cli@latest migrate -y

docker-dev-oss: ## Same as `make docker-dev` but with REGISTRATION_ENABLED=false (OSS single-user mode)
	REGISTRATION_ENABLED=false $(MAKE) docker-dev

plugin: ## Plugin policy CLI. Usage: make plugin ARGS="approve @scope/plugin-x --reason '...'" | "list" | "diff @scope/plugin-x"
	npx tsx packages/core-server/src/plugins/cli.ts $(ARGS)

publish-sdk-dryrun: ## Build + pack the plugin SDK packages (no publish) to inspect the tarballs
	cd packages/shared && npm run prepare-dist && cd dist && npm pack
	cd packages/plugin-api && npm run prepare-dist && cd dist && npm pack
	cd packages/dashboard-registry && npm run prepare-dist && cd dist && npm pack
	@echo "Tarballs written to packages/{shared,plugin-api,dashboard-registry}/dist/*.tgz — inspect with 'tar tzf <file>'"

test: ## Run all tests
	npx vitest run

test-watch: ## Run tests in watch mode
	npx vitest

# Browser-level first-run smoke (Playwright). Needs a FRESH OSS stack already
# running (`make docker-dev-oss`) — it drives /setup → login → onboarding
# against an empty DB. See e2e/README.md. CI runs it gated via e2e.yml.
e2e: ## Run the E2E smoke against a running fresh OSS stack (see e2e/README.md)
	npm run e2e

e2e-install: ## One-time: install the Playwright Chromium browser the E2E suite uses
	npx playwright install chromium

# Self-contained variants — each boots its OWN fully-isolated stack (separate
# network + volumes + alt ports 5273/3100) and tears it down, so they never
# touch a running `make docker-dev` stack or its DB.
e2e-fresh: ## Run the first-run smoke against a throwaway isolated stack (no need to wipe your dev DB)
	@bash scripts/e2e-local.sh first-run

e2e-chat: ## Run the chat round-trip against an isolated stack + mock LLM (needs the agent image; builds it if missing)
	@bash scripts/e2e-local.sh chat

typecheck: ## Type-check all packages
	npx tsc --project packages/shared/tsconfig.json --noEmit
	npx tsc --project packages/core-server/tsconfig.json --noEmit
	npx tsc --project packages/dashboard/tsconfig.json --noEmit

setup: ## Show setup CLI help
	npx tsx packages/core-server/src/setup.ts

bootstrap: ## Bootstrap (create caller key + credential). Usage: make bootstrap KEY=sk-ant-...
	@if [ -z "$(KEY)" ]; then echo "Usage: make bootstrap KEY=your-anthropic-api-key"; exit 1; fi
	npx tsx packages/core-server/src/setup.ts bootstrap default $(KEY)

add-credential: ## Add a credential. Usage: make add-credential NAME=x KEY=sk-ant-...
	npx tsx packages/core-server/src/setup.ts add-credential $(NAME) $(KEY)

update-credential: ## Update credential API key. Usage: make update-credential ID=x KEY=sk-ant-...
	npx tsx packages/core-server/src/setup.ts update-credential $(ID) $(KEY)

list-credentials: ## List all credentials (keys redacted)
	npx tsx packages/core-server/src/setup.ts list-credentials

chat: ## Interactive WS chat. Usage: make chat KEY=rc_... CRED=cred_...
	npx tsx packages/core-server/src/scripts/ws-chat.ts $(KEY) $(CRED)

create-key: ## Create a caller API key. Usage: make create-key NAME=my-key
	npx tsx packages/core-server/src/setup.ts create-key $(NAME)

docker-build: ## Build all Docker images (agent + server)
	cd docker && docker compose build

docker-flavors: ## Build all flavored agent images (Go, Rust, Python-data, Java)
	cd docker && docker compose --profile flavors build

# Dev-stack compose invocation (base + dev overlay + the generated .env). EVERY
# docker-* management target must use this: `docker compose down`/`logs` WITHOUT
# --env-file can't interpolate the required ENCRYPTION_KEY (etc.) and aborts —
# which broke the `make docker-down` we print in the install summary.
COMPOSE_DEV = docker compose --env-file ../.env -f docker-compose.yml -f docker-compose.dev.yml

docker-dev: agent-base-local ## Start full stack with hot reload (postgres + agent + server, ports 3000/5173)
	@bash scripts/dev-urls.sh --wait &
	cd docker && $(COMPOSE_DEV) up --build

# Build (progress streams) then start DETACHED — control returns to the shell
# instead of being held by a log stream. Used by install.sh so the address
# summary it prints afterwards is the last, unmissable thing on screen. No
# dev-urls.sh here: the caller (installer, or `make urls`) owns the summary.
docker-dev-detached: agent-base-local ## Build + start the dev stack detached (logs: make docker-logs, stop: make docker-down)
	cd docker && $(COMPOSE_DEV) up -d --build

docker-dev-oss-detached: ## Same as docker-dev-detached but REGISTRATION_ENABLED=false (OSS single-user mode)
	REGISTRATION_ENABLED=false $(MAKE) docker-dev-detached

# Pull-based OSS run — prebuilt public images, NO build. The prod server image
# serves the dashboard + API on :3000 (no vite). `pull` fails fast if the
# version's images aren't published, so the installer can fall back to building.
# Pin the version with VONZIO_IMAGE_TAG (default :latest).
COMPOSE_PULL = docker compose --env-file ../.env -f docker-compose.yml -f docker-compose.pull.yml
docker-pull-oss: ## Pull prebuilt OSS images + start detached (no build). Set VONZIO_IMAGE_TAG to pin a version.
	cd docker && $(COMPOSE_PULL) pull
	cd docker && $(COMPOSE_PULL) up -d --no-build

urls: ## Print the dev stack's addresses (dashboard, API, webhook tunnel)
	@bash scripts/dev-urls.sh

dev-tunnel: ## DEV-ONLY: expose the stack via a public tunnel for Slack/Telegram webhooks (cloudflared default; VONZIO_DEV_TUNNEL=ngrok)
	@bash scripts/dev-tunnel.sh

docker-prod: ## Build and start production stack with HTTPS
	cd docker && docker compose --env-file ../.env -f docker-compose.yml -f docker-compose.prod.yml up -d --build

docker-up: ## Build and start everything with docker-compose
	cd docker && docker compose up --build -d

docker-down: ## Stop the dev stack + clean agent containers
	cd docker && $(COMPOSE_DEV) down
	-docker ps -aq --filter "label=managed-by=vonzio" | xargs docker rm -f 2>/dev/null

docker-logs: ## Tail the dev stack logs
	cd docker && $(COMPOSE_DEV) logs -f

docker-clean: ## Remove ALL vonzio containers, images, volumes
	-docker ps -aq --filter "label=managed-by=vonzio" | xargs docker rm -f 2>/dev/null
	-docker ps -aq --filter "ancestor=vonzio-agent:latest" | xargs docker rm -f 2>/dev/null
	cd docker && $(COMPOSE_DEV) --profile flavors down -v --rmi local 2>/dev/null || true

uninstall: ## Stop + remove vonzio containers + network (keeps your data, images, checkout)
	@bash install.sh --uninstall --dir .

nuke: ## Remove EVERYTHING — volumes (your DB!), all images (incl. agent-base), AND this checkout. IRREVERSIBLE.
	@bash install.sh --uninstall --purge --remove-base --remove-dir --dir .

migrate-to-pg: ## Migrate SQLite data to PostgreSQL. Usage: make migrate-to-pg SQLITE=./vonzio.db PG_URL=postgres://...
	npx tsx packages/core-server/src/scripts/migrate-sqlite-to-pg.ts $(SQLITE) $(PG_URL)

clean: ## Remove build artifacts and DB
	rm -rf packages/shared/dist packages/plugin-api/dist packages/dashboard-registry/dist packages/core-server/dist packages/dashboard/dist packages/widget/dist
	rm -f packages/*/dist/*.tgz packages/shared/tsconfig.tsbuildinfo packages/core-server/tsconfig.tsbuildinfo
	rm -f vonzio.db vonzio.db-wal vonzio.db-shm

clean-all: clean ## Remove everything including node_modules
	rm -rf node_modules packages/shared/node_modules packages/core-server/node_modules packages/dashboard/node_modules packages/widget/node_modules agent-runner/node_modules

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
