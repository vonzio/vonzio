#!/usr/bin/env sh
# Container startup wrapper for the prod stack (Dockerfile.server).
#
# Runs Better Auth's CLI migrate on every boot to ensure the
# user/session/account/verification tables exist before the main
# server tries its own Drizzle migrations (one of which adds
# feature_flags to the user table). Idempotent: if the tables already
# exist, the CLI is a no-op (~3s).
#
# Why this lives here and not in install.sh: the migration MUST run
# inside the server container -- the host can't reach the compose
# postgres from outside the docker network. Mirror of scripts/start-dev.sh,
# minus the dev concurrently wrapper.

set -e

echo "-> Applying Better Auth schema migration..."
npx @better-auth/cli@latest migrate -y --config auth.ts || {
  echo "x Better Auth migrate failed. Without these tables the server can't start."
  echo "  Common causes: DATABASE_URL unreachable, BETTER_AUTH_SECRET missing, auth.ts misconfigured."
  exit 1
}
echo "v Better Auth tables ready."
echo ""

exec npx tsx packages/core-server/src/index.ts
