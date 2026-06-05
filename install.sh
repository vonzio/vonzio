#!/usr/bin/env bash
# vonzio core — one-shot self-host installer
#
# Two entry points (same script):
#   curl -fsSL https://raw.githubusercontent.com/vonzio/vonzio/main/install.sh | bash
#   git clone https://github.com/vonzio/vonzio.git && cd vonzio && ./install.sh
#
# What it does:
#   1. Detects your OS (macOS, Linux distro, or WSL).
#   2. Checks for Docker, Docker Compose v2, Node 22+, git, make, openssl.
#      For each missing dep, asks before installing it.
#   3. If piped from curl with no local clone: resolves a target release
#      tag (latest by default, or whatever `--tag` / `VONZIO_VERSION`
#      specifies), prompts for an install directory, and git-clones
#      vonzio/vonzio there at that tag.
#   4. Generates a fresh .env with secure random secrets (or keeps existing).
#   5. Starts a postgres container, runs Better Auth's schema migrations.
#   6. Brings the stack up via `make docker-dev-oss`.
#   7. Polls /health and prints (and opens) the URL once it's serving.
#
# Flags:
#   --help, -h          Show this header and exit.
#   --version           Print the installer version.
#   --tag <tag>         Vonzio release to install (default: latest v* tag).
#                       Also reads VONZIO_VERSION from the environment.
#                       Example: --tag v0.1.3  or  VONZIO_VERSION=v0.1.3
#   --uninstall         Stop containers + ask whether to remove volumes.
#   --dir <path>        Install location for the curl-piped case (default: ~/vonzio).
#   --yes, -y           Auto-confirm all "install missing dep?" prompts.
#   --no-start          Set everything up but don't start the stack.
#   --reset-env         Back up an existing .env and regenerate it.
#
# Env knobs (mostly for CI/automation):
#   VONZIO_NO_OPEN=1    Don't open a browser when the stack is ready.
#   NO_COLOR=1          Disable ANSI colors.
#
# Testability: every routine lives in a function and execution is gated on
# the `BASH_SOURCE == $0` guard at the bottom, so a test harness can
# `source` this file to unit-test individual functions without running the
# installer. See test/install.bats.

# -E (errtrace) so the ERR trap fires inside functions too.
set -Eeuo pipefail

readonly INSTALLER_VERSION="0.1.3"
readonly REPO_URL="https://github.com/vonzio/vonzio.git"
readonly DEFAULT_INSTALL_DIR="${HOME}/vonzio"
readonly NODE_MIN_MAJOR=22
# How long to poll /health before falling back to a "watch the logs" hint.
readonly HEALTH_TIMEOUT_SECS="${VONZIO_HEALTH_TIMEOUT:-240}"
# Pre-flight disk guidance: the agent base image + node_modules + pg volume.
readonly RECOMMENDED_DISK_GB="${VONZIO_MIN_DISK_GB:-10}"

# ─── Args (assigned by parse_args) ─────────────────────────────────────
INSTALL_DIR=""
TARGET_TAG="${VONZIO_VERSION:-}"
ASSUME_YES=false
NO_START=false
RESET_ENV=false
ACTION="install"

# ─── Pre-flight state ──────────────────────────────────────────────────
MISSING_DEPS=()          # populated by preflight_deps
DEPS_AUTOCONFIRM=false   # user consented once in the pre-flight summary

# ─── Platform (assigned by detect_platform / detect_mode) ──────────────
OS=""
DISTRO=""
IN_CLONE=false
SCRIPT_DIR=""

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

# Resolve the release tag we should install at. Precedence:
#   1. --tag flag (already captured in $TARGET_TAG)
#   2. VONZIO_VERSION env var (also captured in $TARGET_TAG at startup)
#   3. Latest v* tag advertised by the remote (git ls-remote, semver desc)
# Empty result means "couldn't resolve" — caller falls back to main HEAD
# with a warning rather than silently breaking the install.
resolve_target_tag() {
  if [[ -n "$TARGET_TAG" ]]; then
    printf '%s' "$TARGET_TAG"; return
  fi
  local latest
  latest="$(git ls-remote --tags --refs --sort=-v:refname "$REPO_URL" 'v*' 2>/dev/null \
            | awk 'NR==1{sub(/.*refs\/tags\//,"",$2); print $2}')"
  printf '%s' "$latest"
}

gen_secret() { openssl rand -base64 32 | tr -d '/+=' | cut -c1-32; }

