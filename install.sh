#!/usr/bin/env bash
# vonzio core — one-shot self-host installer
#
# Two entry points (same script):
#   curl -fsSL https://raw.githubusercontent.com/vonzio/core/main/install.sh | bash
#   git clone https://github.com/vonzio/core.git && cd core && ./install.sh
#
# What it does:
#   1. Detects your OS (macOS, Linux distro, or WSL).
#   2. Checks for Docker, Docker Compose v2, Node 22+, git, make, openssl.
#      For each missing dep, asks before installing it.
#   3. If piped from curl with no local clone: prompts for an install
#      directory and git-clones vonzio/core there.
#   4. Generates a fresh .env with secure random secrets (or keeps existing).
#   5. Starts a postgres container, runs Better Auth's schema migrations.
#   6. Brings the stack up via `make docker-dev-oss`.
#   7. Waits for /health and prints the URL to visit.
#
# Flags:
#   --help, -h          Show this header and exit.
#   --version           Print the installer version.
#   --uninstall         Stop containers + ask whether to remove volumes.
#   --dir <path>        Install location for the curl-piped case (default: ~/vonzio).
#   --yes, -y           Auto-confirm all "install missing dep?" prompts.
#   --no-start          Set everything up but don't start the stack.

set -euo pipefail

readonly INSTALLER_VERSION="0.1.0"
readonly REPO_URL="https://github.com/vonzio/core.git"
readonly DEFAULT_INSTALL_DIR="${HOME}/vonzio"
readonly NODE_MIN_MAJOR=22

# ─── Args ──────────────────────────────────────────────────────────────
INSTALL_DIR=""
ASSUME_YES=false
NO_START=false
ACTION="install"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) ACTION="help"; shift ;;
    --version) ACTION="version"; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --dir=*) INSTALL_DIR="${1#*=}"; shift ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    --no-start) NO_START=true; shift ;;
    *) echo "Unknown arg: $1 (try --help)" >&2; exit 2 ;;
  esac
done

# ─── Output helpers ────────────────────────────────────────────────────
if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
  C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_INFO=$'\033[36m'
else
  C_DIM=""; C_BOLD=""; C_RESET=""; C_OK=""; C_WARN=""; C_ERR=""; C_INFO=""
fi

log()  { printf "%s\n" "$*"; }
info() { printf "%s→%s %s\n" "$C_INFO" "$C_RESET" "$*"; }
ok()   { printf "%s✓%s %s\n" "$C_OK" "$C_RESET" "$*"; }
warn() { printf "%s⚠%s  %s\n" "$C_WARN" "$C_RESET" "$*" >&2; }
err()  { printf "%s✗%s %s\n" "$C_ERR" "$C_RESET" "$*" >&2; }
step() { printf "\n%s%s%s\n" "$C_BOLD" "$*" "$C_RESET"; }

confirm() {
  # confirm "prompt text" [default-yes|default-no]
  local prompt="$1" default="${2:-default-yes}"
  if $ASSUME_YES; then return 0; fi
  local hint="[Y/n]"; [[ "$default" == "default-no" ]] && hint="[y/N]"
  local reply
  printf "  %s %s " "$prompt" "$hint"
  if [[ -t 0 ]]; then read -r reply || reply=""
  else read -r reply < /dev/tty || reply=""
  fi
  case "${reply,,}" in
    y|yes) return 0 ;;
    n|no)  return 1 ;;
    "")    [[ "$default" == "default-yes" ]] ;;
    *)     [[ "$default" == "default-yes" ]] ;;
  esac
}

# ─── --help / --version ────────────────────────────────────────────────
case "$ACTION" in
  help)
    sed -n '/^# vonzio core/,/^set -euo/p' "$0" 2>/dev/null | sed -e 's/^# \{0,1\}//' -e '/^set -euo/d'
    exit 0
    ;;
  version) log "vonzio installer v${INSTALLER_VERSION}"; exit 0 ;;
esac

# ─── Banner ────────────────────────────────────────────────────────────
log ""
log "${C_BOLD}vonzio core${C_RESET} installer ${C_DIM}v${INSTALLER_VERSION}${C_RESET}"
log "${C_DIM}https://github.com/vonzio/core${C_RESET}"
log ""

