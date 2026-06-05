#!/usr/bin/env bash
# Print the dev stack's addresses so you know where everything is.
#
#   scripts/dev-urls.sh           # print now
#   scripts/dev-urls.sh --wait    # poll /health first, then print (used by
#                                 # `make docker-dev` so the panel lands once
#                                 # the server is actually serving)
#
# The public webhook URL only shows when a dev tunnel is active — start one
# with `make dev-tunnel` (writes .vonzio-dev-tunnel, read here).

set -u

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
env_file="${repo_root}/.env"
tunnel_file="${repo_root}/.vonzio-dev-tunnel"

# Dashboard port: env override → .env → default 5173.
dash_port="${DASHBOARD_PORT:-}"
if [ -z "$dash_port" ] && [ -f "$env_file" ]; then
  dash_port="$(sed -n 's/^DASHBOARD_PORT=//p' "$env_file" 2>/dev/null | tail -1)"
fi
[ -n "$dash_port" ] || dash_port=5173
api_port=3000
dash_url="http://localhost:${dash_port}"
api_url="http://localhost:${api_port}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'; C=$'\033[36m'
else
  B=""; D=""; R=""; C=""
fi

# --wait: hold until /health answers (cold builds take a few minutes), so the
# summary appears next to "Server listening" instead of minutes early.
if [ "${1:-}" = "--wait" ]; then
  deadline=$(( $(date +%s) + ${VONZIO_HEALTH_TIMEOUT:-240} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if command -v curl >/dev/null 2>&1 && curl -fsS -o /dev/null "${dash_url}/health" 2>/dev/null; then
      break
    fi
    sleep 2
  done
fi

tunnel=""
[ -f "$tunnel_file" ] && tunnel="$(cat "$tunnel_file" 2>/dev/null)"

printf '\n%s  vonzio is up%s\n' "$B" "$R"
printf '    %-11s %s%s%s  %s← open this%s\n'      "Dashboard" "$C" "$dash_url" "$R" "$D" "$R"
printf '    %-11s %s%s%s  %s(/health, /v1)%s\n'   "API"       "$C" "$api_url"  "$R" "$D" "$R"
if [ -n "$tunnel" ]; then
  printf '    %-11s %s%s%s  %s(public — Slack/Telegram callbacks)%s\n' "Webhooks" "$C" "$tunnel" "$R" "$D" "$R"
else
  printf '    %-11s %snone — run %smake dev-tunnel%s%s for Slack/Telegram webhooks%s\n' \
    "Webhooks" "$D" "$B" "$R" "$D" "$R"
fi
printf '\n'