sed_inplace() {
  # macOS sed needs '' after -i; GNU sed doesn't. Detect by trying --version.
  if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi
}

open_browser() {
  # Best-effort: open the dashboard once it's up. Silenced + never fatal.
  local url="$1"
  [[ -n "${VONZIO_NO_OPEN:-}" ]] && return 0
  if   require_cmd open;     then open "$url" >/dev/null 2>&1 || true       # macOS
  elif require_cmd xdg-open; then xdg-open "$url" >/dev/null 2>&1 || true   # Linux
  fi
}

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

# Distinguish the three ways `docker info` can fail so the guidance is
# actionable instead of a blanket "daemon isn't reachable":
#   - permission denied  → user not in the docker group yet (needs re-login)
#   - anything else       → daemon not started
docker_unreachable_reason() {
  local out
  out="$(docker info 2>&1 >/dev/null || true)"
  if printf '%s' "$out" | grep -qi "permission denied"; then
    printf 'permission'
  else
    printf 'daemon'
  fi
}

install_docker_linux() {
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" 2>/dev/null || true
  # systemd on most distros; `service` on WSL/sysvinit.
  sudo systemctl start docker 2>/dev/null || sudo service docker start 2>/dev/null || true
  if docker info >/dev/null 2>&1; then
    ok "Docker installed and running."
    return 0
  fi
  # Installed but our session can't reach it yet — say *why*, precisely.
  if [[ "$(docker_unreachable_reason)" == "permission" ]]; then
    warn "Docker is installed, and you've been added to the 'docker' group — but that group"
    warn "isn't active in this shell yet, so Docker still can't be reached."
    log  "  ${C_BOLD}Log out and back in${C_RESET} (or run ${C_DIM}newgrp docker${C_RESET}), then re-run this script."
  else
    warn "Docker is installed but the daemon isn't running."
    log  "  Start it (${C_DIM}sudo systemctl start docker${C_RESET} or ${C_DIM}sudo service docker start${C_RESET}) and re-run."
  fi
  exit 1
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

  # Docker is present but unusable — installed-but-stopped or a permission gap.
  if require_cmd docker; then
    if [[ "$(docker_unreachable_reason)" == "permission" ]]; then
      warn "Docker is installed but you don't have permission to use it (not in the 'docker' group)."
      log  "  Fix: ${C_DIM}sudo usermod -aG docker \$USER${C_RESET}, then ${C_BOLD}log out and back in${C_RESET}"
      log  "       (or run ${C_DIM}newgrp docker${C_RESET}), and re-run this script."
      exit 1
    fi
    warn "Docker is installed but the daemon isn't running."
    case "$OS" in
      macos) log "  Start Docker Desktop, wait until it's ready, then re-run." ;;
      wsl)   log "  Start it with ${C_DIM}sudo service docker start${C_RESET} (or enable Docker Desktop's WSL integration), then re-run." ;;
      *)     log "  Start it with ${C_DIM}sudo systemctl start docker${C_RESET}, then re-run." ;;
    esac
    exit 1
  fi

  # Docker is not installed at all.
  warn "Docker not found."
  case "$OS" in
    macos)
      if require_cmd brew && confirm "Install Docker Desktop via Homebrew (brew install --cask docker)?" "default-yes"; then
        brew install --cask docker
        log "  Installed. ${C_BOLD}Start Docker Desktop${C_RESET}, wait until it's ready, then re-run this script."
        exit 1
      fi
      log "  Install Docker Desktop: ${C_DIM}https://docs.docker.com/desktop/install/mac-install/${C_RESET}"
      log "  Then start it and re-run this script."
      exit 1
      ;;
    wsl)
      log "  On WSL the smoothest path is Docker Desktop with WSL2 integration:"
      log "    ${C_DIM}https://docs.docker.com/desktop/wsl/${C_RESET}"
      if confirm "Install the Docker engine in-distro via get-docker.sh instead?" "default-no"; then
        install_docker_linux
      else
        err "Docker is required."; exit 1
      fi
      ;;
    linux)
      if confirm "Install Docker via the official get-docker.sh script?" "default-yes"; then
        install_docker_linux
      else
        err "Docker is required."; exit 1
      fi
      ;;
  esac
}

node_major() { node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))'; }

