#!/usr/bin/env bash
# Run an E2E suite against a fresh, fully-ISOLATED stack so it never touches a
# developer's running dev stack or DB.
#
#   scripts/e2e-local.sh first-run   # lightweight: /setup -> login -> onboarding
#   scripts/e2e-local.sh chat        # full: real agent container + mock LLM
#   scripts/e2e-local.sh pause       # chat + idle-pause/resume round-trip (#333)
#
# Isolation (via docker/docker-compose.e2e.yml): its own docker network
# (vonzio-e2e-network), its own volumes (project vonzio-e2e-chat), and alt host
# ports (5273/3100) -- so it coexists with `make docker-dev`. The stack always
# starts with an empty DB (first visit -> /setup) and is torn down on exit,
# including the agent containers the orchestrator spawns.
set -Eeuo pipefail

MODE="${1:-first-run}"
case "$MODE" in
  first-run|chat|pause) ;;
  *) echo "usage: $0 [first-run|chat|pause]" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PROJECT=vonzio-e2e-chat
DASH_PORT=5273
API_PORT=3100
NETWORK=vonzio-e2e-network

compose() {
  docker compose --env-file "${ROOT}/.env" \
    -f "${ROOT}/docker/docker-compose.yml" \
    -f "${ROOT}/docker/docker-compose.dev.yml" \
    -f "${ROOT}/docker/docker-compose.e2e.yml" "$@"
}

export COMPOSE_PROJECT_NAME="${PROJECT}" DASHBOARD_PORT="${DASH_PORT}" SERVER_PORT="${API_PORT}" REGISTRATION_ENABLED=false
# pause mode: shrink the idle-pause window so the 30s sweep pauses the chat
# container fast enough for the spec to observe (#333).
[ "${MODE:-}" = "pause" ] && export SESSION_IDLE_PAUSE_SECS=10

cleanup() {
  echo ">> tearing down ${PROJECT}"
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  # Agent containers the orchestrator spawned onto the isolated network.
  docker ps -aq --filter "label=managed-by=vonzio" --filter "network=${NETWORK}" 2>/dev/null \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup  # clear any leftovers from a previous crashed run

# Services to start. The chat path needs the mock LLM + a real agent image; the
# first-run smoke needs neither.
SERVICES=(postgres docker-proxy server)
if [ "${MODE}" = "chat" ] || [ "${MODE}" = "pause" ]; then
  SERVICES+=(mock-llm)
  if ! docker image inspect vonzio-agent:latest >/dev/null 2>&1; then
    echo ">> building agent image (first run, ~5-8 min)"
    make agent-base-local
    make agent-image
  fi
fi

echo ">> booting isolated stack [${MODE}] (net=${NETWORK}, ports ${DASH_PORT}/${API_PORT})"
compose up -d --build --no-deps "${SERVICES[@]}"

echo ">> waiting for /health on :${API_PORT}"
for _ in $(seq 1 60); do
  curl -fsS "http://localhost:${API_PORT}/health" >/dev/null 2>&1 && break
  sleep 3
done
if ! curl -fsS "http://localhost:${API_PORT}/health" >/dev/null 2>&1; then
  echo "FAIL: stack never became healthy" >&2
  compose logs --tail=120 server >&2 || true
  exit 1
fi

SPEC="first-run.spec.ts"
if [ "${MODE}" = "chat" ]; then
  SPEC="chat.spec.ts"
  export VONZIO_E2E_CHAT=1  # un-gates chat.spec.ts (skipped without the mock)
elif [ "${MODE}" = "pause" ]; then
  SPEC="lazy-pause.spec.ts"
  export VONZIO_E2E_CHAT=1 VONZIO_E2E_PAUSE=1
fi
echo ">> running ${SPEC}"
if ! VONZIO_E2E_BASE_URL="http://localhost:${DASH_PORT}" \
  npx playwright test --config e2e/playwright.config.ts "${SPEC}"; then
  # Capture the runtime state BEFORE the EXIT trap tears the stack (and the
  # orchestrator-spawned agent containers) down — otherwise a chat failure
  # leaves no trace of WHY the agent never replied.
  {
    echo "===== E2E FAILURE DIAGNOSTICS ====="
    echo "--- vonzio-agent image ---"
    docker images vonzio-agent:latest --format '{{.ID}}  created {{.CreatedAt}} ({{.CreatedSince}})' || true
    echo "--- spawned agent containers (label=managed-by=vonzio) ---"
    docker ps -a --filter "label=managed-by=vonzio" || true
    for a in $(docker ps -aq --filter "label=managed-by=vonzio" --filter "network=${NETWORK}"); do
      echo "--- agent ${a} logs (tail) ---"
      docker logs "$a" 2>&1 | tail -120 || true
    done
    echo "--- server logs ---";   compose logs --tail=150 server || true
    echo "--- mock-llm logs ---"; compose logs --tail=80 mock-llm || true
    echo "--- network inspect ${NETWORK} ---"; docker network inspect "${NETWORK}" || true
    echo "===== END DIAGNOSTICS ====="
  } >&2
  exit 1
fi