# ─── Detect platform ───────────────────────────────────────────────────
OS=""
DISTRO=""
case "$(uname -s)" in
  Darwin) OS="macos" ;;
  Linux)
    OS="linux"
    if grep -qiE "(microsoft|wsl)" /proc/version 2>/dev/null; then
      OS="wsl"
    fi
    if [[ -f /etc/os-release ]]; then
      # shellcheck disable=SC1091
      DISTRO="$(. /etc/os-release && echo "$ID")"
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    err "Native Windows isn't supported. Use WSL (Ubuntu, Debian) instead."
    err "  See: https://learn.microsoft.com/en-us/windows/wsl/install"
    exit 1
    ;;
  *)
    err "Unsupported OS: $(uname -s)"
    exit 1
    ;;
esac
info "Platform: ${OS}${DISTRO:+ ($DISTRO)}"

# ─── Detect invocation mode ────────────────────────────────────────────
# If BASH_SOURCE[0] resolves to a file under a checkout that already has
# packages/core-server/, we're running from inside a clone. Otherwise the
# script was piped from curl and we need to git-clone first.
IN_CLONE=false
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" ]] && [[ -f "${BASH_SOURCE[0]:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -d "$SCRIPT_DIR/packages/core-server" ]]; then
    IN_CLONE=true
    INSTALL_DIR="$SCRIPT_DIR"
  fi
fi

if ! $IN_CLONE; then
  info "Running in one-shot mode (piped from curl)."
fi

# ─── --uninstall ───────────────────────────────────────────────────────
if [[ "$ACTION" == "uninstall" ]]; then
  step "Uninstalling vonzio core"
  target="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
  if [[ ! -d "$target/docker" ]]; then
    warn "Couldn't find a vonzio install at $target. Pass --dir <path> if it lives elsewhere."
    exit 1
  fi
  cd "$target"
  info "Stopping containers…"
  (cd docker && docker compose -f docker-compose.yml -f docker-compose.dev.yml down 2>&1 | tail -3) || true
  docker rm -f vonzio-pg 2>/dev/null && info "Removed standalone postgres" || true
  if confirm "Remove postgres volume + agent session volumes? (irreversible)" "default-no"; then
    docker volume rm docker_pgdata 2>/dev/null || true
    docker volume ls -q | grep -E "^vonzio-(ws|sdk)-" | xargs -r docker volume rm 2>/dev/null || true
    ok "Volumes removed."
  fi
  log ""
  ok "Uninstalled. The vonzio/core checkout at $target was kept — delete it manually if you want."
  exit 0
fi

# ─── Dep checks ────────────────────────────────────────────────────────
require_cmd() { command -v "$1" >/dev/null 2>&1; }

sudo_install() {
  local pkg="$1"
  if require_cmd apt-get; then sudo apt-get update -y && sudo apt-get install -y "$pkg"
  elif require_cmd dnf;     then sudo dnf install -y "$pkg"
  elif require_cmd yum;     then sudo yum install -y "$pkg"
  elif require_cmd apk;     then sudo apk add --no-cache "$pkg"
  elif require_cmd pacman;  then sudo pacman -S --noconfirm "$pkg"
  else err "Don't know your package manager. Install '$pkg' manually."; exit 1
  fi
}

ensure_git() {
  if require_cmd git; then ok "git $(git --version | awk '{print $3}')"; return; fi
  warn "git not found."
  case "$OS" in
    macos) log "  Install: ${C_DIM}xcode-select --install${C_RESET} (Xcode CLI tools)"; exit 1 ;;
    linux|wsl)
      if confirm "Install git via your package manager?" "default-yes"; then
        sudo_install git
      else
        err "git is required."; exit 1
      fi
      ;;
  esac
  require_cmd git || { err "git still missing."; exit 1; }
  ok "git installed."
}

ensure_make() {
  if require_cmd make; then ok "make"; return; fi
  warn "make not found."
  case "$OS" in
    macos) log "  Install: ${C_DIM}xcode-select --install${C_RESET}"; exit 1 ;;
    linux|wsl)
      if confirm "Install build-essential / make?" "default-yes"; then
        if require_cmd apt-get; then sudo apt-get update -y && sudo apt-get install -y build-essential
        else sudo_install make
        fi
      else
        err "make is required."; exit 1
      fi
      ;;
  esac
  require_cmd make || { err "make still missing."; exit 1; }
}

ensure_openssl() {
  if require_cmd openssl; then ok "openssl"; return; fi
  warn "openssl not found — needed to generate secure secrets."
  case "$OS" in
    macos) err "  Install via Homebrew: brew install openssl"; exit 1 ;;
    linux|wsl)
      if confirm "Install openssl?" "default-yes"; then sudo_install openssl
      else err "openssl is required."; exit 1
      fi
      ;;
  esac
}

