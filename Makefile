.PHONY: install build test dev dev-oss better-auth-migrate setup bootstrap agent-image agent-base-local dashboard clean clean-all help
.PHONY: docker-build docker-dev docker-dev-oss docker-prod docker-up docker-down docker-logs docker-clean docker-flavors chat
.PHONY: add-credential update-credential list-credentials create-key test-watch typecheck migrate-to-pg api api-once

install: ## Install all dependencies
	npm install

build: ## Build all packages
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
	docker build -t ghcr.io/vonzio/core/agent-base:latest -f docker/Dockerfile.agent.base .

api: ## Start the API server in dev mode (auto-reload)
	TOOLS_DIR=./tools SKILLS_DIR=./skills npx tsx watch --clear-screen=false packages/core-server/src/index.ts

api-once: ## Start the API server (no auto-reload, clean shutdown)
	TOOLS_DIR=./tools SKILLS_DIR=./skills npx tsx packages/core-server/src/index.ts

dashboard: ## Start the customer dashboard dev server (port 5173)
	cd packages/dashboard && npx vite

dev: ## Start API + dashboard together (clean container shutdown on Ctrl+C)
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

test: ## Run all tests
	npx vitest run

test-watch: ## Run tests in watch mode
	npx vitest

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

docker-dev: agent-base-local ## Start full stack with hot reload (postgres + agent + server, ports 3000/5173)
	cd docker && docker compose --env-file ../.env -f docker-compose.yml -f docker-compose.dev.yml up --build

docker-prod: ## Build and start production stack with HTTPS
	cd docker && docker compose --env-file ../.env -f docker-compose.yml -f docker-compose.prod.yml up -d --build

docker-up: ## Build and start everything with docker-compose
	cd docker && docker compose up --build -d

docker-down: ## Stop compose and clean agent containers
	cd docker && docker compose down
	-docker ps -aq --filter "label=managed-by=vonzio" | xargs docker rm -f 2>/dev/null

docker-logs: ## Tail docker-compose logs
	cd docker && docker compose logs -f

docker-clean: ## Remove ALL vonzio containers, images, volumes
	-docker ps -aq --filter "label=managed-by=vonzio" | xargs docker rm -f 2>/dev/null
	-docker ps -aq --filter "ancestor=vonzio-agent:latest" | xargs docker rm -f 2>/dev/null
	cd docker && docker compose --profile flavors down -v --rmi local 2>/dev/null || true

migrate-to-pg: ## Migrate SQLite data to PostgreSQL. Usage: make migrate-to-pg SQLITE=./vonzio.db PG_URL=postgres://...
	npx tsx packages/core-server/src/scripts/migrate-sqlite-to-pg.ts $(SQLITE) $(PG_URL)

clean: ## Remove build artifacts and DB
	rm -rf packages/shared/dist packages/core-server/dist packages/dashboard/dist packages/widget/dist
	rm -f packages/shared/tsconfig.tsbuildinfo packages/core-server/tsconfig.tsbuildinfo
	rm -f vonzio.db vonzio.db-wal vonzio.db-shm

clean-all: clean ## Remove everything including node_modules
	rm -rf node_modules packages/shared/node_modules packages/core-server/node_modules packages/dashboard/node_modules packages/widget/node_modules agent-runner/node_modules

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
