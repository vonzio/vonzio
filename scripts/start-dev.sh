#!/usr/bin/env sh
# Container startup wrapper for the dev stack (docker-compose.dev.yml).
#
# Runs Better Auth's CLI migrate to ensure the user/session/account/
# verification tables exist BEFORE the main server tries its own
# Drizzle migrations (one of which adds feature_flags to the user
# table). Then chains into the dev concurrently command.
#
# Why this lives here and not in the host's `make better-auth-migrate`:
# the docker-compose stack uses its own postgres container, not the
# host's. The installer can't reach the compose pg from outside the
# docker network, so the migration MUST run inside the server
# container. Idempotent: if the tables already exist, the CLI is a
# no-op (~3s).

set -e

echo "-> Applying Better Auth schema migration..."
npx @better-auth/cli@latest migrate -y --config auth.ts || {
  echo "x Better Auth migrate failed. Without these tables the server can't start."
  echo "  Common causes: DATABASE_URL unreachable, BETTER_AUTH_SECRET missing, auth.ts misconfigured."
  exit 1
}
echo "v Better Auth tables ready."
echo ""
echo "-> Starting dev stack (api + dashboard)..."

exec npx concurrently --kill-others-on-fail --kill-signal SIGTERM --kill-timeout 2000 \
  -n api,dash -c blue,magenta \
  "npx tsx watch --clear-screen=false packages/core-server/src/index.ts" \
  "cd packages/dashboard && npx vite --host 0.0.0.0"