ensure_docker() {
  if require_cmd docker && docker info >/dev/null 2>&1; then
    ok "Docker $(docker --version | awk '{print $3}' | tr -d ',') (running)"
    if docker compose version >/dev/null 2>&1; then
      ok "Docker Compose v2"
    else
      err "Docker Compose v2 is required. The legacy 'docker-compose' v1 binary won't work."
      err "  → On Linux, install docker-compose-plugin via your distro's package manager."
      err "  → On macOS, Docker Desktop bundles it; update Docker Desktop."
      exit 1
    fi
    return
  fi
  warn "Docker not running (or not installed)."
  case "$OS" in
    macos)
      log "  Install Docker Desktop: ${C_DIM}https://docs.docker.com/desktop/install/mac-install/${C_RESET}"
      log "  Then start Docker Desktop and re-run this script."
      exit 1
      ;;
    linux|wsl)
      if confirm "Install Docker via the official get-docker.sh script?" "default-yes"; then
        curl -fsSL https://get.docker.com | sh
        sudo usermod -aG docker "$USER" 2>/dev/null || true
        warn "Added you to the 'docker' group. You may need to log out and back in for it to take effect."
        info "Trying to start Docker daemon…"
        sudo systemctl start docker 2>/dev/null || true
        if ! docker info >/dev/null 2>&1; then
          err "Docker daemon isn't reachable. Start it (e.g. \`sudo systemctl start docker\`) and re-run."
          exit 1
        fi
      else
        err "Docker is required."; exit 1
      fi
      ;;
  esac
}

ensure_node() {
  local current_major=""
  if require_cmd node; then
    current_major="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
    if (( current_major >= NODE_MIN_MAJOR )); then
      ok "Node v$(node --version | sed 's/^v//')"
      return
    fi
    warn "Node v$(node --version) is too old. Need v${NODE_MIN_MAJOR}+."
  else
    warn "Node not found."
  fi
  case "$OS" in
    macos)
      if require_cmd brew; then
        if confirm "Install Node ${NODE_MIN_MAJOR} via Homebrew?" "default-yes"; then
          brew install "node@${NODE_MIN_MAJOR}"
          brew link --overwrite --force "node@${NODE_MIN_MAJOR}"
        else
          err "Node ${NODE_MIN_MAJOR}+ is required."; exit 1
        fi
      else
        err "  Install Homebrew (${C_DIM}https://brew.sh${C_RESET}) then re-run, or install Node v${NODE_MIN_MAJOR}+ manually."
        exit 1
      fi
      ;;
    linux|wsl)
      if confirm "Install Node ${NODE_MIN_MAJOR} via NodeSource?" "default-yes"; then
        curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x" | sudo -E bash -
        sudo_install nodejs
      else
        err "Node ${NODE_MIN_MAJOR}+ is required."; exit 1
      fi
      ;;
  esac
  if ! require_cmd node || (( $(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))') < NODE_MIN_MAJOR )); then
    err "Node install didn't take. Install Node v${NODE_MIN_MAJOR}+ manually and re-run."
    exit 1
  fi
  ok "Node v$(node --version | sed 's/^v//')"
}

# ─── Run dep checks ────────────────────────────────────────────────────
step "[1/5] Checking prerequisites"
ensure_git
ensure_make
ensure_openssl
ensure_docker
ensure_node

# ─── Clone if running from curl ────────────────────────────────────────
step "[2/5] Source tree"
if ! $IN_CLONE; then
  if [[ -z "$INSTALL_DIR" ]]; then
    if $ASSUME_YES; then
      INSTALL_DIR="$DEFAULT_INSTALL_DIR"
    else
      printf "  Install location [%s]: " "$DEFAULT_INSTALL_DIR"
      if [[ -t 0 ]]; then read -r INSTALL_DIR || INSTALL_DIR=""
      else read -r INSTALL_DIR < /dev/tty || INSTALL_DIR=""
      fi
      INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
    fi
  fi
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Existing checkout at $INSTALL_DIR — pulling latest."
    (cd "$INSTALL_DIR" && git pull --ff-only) || warn "git pull --ff-only failed; continuing with current commit."
  else
    info "Cloning vonzio/core → $INSTALL_DIR"
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi
  cd "$INSTALL_DIR"
else
  cd "$INSTALL_DIR"
  ok "Using existing checkout at $INSTALL_DIR"
fi