install_node_linux() {
  # NodeSource ships SEPARATE setup scripts for deb- vs rpm-based distros;
  # using the deb script on Fedora/RHEL silently no-ops and leaves you on
  # whatever (often too-old) nodejs the base repo has.
  if require_cmd apt-get; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  elif require_cmd dnf || require_cmd yum; then
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MIN_MAJOR}.x" | sudo -E bash -
    sudo_install nodejs
  else
    # apk (Alpine) / pacman (Arch): the distro package tracks current Node.
    sudo_install nodejs
  fi
}

ensure_node() {
  local current_major=""
  if require_cmd node; then
    current_major="$(node_major)"
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
        err "  Install Homebrew (${C_DIM}https://brew.sh${C_RESET}) then re-run, or install Node v${NODE_MIN_MAJOR}+ manually"
        err "  (e.g. via nvm: ${C_DIM}https://github.com/nvm-sh/nvm${C_RESET})."
        exit 1
      fi
      ;;
    linux|wsl)
      if confirm "Install Node ${NODE_MIN_MAJOR} via NodeSource?" "default-yes"; then
        install_node_linux
      else
        err "Node ${NODE_MIN_MAJOR}+ is required."; exit 1
      fi
      ;;
  esac
  if ! require_cmd node || (( $(node_major) < NODE_MIN_MAJOR )); then
    err "Node install didn't take. Install Node v${NODE_MIN_MAJOR}+ manually and re-run."
    exit 1
  fi
  ok "Node v$(node --version | sed 's/^v//')"
}

# ─── Pre-flight checks ─────────────────────────────────────────────────
on_error() {
  local code=$? line="${1:-?}"
  err "Install failed (exit ${code}, near line ${line})."
  err "  Fix the error above and re-run — re-running is safe (it picks up where it left off)."
}

# Best-effort "is something LISTENing on this TCP port?" across lsof/ss.
# Returns 1 (assume free) when we have no tool to check with.
port_in_use() {
  local p="$1"
  if require_cmd lsof; then lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; return; fi
  if require_cmd ss;   then ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ":${p}\$"; return; fi
  return 1
}

# Free whole-GB on the filesystem backing $1 (or $HOME). Echoes an integer.
disk_free_gb() {
  df -Pk "${1:-$HOME}" 2>/dev/null | awk 'NR==2 { printf "%d", int($4/1024/1024) }'
}

_dep_ok()   { printf "    %s✓%s %-9s %s\n" "$C_OK"  "$C_RESET" "$1" "${2:-}"; }
_dep_miss() { printf "    %s✗%s %-9s %s%s%s\n" "$C_ERR" "$C_RESET" "$1" "$C_DIM" "${2:-will install}" "$C_RESET"; }

