#!/usr/bin/env bash
# Verify how an `sk-ant-oat01-` subscription token authenticates against the
# native Anthropic API. Answers the three open spike questions in
# docs/CLAUDE_SUBSCRIPTION_PROVIDER.md:
#   1. x-api-key vs Authorization: Bearer for our own server-side calls
#   2. does /v1/models accept an inference-scoped oat token?
#   3. is the beta header (oauth-2025-04-20) required / accepted?
#
# Usage:
#   claude setup-token                       # log in, copy the sk-ant-oat01-… token
#   read -rs CLAUDE_OAT && export CLAUDE_OAT # paste token (silent, not echoed)
#   ./scripts/verify-oauth-token.sh
#
# The token is read only from $CLAUDE_OAT and is NEVER printed. Output is just
# HTTP status codes + the first line of each response body.

set -u

TOKEN="${CLAUDE_OAT:-}"
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: set CLAUDE_OAT first:  read -rs CLAUDE_OAT && export CLAUDE_OAT" >&2
  exit 1
fi
case "$TOKEN" in
  sk-ant-oat01-*) ;;
  *) echo "WARN: token does not start with sk-ant-oat01- (got ${TOKEN:0:11}…)" >&2 ;;
esac

VER="anthropic-version: 2023-06-01"
BETA="anthropic-beta: oauth-2025-04-20"
MSG_BODY='{"model":"claude-haiku-4-5","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'

# probe NAME URL METHOD AUTH_HEADER [EXTRA_HEADER] [BODY]
probe() {
  local name="$1" url="$2" method="$3" auth="$4" extra="${5:-}" body="${6:-}"
  local args=(-sS -o /tmp/oat_body.txt -w '%{http_code}' -X "$method" "$url"
              -H "$auth" -H "$VER")
  [[ -n "$extra" ]] && args+=(-H "$extra")
  [[ -n "$body" ]] && args+=(-H "content-type: application/json" -d "$body")
  local code; code=$(curl "${args[@]}")
  printf '%-55s -> %s  %s\n' "$name" "$code" "$(head -c 160 /tmp/oat_body.txt | tr '\n' ' ')"
}

echo "== /v1/messages (the real inference path) =="
probe "messages  x-api-key + beta"        https://api.anthropic.com/v1/messages POST "x-api-key: $TOKEN"        "$BETA" "$MSG_BODY"
probe "messages  x-api-key  no-beta"      https://api.anthropic.com/v1/messages POST "x-api-key: $TOKEN"        ""      "$MSG_BODY"
probe "messages  Bearer    + beta"        https://api.anthropic.com/v1/messages POST "Authorization: Bearer $TOKEN" "$BETA" "$MSG_BODY"
probe "messages  Bearer     no-beta"      https://api.anthropic.com/v1/messages POST "Authorization: Bearer $TOKEN" ""    "$MSG_BODY"

echo
echo "== /v1/models (can we fetch the model list?) =="
probe "models    x-api-key + beta"        https://api.anthropic.com/v1/models   GET  "x-api-key: $TOKEN"        "$BETA"
probe "models    x-api-key  no-beta"      https://api.anthropic.com/v1/models   GET  "x-api-key: $TOKEN"        ""
probe "models    Bearer    + beta"        https://api.anthropic.com/v1/models   GET  "Authorization: Bearer $TOKEN" "$BETA"

rm -f /tmp/oat_body.txt
echo
echo "Read it as: 200 = accepted, 401 = auth rejected, 400 = auth ok but request shape off."
