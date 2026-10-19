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
#
# Egress enforcement (on by default in the product) is ON for chat/pause too:
# the stack runs the egress-proxy service on its own internal network, the
# agent's model calls go through it to the mock LLM, and after the chat spec
# the script asserts the enforcement from inside the agent container (allowed
# host passes, others are refused, no direct route). E2E_EGRESS=0 opts out.
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
EGRESS_NET=vonzio-e2e-egress
E2E_EGRESS="${E2E_EGRESS:-1}"

compose() {
  docker compose --env-file "${ROOT}/.env" \
    -f "${ROOT}/docker/docker-compose.yml" \
    -f "${ROOT}/docker/docker-compose.dev.yml" \
    -f "${ROOT}/docker/docker-compose.e2e.yml" "$@"
}

export COMPOSE_PROJECT_NAME="${PROJECT}" DASHBOARD_PORT="${DASH_PORT}" SERVER_PORT="${API_PORT}" REGISTRATION_ENABLED=false
# Own internal egress network so this stack never shares one with a dev stack.
export EGRESS_PROXY_NETWORK="${EGRESS_NET}"
if [ "${E2E_EGRESS}" = "1" ]; then export EGRESS_ENFORCEMENT=1; else export EGRESS_ENFORCEMENT=0; fi
# pause mode: shrink the idle-pause window so the 30s sweep pauses the chat
# container fast enough for the spec to observe (#333).
[ "${MODE:-}" = "pause" ] && export SESSION_IDLE_PAUSE_SECS=10

cleanup() {
  echo ">> tearing down ${PROJECT}"
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  # Agent containers the orchestrator spawned onto the isolated network.
  # Under egress enforcement they sit on the internal egress network instead.
  for net in "${NETWORK}" "${EGRESS_NET}"; do
    docker ps -aq --filter "label=managed-by=vonzio" --filter "network=${net}" 2>/dev/null \
      | xargs -r docker rm -f >/dev/null 2>&1 || true
  done
  docker network rm "${EGRESS_NET}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup  # clear any leftovers from a previous crashed run

# Services to start. The chat path needs the mock LLM + a real agent image; the
# first-run smoke needs neither.
SERVICES=(postgres docker-proxy server)
if [ "${MODE}" = "chat" ] || [ "${MODE}" = "pause" ]; then
  SERVICES+=(mock-llm)
  [ "${E2E_EGRESS}" = "1" ] && SERVICES+=(egress-proxy)
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
    for a in $(docker ps -aq --filter "label=managed-by=vonzio" --filter "network=${NETWORK}") \
             $(docker ps -aq --filter "label=managed-by=vonzio" --filter "label=vonzio-mode=session" --filter "network=${EGRESS_NET}"); do
      echo "--- agent ${a} logs (tail) ---"
      docker logs "$a" 2>&1 | tail -120 || true
    done
    echo "--- server logs ---";   compose logs --tail=150 server || true
    echo "--- mock-llm logs ---"; compose logs --tail=80 mock-llm || true
    echo "--- egress-proxy logs ---"; compose logs --tail=80 egress-proxy || true
    echo "--- network inspect ${NETWORK} ---"; docker network inspect "${NETWORK}" || true
    echo "===== END DIAGNOSTICS ====="
  } >&2
  exit 1
fi

# Egress enforcement, asserted from inside the agent the chat just used. The
# chat reply itself already proved the model path (agent -> proxy -> mock LLM
# on a private address + custom port); this proves the deny side.
if [ "${MODE}" = "chat" ] && [ "${E2E_EGRESS}" = "1" ]; then
  echo ">> asserting egress enforcement from the agent container"
  egress_fail() {
    echo "FAIL (egress): $*" >&2
    compose logs --tail=80 egress-proxy >&2 || true
    exit 1
  }
  agent="$(docker ps -q --filter "label=managed-by=vonzio" --filter "label=vonzio-mode=session" --filter "network=${EGRESS_NET}" | head -1)"
  [ -n "${agent}" ] || egress_fail "no session agent on ${EGRESS_NET} — enforcement was not applied"
  nets="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "${agent}")"
  [ "${nets}" = "${EGRESS_NET} " ] || egress_fail "agent must be ONLY on ${EGRESS_NET}, got: ${nets}"
  ax() { docker exec "${agent}" sh -c "$1"; }
  code="$(ax 'curl -s -o /dev/null -w "%{http_code}" --max-time 30 https://registry.npmjs.org/' || true)"
  [ "${code}" = "200" ] || egress_fail "built-in allowlisted registry.npmjs.org should pass, got HTTP ${code}"
  code="$(ax 'curl -s -o /dev/null -w "%{http_connect}" --max-time 30 https://example.com/' || true)"
  [ "${code}" = "403" ] || egress_fail "non-allowlisted example.com should be refused by the proxy (403), got ${code}"
  ax 'curl -s -o /dev/null --max-time 15 http://169.254.169.254/latest/meta-data/' \
    && egress_fail "metadata address must not be reachable"
  ax 'curl -s -o /dev/null --noproxy "*" --max-time 10 https://1.1.1.1/' \
    && egress_fail "direct (proxy-bypassing) egress must have no route"
  echo ">> egress enforcement OK (allowlisted host passes, others refused, no direct route)"
fi