# Read-only scan of every prerequisite. Builds MISSING_DEPS, prints a
# summary, and asks ONCE to install whatever's missing (instead of a
# prompt per dep). Sets DEPS_AUTOCONFIRM so check_prereqs won't re-ask.
preflight_deps() {
  MISSING_DEPS=()
  log "  Prerequisites:"
  if require_cmd git;     then _dep_ok git "$(git --version | awk '{print $3}')"; else _dep_miss git; MISSING_DEPS+=(git); fi
  if require_cmd make;    then _dep_ok make; else _dep_miss make; MISSING_DEPS+=(make); fi
  if require_cmd openssl; then _dep_ok openssl; else _dep_miss openssl; MISSING_DEPS+=(openssl); fi
  if require_cmd docker && docker info >/dev/null 2>&1; then
    if docker compose version >/dev/null 2>&1; then
      _dep_ok docker "$(docker --version | awk '{print $3}' | tr -d ',') + compose v2"
    else
      _dep_miss docker "Compose v2 missing"; MISSING_DEPS+=(docker)
    fi
  else
    _dep_miss docker; MISSING_DEPS+=(docker)
  fi
  local nv=0; require_cmd node && nv="$(node_major 2>/dev/null || echo 0)"
  if (( nv >= NODE_MIN_MAJOR )); then _dep_ok node "v$(node --version | sed 's/^v//')"; else _dep_miss node "need ${NODE_MIN_MAJOR}+"; MISSING_DEPS+=(node); fi

  if (( ${#MISSING_DEPS[@]} == 0 )); then
    ok "All prerequisites present."
    return 0
  fi
  warn "Missing / outdated: ${MISSING_DEPS[*]}"
  if confirm "Install the missing prerequisite(s) and continue?" "default-yes"; then
    DEPS_AUTOCONFIRM=true
  else
    err "Can't continue without: ${MISSING_DEPS[*]}"
    exit 1
  fi
}

preflight_ports() {
  local dash_port="${DASHBOARD_PORT:-5173}" conflicts=()
  port_in_use "$dash_port" && conflicts+=("${dash_port} (dashboard)")
  port_in_use 3000 && conflicts+=("3000 (API)")
  if (( ${#conflicts[@]} > 0 )); then
    warn "Port(s) already in use: ${conflicts[*]}"
    log  "  The stack binds these — a conflict makes it fail to start. Stop whatever's using"
    log  "  them, or set ${C_DIM}DASHBOARD_PORT${C_RESET} in .env to a free port."
    confirm "Continue anyway?" "default-no" || { err "Aborting on port conflict."; exit 1; }
  else
    ok "Ports ${dash_port} + 3000 are free."
  fi
}

preflight_disk() {
  local target="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}" free
  # In curl mode the dir doesn't exist yet — measure the nearest parent.
  while [[ ! -d "$target" && "$target" != "/" ]]; do target="$(dirname "$target")"; done
  free="$(disk_free_gb "$target")"
  [[ -z "$free" ]] && return 0   # couldn't measure → skip silently
  if (( free < RECOMMENDED_DISK_GB )); then
    warn "Low disk: ~${free} GB free where vonzio installs. Recommended: ${RECOMMENDED_DISK_GB} GB+"
    log  "  (the agent base image alone is multi-GB, plus node_modules + the postgres volume)."
    confirm "Continue anyway?" "default-no" || { err "Aborting on low disk."; exit 1; }
  else
    ok "Disk: ~${free} GB free."
  fi
}

preflight() {
  step "[1/6] Pre-flight"
  preflight_deps
  preflight_ports
  preflight_disk
}

# ─── Arg parsing ───────────────────────────────────────────────────────
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h) ACTION="help"; shift ;;
      --version) ACTION="version"; shift ;;
      --uninstall) ACTION="uninstall"; shift ;;
      --dir) INSTALL_DIR="$2"; shift 2 ;;
      --dir=*) INSTALL_DIR="${1#*=}"; shift ;;
      --tag) TARGET_TAG="$2"; shift 2 ;;
      --tag=*) TARGET_TAG="${1#*=}"; shift ;;
      --yes|-y) ASSUME_YES=true; shift ;;
      --no-start) NO_START=true; shift ;;
      --reset-env) RESET_ENV=true; shift ;;
      *) echo "Unknown arg: $1 (try --help)" >&2; exit 2 ;;
    esac
  done
}

show_help() {
  sed -n '/^# vonzio core/,/^set -/p' "$0" 2>/dev/null | sed -e 's/^# \{0,1\}//' -e '/^set -/d'
}

print_banner() {
  log ""
  log "${C_BOLD}vonzio core${C_RESET} installer ${C_DIM}v${INSTALLER_VERSION}${C_RESET}"
  log "${C_DIM}https://github.com/vonzio/vonzio${C_RESET}"
  log ""
}

detect_platform() {
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
}

detect_mode() {
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
}

do_uninstall() {
  step "Uninstalling vonzio core"
  local target="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
  if [[ ! -d "$target/docker" ]]; then
    warn "Couldn't find a vonzio install at $target. Pass --dir <path> if it lives elsewhere."
    exit 1
  fi
  cd "$target"
  info "Stopping containers…"
  (cd docker && docker compose -f docker-compose.yml -f docker-compose.dev.yml down 2>&1 | tail -3) || true
  # Legacy standalone postgres from older installer versions. Today the
  # compose stack brings its own postgres up; this remove is a no-op
  # for fresh installs.
  docker rm -f vonzio-pg 2>/dev/null && info "Removed legacy standalone postgres" || true
  if confirm "Remove postgres volume + agent session volumes? (irreversible)" "default-no"; then
    # vonzio_pgdata is the current name (project `vonzio`); docker_pgdata is the
    # legacy name from when the project defaulted to the docker/ dir — remove
    # both so older installs get cleaned up too.
    docker volume rm vonzio_pgdata docker_pgdata 2>/dev/null || true
    docker volume ls -q | grep -E "^vonzio-(ws|sdk)-" | xargs -r docker volume rm 2>/dev/null || true
    ok "Volumes removed."
  fi
  log ""
  ok "Uninstalled. The vonzio/vonzio checkout at $target was kept — delete it manually if you want."
}