# ─── Generate .env ─────────────────────────────────────────────────────
step "[3/5] Configuration"
gen_secret() { openssl rand -base64 32 | tr -d '/+=' | cut -c1-32; }
sed_inplace() {
  # macOS sed needs '' after -i; GNU sed doesn't. Detect by trying --version.
  if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi
}

if [[ -f .env ]]; then
  ok ".env exists — keeping it (delete it manually to regenerate)."
else
  if [[ ! -f .env.example ]]; then
    err "No .env.example in $INSTALL_DIR — is this a vonzio checkout?"
    exit 1
  fi
  info "Generating .env from .env.example with fresh secrets…"
  cp .env.example .env
  ENC_KEY="$(gen_secret)"
  AUTH_KEY="$(gen_secret)"
  sed_inplace "s|^ENCRYPTION_KEY=$|ENCRYPTION_KEY=${ENC_KEY}|" .env
  sed_inplace "s|^BETTER_AUTH_SECRET=$|BETTER_AUTH_SECRET=${AUTH_KEY}|" .env
  ok ".env created (32-char random ENCRYPTION_KEY + BETTER_AUTH_SECRET)."
  warn "Back up .env now — losing ENCRYPTION_KEY bricks your credential vault."
fi

# ─── npm install ───────────────────────────────────────────────────────
if [[ ! -d node_modules ]]; then
  info "Installing npm dependencies (one-time, ~1 min)…"
  npm install --silent
  ok "npm install complete."
else
  ok "node_modules present — skipping npm install."
fi

# ─── Postgres ──────────────────────────────────────────────────────────
step "[4/5] Database"
PG_CONTAINER="vonzio-pg"

if docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}\$"; then
  ok "Postgres container '${PG_CONTAINER}' already running."
elif docker ps -a --format '{{.Names}}' | grep -q "^${PG_CONTAINER}\$"; then
  info "Postgres container exists but stopped — starting it."
  docker start "$PG_CONTAINER" >/dev/null
  ok "Postgres started."
else
  info "Starting postgres container '${PG_CONTAINER}' on :5432…"
  docker run -d \
    -e POSTGRES_DB=vonzio \
    -e POSTGRES_USER=vonzio \
    -e POSTGRES_PASSWORD=vonzio_dev \
    -p 5432:5432 \
    --name "$PG_CONTAINER" \
    --restart=unless-stopped \
    postgres:17-alpine >/dev/null
  ok "Postgres started."
fi

info "Waiting for postgres to accept connections…"
for i in {1..30}; do
  if docker exec "$PG_CONTAINER" pg_isready -U vonzio >/dev/null 2>&1; then
    ok "Postgres ready."
    break
  fi
  sleep 1
  if (( i == 30 )); then
    err "Postgres didn't become ready in 30s. Check 'docker logs $PG_CONTAINER'."
    exit 1
  fi
done

# Better Auth schema migration (idempotent — only creates missing tables)
info "Applying Better Auth schema migration…"
if make better-auth-migrate >/tmp/vonzio-bauth.log 2>&1; then
  ok "Better Auth tables ready."
else
  warn "make better-auth-migrate didn't exit cleanly. Last output:"
  tail -20 /tmp/vonzio-bauth.log >&2
  exit 1
fi

# ─── Start stack ───────────────────────────────────────────────────────
step "[5/5] Stack"
if $NO_START; then
  log ""
  ok "Setup complete (stack not started — --no-start was passed)."
  log ""
  log "Next:"
  log "  cd $INSTALL_DIR"
  log "  make docker-dev-oss   ${C_DIM}# full Docker stack with Traefik${C_RESET}"
  log "  ${C_DIM}# OR${C_RESET}"
  log "  make dev-oss          ${C_DIM}# host-mode (faster iteration, needs the postgres above)${C_RESET}"
  exit 0
fi

info "Starting the vonzio stack in OSS mode…"
log "  ${C_DIM}First boot builds the agent base image (~3 min cold on Apple Silicon).${C_RESET}"
log "  ${C_DIM}Logs streaming below. Ctrl-C stops the stack cleanly.${C_RESET}"
log ""

# Print the "open this URL" hint after a few seconds so it appears
# alongside the early boot logs and isn't lost above the build output.
( sleep 10
  log ""
  ok "When you see 'Server listening' below, open:"
  log "    ${C_BOLD}http://vonz.localhost${C_RESET}"
  log "  First visit lands on /setup — create your admin account, then onboarding."
  log "" ) &

exec make docker-dev-oss
