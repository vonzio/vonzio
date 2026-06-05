#!/usr/bin/env bash
# DEV ONLY — expose the local dev stack through a public tunnel so webhook-based
# plugins (Slack, Telegram) can reach it from the internet.
#
#   make dev-tunnel                         # cloudflared (no account/token)
#   VONZIO_DEV_TUNNEL=ngrok make dev-tunnel # ngrok (needs an authtoken)
#
# Run it in a SECOND terminal alongside `make docker-dev-oss`. Ctrl-C stops the
# tunnel. The public URL is written to .vonzio-dev-tunnel so `make urls` shows
# it. This is a local testing aid — see the banner below.

set -u

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
state_file="${repo_root}/.vonzio-dev-tunnel"
port="${DASHBOARD_PORT:-5173}"
backend="${VONZIO_DEV_TUNNEL:-cloudflared}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; Y=$'\033[33m'; R=$'\033[0m'; D=$'\033[2m'
else
  B=""; Y=""; R=""; D=""
fi

# Production guard: a tunnel must never be how a real deployment is reached.
if [ "${NODE_ENV:-}" = "production" ] || [ -n "${VONZIO_PROD:-}" ]; then
  printf '%s✗ refusing to run: this looks like a production environment.%s\n' "$Y" "$R" >&2
  printf '  Tunnels are a dev-only webhook-testing aid. Production must sit behind\n' >&2
  printf '  your own TLS reverse proxy + firewall — see docs/HARDENING.md.\n' >&2
  exit 1
fi

cat >&2 <<BANNER

${Y}${B}⚠  DEV-ONLY TUNNEL${R}
${D}  This exposes http://localhost:${port} to the public internet so Slack/Telegram
  can deliver webhooks to your laptop. NEVER use a tunnel to serve a production
  instance — it bypasses your firewall/TLS/auth. Production goes behind your own
  reverse proxy (docs/HARDENING.md). Ctrl-C to stop.${R}

BANNER

cleanup() { rm -f "$state_file"; }
trap cleanup EXIT INT TERM

announce() {
  # $1 = public URL
  printf '\n%s%s  Public URL: %s%s\n' "$B" "↗" "$1" "$R" >&2
  printf '%s  • Slack/Telegram webhook + redirect URL → use this base.\n' "$D" >&2
  printf '  • For OAuth-redirect plugins (Slack), set BETTER_AUTH_URL=%s in .env\n' "$1" >&2
  printf '    and restart the stack (Ctrl-C %smake docker-dev-oss%s%s). Inbound\n' "$R$D" "$R$D" "" >&2
  printf '    webhooks (e.g. Telegram) work immediately, no restart needed.%s\n\n' "$R" >&2
}

case "$backend" in
  cloudflared)
    if ! command -v cloudflared >/dev/null 2>&1; then
      printf '%s✗ cloudflared not found.%s Install it (no account needed):\n' "$Y" "$R" >&2
      printf '  macOS:  brew install cloudflared\n' >&2
      printf '  Linux:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n' >&2
      printf '  Or use ngrok: %sVONZIO_DEV_TUNNEL=ngrok make dev-tunnel%s\n' "$B" "$R" >&2
      exit 1
    fi
    # cloudflared streams logs (incl. the *.trycloudflare.com URL) on stderr.
    # Tee through a reader: echo each line, grab the URL once, keep the tunnel
    # in the foreground so Ctrl-C tears it down.
    cloudflared tunnel --url "http://localhost:${port}" 2>&1 | while IFS= read -r line; do
      printf '%s\n' "$line"
      case "$line" in
        *trycloudflare.com*)
          if [ ! -f "$state_file" ]; then
            url="$(printf '%s\n' "$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1)"
            if [ -n "$url" ]; then printf '%s' "$url" > "$state_file"; announce "$url"; fi
          fi
          ;;
      esac
    done
    ;;
  ngrok)
    if ! command -v ngrok >/dev/null 2>&1; then
      printf '%s✗ ngrok not found.%s Install it + add your authtoken once:\n' "$Y" "$R" >&2
      printf '  brew install ngrok && ngrok config add-authtoken <token>\n' >&2
      printf '  (free signup at https://ngrok.com). Or use cloudflared (no token): %smake dev-tunnel%s\n' "$B" "$R" >&2
      exit 1
    fi
    # ngrok's TUI isn't parseable; its local API at :4040 is. Start it in the
    # background, poll the API for the public URL, then wait on it.
    ngrok http "$port" --log stdout >/dev/null 2>&1 &
    ngrok_pid=$!
    trap 'kill "$ngrok_pid" 2>/dev/null; cleanup' EXIT INT TERM
    url=""
    for _ in $(seq 1 30); do
      url="$(curl -fsS http://localhost:4040/api/tunnels 2>/dev/null \
             | grep -oE 'https://[a-z0-9-]+\.ngrok[a-z.-]*\.app' | head -1)"
      [ -n "$url" ] && break
      sleep 1
    done
    if [ -z "$url" ]; then
      printf '%s✗ couldn'\''t read the ngrok URL from its :4040 API.%s Is the authtoken set?\n' "$Y" "$R" >&2
      exit 1
    fi
    printf '%s' "$url" > "$state_file"
    announce "$url"
    wait "$ngrok_pid"
    ;;
  *)
    printf '%s✗ unknown VONZIO_DEV_TUNNEL=%s%s (use cloudflared or ngrok)\n' "$Y" "$backend" "$R" >&2
    exit 1
    ;;
esac
