#!/usr/bin/env bash
# Inspect a vonzio workspace/session end-to-end.
#
#   ./scripts/inspect-session.sh <session-id> [--json] [--since 2h]
#
# Pulls workspace state from Postgres, recent tasks, EventLog summary, and
# orchestrator logs (including cross-model context-replay events). Defaults
# to a human-readable terminal report; pass --json for one machine-readable
# blob.
#
# Assumes you're running the local docker-dev / docker-dev-oss stack —
# uses the `docker-server-1` and `docker-postgres-1` container names from
# the bundled compose files.

set -euo pipefail

# ─── Args ───────────────────────────────────────────────────────────────
SESSION_ID="${1:-}"
JSON_MODE=false
LOG_SINCE="2h"  # docker logs window; small by default to keep output snappy

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_MODE=true; shift ;;
    --since) LOG_SINCE="$2"; shift 2 ;;
    --since=*) LOG_SINCE="${1#*=}"; shift ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$SESSION_ID" ]]; then
  echo "usage: $0 <session-id> [--json] [--since 2h]" >&2
  exit 2
fi

# Validate session-id format up front. We embed it into SQL strings, so a
# value containing quotes or semicolons would be a shell-injection footgun.
# vonzio session ids are always UUIDs or prefixed nanoids; accept anything
# that looks plausibly like one.
if ! [[ "$SESSION_ID" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "Invalid session id: must match [a-zA-Z0-9_-]+" >&2
  exit 2
fi
# Same defensive validation on --since: it lands inside a shell-eval'd command
# string, so we only allow simple duration values.
if ! [[ "$LOG_SINCE" =~ ^[0-9]+[smhd]$ ]]; then
  echo "Invalid --since: must match <number><s|m|h|d> (e.g. 2h, 30m)" >&2
  exit 2
fi

# `RUN <cmd>` executes the command locally. This script used to support a
# `--host prod` wrapper for a specific hosted deployment; trimmed for the
# OSS release so the script only ever talks to local docker.
RUN() { eval "$*"; }

# Single source-of-truth for the docker compose project's container names.
SERVER_CTR="docker-server-1"
PG_CTR="docker-postgres-1"

# ─── Color helpers ──────────────────────────────────────────────────────
if $JSON_MODE || ! [[ -t 1 ]]; then
  C_RESET=""; C_DIM=""; C_BOLD=""; C_SODIUM=""; C_OK=""; C_WARN=""; C_HEAD=""
else
  C_RESET=$'\033[0m'
  C_DIM=$'\033[2m'
  C_BOLD=$'\033[1m'
  C_SODIUM=$'\033[38;5;208m'
  C_OK=$'\033[32m'
  C_WARN=$'\033[33m'
  C_HEAD=$'\033[1;36m'
fi

heading() { printf "\n%s── %s ──%s\n" "$C_HEAD" "$1" "$C_RESET"; }
kv()      { printf "  %s%-22s%s %s\n" "$C_DIM" "$1" "$C_RESET" "$2"; }

# ─── psql helpers ───────────────────────────────────────────────────────
# Run a SQL query inside the postgres container, return tab-separated rows.
psql_query() {
  local sql="$1"
  RUN "docker exec $PG_CTR psql -U vonzio -d vonzio -tAF$'\t' -c \"$sql\""
}

# Run a SQL query that produces a single JSON value (use `row_to_json` etc.).
psql_json() {
  local sql="$1"
  RUN "docker exec $PG_CTR psql -U vonzio -d vonzio -tAc \"$sql\""
}

# ─── Data fetches ───────────────────────────────────────────────────────
WORKSPACE_JSON=$(psql_json "
  select coalesce(row_to_json(w), '{}'::json)::text
  from workspaces w
  where session_id = '$SESSION_ID'
" || echo '{}')

TASKS_JSON=$(psql_json "
  select coalesce(json_agg(t order by t.created_at desc), '[]'::json)::text
  from (
    select id, status, model, effort, started_at, finished_at, error, created_at
    from tasks
    where session_id = '$SESSION_ID'
    order by created_at desc
    limit 10
  ) t
" || echo '[]')

# Server-log lines mentioning this session id within the configured window.
# The orchestrator includes session_id in structured fields ("sessionId":"…").
# Default 2h keeps the docker-logs scan cheap on busy prod boxes; pass
# --since 24h (or longer) when investigating older sessions.
SERVER_LOG=$(RUN "docker logs --since $LOG_SINCE $SERVER_CTR 2>&1 | grep -F '$SESSION_ID' || true")

CROSS_MODEL_LINES=$(printf '%s\n' "$SERVER_LOG" | grep -F 'Cross-model switch' || true)

# Container state — read container_id off the workspace, then docker inspect.
CONTAINER_ID=$(printf '%s' "$WORKSPACE_JSON" | sed -E 's/.*"container_id":"([^"]+)".*/\1/' | head -c 64)
if [[ -n "$CONTAINER_ID" && "$CONTAINER_ID" != "$WORKSPACE_JSON" ]]; then
  CONTAINER_STATE=$(RUN "docker inspect --format '{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}' '$CONTAINER_ID' 2>/dev/null || echo 'gone'")
else
  CONTAINER_STATE="none"
fi

# ─── JSON mode ──────────────────────────────────────────────────────────
if $JSON_MODE; then
  cat <<JSON
{
  "session_id": "$SESSION_ID",
  "host": "$HOST",
  "workspace": $WORKSPACE_JSON,
  "recent_tasks": $TASKS_JSON,
  "container_state": "$CONTAINER_STATE",
  "cross_model_events": $(printf '%s\n' "$CROSS_MODEL_LINES" | python3 -c 'import sys,json; print(json.dumps([l for l in sys.stdin.read().splitlines() if l]))'),
  "server_log_line_count": $(printf '%s\n' "$SERVER_LOG" | grep -c . || echo 0)
}
JSON
  exit 0
fi

# ─── Terminal report ────────────────────────────────────────────────────
printf "\n%sVonzio session inspect%s · %s%s%s · host=%s\n" "$C_BOLD" "$C_RESET" "$C_SODIUM" "$SESSION_ID" "$C_RESET" "$HOST"

heading "Workspace"
if [[ "$WORKSPACE_JSON" == "{}" || -z "$WORKSPACE_JSON" ]]; then
  printf "  %sno workspace row found%s\n" "$C_WARN" "$C_RESET"
else
  # Pull individual fields via tiny python json parser (always available).
  fields=$(python3 - <<PY
import json, sys
w = json.loads('''$WORKSPACE_JSON''')
keys = ["name","status","profile_id","user_id","container_id","model_override","last_run_model","persistent","public_preview","starred","archived","last_active_at","created_at","expires_at"]
for k in keys:
  v = w.get(k)
  print(f"{k}\t{'' if v is None else v}")
PY
  )
  while IFS=$'\t' read -r key val; do
    if [[ "$key" == "model_override" && -n "$val" ]]; then
      kv "$key" "${C_SODIUM}${val}${C_RESET}"
    elif [[ "$key" == "last_run_model" && -n "$val" ]]; then
      kv "$key" "${C_OK}${val}${C_RESET}"
    elif [[ -z "$val" ]]; then
      kv "$key" "${C_DIM}—${C_RESET}"
    else
      kv "$key" "$val"
    fi
  done <<<"$fields"
fi

heading "Container"
if [[ "$CONTAINER_STATE" == "none" ]]; then
  printf "  %sno container_id on workspace%s\n" "$C_DIM" "$C_RESET"
elif [[ "$CONTAINER_STATE" == "gone" ]]; then
  printf "  %scontainer not found (already destroyed)%s\n" "$C_WARN" "$C_RESET"
else
  IFS='|' read -r status started restarts <<<"$CONTAINER_STATE"
  kv "status"   "$status"
  kv "started"  "$started"
  kv "restarts" "$restarts"
fi

heading "Recent tasks (last 10)"
python3 - <<PY
import json
tasks = json.loads('''$TASKS_JSON''')
if not tasks:
  print("  (none)")
else:
  print(f"  {'started':<22}  {'status':<10}  {'model':<28}  task_id")
  for t in tasks:
    print(f"  {(t.get('started_at') or '')[:22]:<22}  {(t.get('status') or '')[:10]:<10}  {(t.get('model') or '')[:28]:<28}  {t.get('id','')[:24]}")
PY

heading "Cross-model context replay"
if [[ -z "$CROSS_MODEL_LINES" ]]; then
  printf "  %sno cross-model switches logged for this session in last 24h%s\n" "$C_DIM" "$C_RESET"
else
  printf "%s\n" "$CROSS_MODEL_LINES" | sed 's/^/  /'
fi

heading "Server log lines mentioning session (last $LOG_SINCE)"
COUNT=$(printf '%s\n' "$SERVER_LOG" | grep -c . || true)
COUNT="${COUNT:-0}"
if [[ "$COUNT" -eq 0 ]]; then
  printf "  %s(no log lines)%s\n" "$C_DIM" "$C_RESET"
else
  printf "  %s%d lines%s — last 10:\n" "$C_DIM" "$COUNT" "$C_RESET"
  printf '%s\n' "$SERVER_LOG" | tail -10 | sed 's/^/  /'
fi

printf "\n"