check_prereqs() {
  step "[2/6] Prerequisites"
  if (( ${#MISSING_DEPS[@]} == 0 )); then
    ok "Nothing to install — all present."
    return 0
  fi
  # The single pre-flight consent stands in for the per-dep prompts.
  local saved_yes=$ASSUME_YES
  $DEPS_AUTOCONFIRM && ASSUME_YES=true
  local dep
  for dep in "${MISSING_DEPS[@]}"; do
    "ensure_${dep}"
  done
  ASSUME_YES=$saved_yes
}

setup_source_tree() {
  step "[3/6] Source tree"
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

    # Resolve target release tag. Default = latest v* on the remote. Falls
    # back to main HEAD only if the remote has no tags — fresh empty repo
    # case during early bootstrap. Otherwise we pin so every install is
    # reproducible.
    local target_ref
    target_ref="$(resolve_target_tag)"
    if [[ -z "$target_ref" ]]; then
      warn "Couldn't resolve a release tag from $REPO_URL — falling back to main HEAD."
      target_ref="main"
    fi
    info "Target version: ${target_ref}"

    if [[ -d "$INSTALL_DIR/.git" ]]; then
      info "Existing checkout at $INSTALL_DIR — fetching and switching to ${target_ref}."
      if ! (cd "$INSTALL_DIR" && git fetch --tags --quiet origin && git checkout --quiet "$target_ref"); then
        err "Failed to switch $INSTALL_DIR to ${target_ref}."
        err "  If you have local commits or uncommitted changes there, stash or move them and re-run."
        exit 1
      fi
    else
      info "Cloning vonzio/vonzio @ ${target_ref} → $INSTALL_DIR"
      git clone --quiet --branch "$target_ref" --depth 1 "$REPO_URL" "$INSTALL_DIR"
    fi
    cd "$INSTALL_DIR"
  else
    cd "$INSTALL_DIR"
    ok "Using existing checkout at $INSTALL_DIR"
    # In-clone mode: never touch the user's tree. If they're on a non-tag
    # commit and a newer release exists, print a hint.
    if [[ -n "$TARGET_TAG" ]]; then
      warn "--tag / VONZIO_VERSION is ignored when running from an existing checkout."
      warn "  To install a specific tag here, run: git fetch --tags && git checkout ${TARGET_TAG}"
    else
      local latest_tag current_ref
      latest_tag="$(resolve_target_tag || true)"
      current_ref="$(git -C "$INSTALL_DIR" describe --tags --exact-match 2>/dev/null || true)"
      if [[ -n "$latest_tag" && "$current_ref" != "$latest_tag" ]]; then
        info "Latest release: ${latest_tag} (you're on $(git -C "$INSTALL_DIR" describe --always --dirty 2>/dev/null || echo unknown))."
        info "  Curl-piped installs default to the latest release — re-run via curl or 'git checkout ${latest_tag}' to pin."
      fi
    fi
  fi
}

setup_env() {
  step "[4/6] Configuration"
  if [[ -f .env ]] && ! $RESET_ENV; then
    ok ".env exists — keeping it (re-run with --reset-env to regenerate)."
  else
    if [[ ! -f .env.example ]]; then
      err "No .env.example in $INSTALL_DIR — is this a vonzio checkout?"
      exit 1
    fi
    if [[ -f .env ]]; then
      # --reset-env: never silently clobber secrets — back the old file up.
      local backup
      backup=".env.backup.$(date +%Y%m%d-%H%M%S)"
      cp .env "$backup"
      warn "Backed up existing .env → ${backup} (it has your OLD ENCRYPTION_KEY — keep it if you have encrypted data)."
    fi
    info "Generating .env from .env.example with fresh secrets…"
    cp .env.example .env
    local enc_key auth_key pg_pass
    enc_key="$(gen_secret)"
    auth_key="$(gen_secret)"
    pg_pass="$(openssl rand -hex 16)"
    sed_inplace "s|^ENCRYPTION_KEY=$|ENCRYPTION_KEY=${enc_key}|" .env
    sed_inplace "s|^BETTER_AUTH_SECRET=$|BETTER_AUTH_SECRET=${auth_key}|" .env
    sed_inplace "s|^POSTGRES_PASSWORD=$|POSTGRES_PASSWORD=${pg_pass}|" .env
    ok ".env created (random ENCRYPTION_KEY + BETTER_AUTH_SECRET + POSTGRES_PASSWORD)."
    warn "Back up .env now — losing ENCRYPTION_KEY bricks your credential vault."
  fi
}

setup_npm() {
  if [[ ! -d node_modules ]]; then
    info "Installing npm dependencies (one-time, ~1 min)…"
    npm install --silent
    ok "npm install complete."
  else
    ok "node_modules present — skipping npm install."
  fi
}

setup_database() {
  step "[5/6] Database"
  # docker-dev-oss brings up its OWN postgres inside the compose network.
  # The Better Auth schema migration is part of the dev container's startup
  # wrapper (scripts/start-dev.sh) so it runs against the compose pg
  # automatically.
  guard_existing_db
  ok "Database setup is automatic — compose brings up postgres and the server runs Better Auth migrate on startup."
}

# Docker volumes persist by name, so if a previous install left a postgres
# volume, the next `up` silently REUSES it — you'd resume that database (its
# admin + data), not start fresh. Surface that and let an interactive user wipe
# it. NEVER auto-wipe under --yes: keeping data is the safe non-interactive
# default (confirm() returns yes for everything when --yes is set, so the wipe
# must not go through it).
guard_existing_db() {
  local project="${COMPOSE_PROJECT_NAME:-vonzio}"
  local vol="${project}_pgdata"
  docker volume inspect "$vol" >/dev/null 2>&1 || return 0   # no existing DB — fresh install
  log ""
  warn "Found an existing database volume (${vol}) from a previous install."
  warn "  Starting now REUSES it — you'll resume that database (existing admin + data), not start fresh."
  if $ASSUME_YES; then
    info "Keeping it (non-interactive --yes). To start fresh instead, remove it and re-run:"
    info "    docker volume rm ${vol} ${project}_vonzio-data"
    return 0
  fi
  if confirm "Wipe it and start with a fresh database? (irreversible)" "default-no"; then
    docker volume rm "${vol}" "${project}_vonzio-data" >/dev/null 2>&1 || true
    ok "Removed the old database volume — this install starts fresh."
  else
    info "Keeping the existing database — the stack will resume your current data."
  fi
}

# Poll the dashboard's /health (which proxies to the API) until the stack
# is actually serving, then print + open the URL. Runs concurrently with
# the foreground `make` (which is what brings the stack up), so it has to
# tolerate the port being unreachable for the whole cold-build window.
wait_for_health() {
  local port="${DASHBOARD_PORT:-5173}" url deadline now
  url="http://localhost:${port}"
  now="$(date +%s)"
  deadline=$(( now + HEALTH_TIMEOUT_SECS ))
  while (( $(date +%s) < deadline )); do
    if require_cmd curl && curl -fsS -o /dev/null "${url}/health" 2>/dev/null; then
      log ""
      ok "vonzio is up. Open: ${C_BOLD}${url}${C_RESET}"
      log "  First visit lands on /setup — create your admin account, then onboarding."
      open_browser "$url"
      return 0
    fi
    sleep 2
  done
  log ""
  warn "Still waiting on /health after ${HEALTH_TIMEOUT_SECS}s (cold builds can take longer)."
  warn "  Once you see 'Server listening' in the logs, open: ${C_BOLD}${url}${C_RESET}"
  return 0
}

start_stack() {
  step "[6/6] Stack"
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

  # Background poller watches /health and announces the URL the moment the
  # stack is actually serving (replaces a fixed sleep that fired ~2.5 min
  # before the server was ready on a cold build).
  ( wait_for_health ) &

  exec make docker-dev-oss
}

# ─── Orchestration ─────────────────────────────────────────────────────
main() {
  parse_args "$@"

  case "$ACTION" in
    help)    show_help; exit 0 ;;
    version) log "vonzio installer v${INSTALLER_VERSION}"; exit 0 ;;
  esac

  print_banner
  detect_platform
  detect_mode

  if [[ "$ACTION" == "uninstall" ]]; then
    do_uninstall
    exit 0
  fi

  # Friendly failure message on any unexpected error from here on. The
  # deliberate `exit N` paths above (missing deps, bad checkout) print
  # their own guidance and aren't surfaced as crashes.
  trap 'on_error $LINENO' ERR

  preflight
  check_prereqs
  setup_source_tree
  setup_env
  setup_npm
  setup_database
  start_stack
}

# Only run when executed, not when sourced (so tests can load the
# functions in isolation). "${BASH_SOURCE[0]:-$0}" handles `bash install.sh`,
# `./install.sh`, and `curl ... | bash` (where BASH_SOURCE is empty).
if [[ "${BASH_SOURCE[0]:-$0}" == "${0}" ]]; then
  main "$@"
fi
