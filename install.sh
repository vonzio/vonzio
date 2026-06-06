#!/usr/bin/env bash
# vonzio core — one-shot self-host installer
#
# Two entry points (same script):
#   curl -fsSL https://raw.githubusercontent.com/vonzio/vonzio/main/install.sh | bash
#   git clone https://github.com/vonzio/vonzio.git && cd vonzio && ./install.sh
#
# What it does:
#   1. Detects your OS (macOS, Linux distro, or WSL).
#   2. Checks for Docker, Docker Compose v2, make, openssl (git + Node are
#      optional — only the --build / contributor path needs git). Asks before
#      installing any that are missing.
#   3. Resolves a target release tag (latest by default, or `--tag` /
#      `VONZIO_VERSION`), prompts for an install directory, and — by default —
#      fetches JUST the compose files there (no git clone, no source tree).
#      With --build it git-clones the full source instead.
#   4. Generates a fresh .env with secure random secrets (or keeps existing).
#   5. Starts a postgres container, runs Better Auth's schema migrations.
#   6. Pulls the prebuilt images and brings the stack up (no build). With
#      --build, builds from source instead.
#   7. Polls /health and prints (and opens) the URL once it's serving.
#
# Flags:
#   --help, -h          Show this header and exit.
#   --version           Print the vonzio release this installer would install.
#   --tag <tag>         Vonzio release to install (default: latest v* tag).
#                       Also reads VONZIO_VERSION from the environment.
#                       Example: --tag v0.1.3  or  VONZIO_VERSION=v0.1.3
#   --dir <path>        Install location for the curl-piped case (default: ~/vonzio).
#   --name <slug>       Instance name → compose project (default: the --dir
#                       basename). Each name gets its own containers, volumes,
#                       and network, so multiple vonzio instances coexist on
#                       one host. Install a second to a different --dir and it
#                       auto-bumps ports (3001/5174…).
#   --yes, -y           Auto-confirm all "install missing dep?" prompts.
#   --no-start          Set everything up but don't start the stack.
#   --build             Build the images from source instead of pulling the
#                       prebuilt ones (the default). For contributors, or when
#                       no prebuilt image exists for the target version.
#   --reset-env         Back up an existing .env and regenerate it.
#
# Uninstall:
#   --uninstall         Stop + remove containers + network (keeps data/images/dir).
#   --uninstall --purge IRREVERSIBLE: also remove all volumes (DB + sessions) +
#                       app images. The ENCRYPTION_KEY in .env is the only key to
#                       your stored credentials — gone for good.
#   --remove-base       With --purge, also drop the heavy agent-base image.
#   --remove-dir        Also delete the checkout directory.
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

readonly REPO_SLUG="vonzio/vonzio"
readonly REPO_URL="https://github.com/${REPO_SLUG}.git"
# Raw-file + API bases for the source-free pull install: it fetches just the
# compose files (no git clone) and resolves the latest release without git.
readonly RAW_BASE="https://raw.githubusercontent.com/${REPO_SLUG}"
readonly API_LATEST_URL="https://api.github.com/repos/${REPO_SLUG}/releases/latest"
readonly DEFAULT_INSTALL_DIR="${HOME}/vonzio"
readonly NODE_MIN_MAJOR=22
# How long to poll /health before falling back to a "watch the logs" hint.
readonly HEALTH_TIMEOUT_SECS="${VONZIO_HEALTH_TIMEOUT:-240}"
# Pre-flight disk guidance: the agent base image + node_modules + pg volume.
readonly RECOMMENDED_DISK_GB="${VONZIO_MIN_DISK_GB:-10}"

# ─── Args (assigned by parse_args) ─────────────────────────────────────
INSTALL_DIR=""
# --name <slug>: explicit instance name. Empty → derived from the install dir
# basename (resolve_install_target). The instance name becomes the compose
# project, so each install gets its own containers, volumes, and network —
# multiple vonzio instances can coexist on one host. Default ~/vonzio → vonzio.
INSTANCE_NAME=""
PROJECT=""
TARGET_TAG="${VONZIO_VERSION:-}"
ASSUME_YES=false
NO_START=false
RESET_ENV=false
ACTION="install"
# Uninstall tiers (see do_uninstall): --purge removes data + images,
# --remove-dir deletes the checkout, --remove-base also drops the heavy
# agent-base image (kept by default).
PURGE=false
REMOVE_DIR=false
REMOVE_BASE=false
# --build forces building from source instead of pulling prebuilt images.
BUILD_FROM_SOURCE=false
# The host port to open / health-check: 3000 for the pulled prod server (serves
# the dashboard itself), 5173 for the build-from-source dev stack (vite). And
# the command the summary shows for restarting (mode-dependent).
OPEN_PORT=""
START_CMD=""
# Resolved app version we're about to install (set early by announce_version so
# the user sees it BEFORE the install-location prompt, and reused in step 3).
RESOLVED_REF=""
# Set true when preflight_ports bumps to free ports; setup_env then rewrites the
# port + the port-coupled URLs in .env.
PORTS_BUMPED=false

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

# Decide a yes/no reply. Split out from confirm() so it's unit-testable without
# a TTY. Lowercasing uses `tr`, not bash's built-in case-conversion expansion —
# that expansion is bash 4+ and errors as "bad substitution" on the bash 3.2
# that macOS ships and `curl | bash` runs under.
confirm_reply() {
  # confirm_reply "<reply>" [default-yes|default-no] -> 0 = yes, 1 = no
  local reply default
  reply="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  default="${2:-default-yes}"
  case "$reply" in
    y|yes) return 0 ;;
    n|no)  return 1 ;;
    *)     [[ "$default" == "default-yes" ]] ;;
  esac
}

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
  confirm_reply "$reply" "$default"
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
  local latest=""
  # Prefer git ls-remote when git is present (it's exact + sorts semver). The
  # source-free pull install may not have git, so fall back to the GitHub
  # releases API over curl — one unauthenticated request, well under the limit.
  if require_cmd git; then
    latest="$(git ls-remote --tags --refs --sort=-v:refname "$REPO_URL" 'v*' 2>/dev/null \
              | awk 'NR==1{sub(/.*refs\/tags\//,"",$2); print $2}')"
  fi
  if [[ -z "$latest" ]]; then
    latest="$(curl -fsSL "$API_LATEST_URL" 2>/dev/null \
              | awk -F'"' '/"tag_name"/{print $4; exit}')"
  fi
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
_dep_opt()  { printf "    %s○%s %-9s %s%s%s\n" "$C_DIM" "$C_RESET" "$1" "$C_DIM" "${2:-optional}" "$C_RESET"; }

# Read-only scan of every prerequisite. Builds MISSING_DEPS, prints a
# summary, and asks ONCE to install whatever's missing (instead of a
# prompt per dep). Sets DEPS_AUTOCONFIRM so check_prereqs won't re-ask.
preflight_deps() {
  MISSING_DEPS=()
  log "  Prerequisites:"
  # git is REQUIRED only for the build-from-source / in-clone paths (full
  # checkout). The default pull install fetches the compose files over curl and
  # resolves the version via the GitHub API, so git is optional there.
  if require_cmd git; then
    _dep_ok git "$(git --version | awk '{print $3}')"
  elif $BUILD_FROM_SOURCE || $IN_CLONE; then
    _dep_miss git "needed for --build"; MISSING_DEPS+=(git)
  else
    _dep_opt git "optional — only for --build / contributing"
  fi
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
  # node/npm are OPTIONAL: the docker stack builds its own modules in-container.
  # They're only needed for host-mode dev (make dev-oss) + the CLI tools, which
  # auto-install node_modules on first use — so we never block or auto-install
  # node on their account.
  local nv=0; require_cmd node && nv="$(node_major 2>/dev/null || echo 0)"
  if (( nv >= NODE_MIN_MAJOR )); then
    _dep_ok node "v$(node --version | sed 's/^v//') ${C_DIM}(optional)${C_RESET}"
  else
    _dep_opt node "optional — only for host-mode dev / CLI tools"
  fi

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

# Next free TCP port at or after $1. (port_in_use returns "free" when we have no
# probe tool, so this just returns $1 in that case — safe.)
find_free_port() {
  local p="$1"
  while port_in_use "$p"; do p=$(( p + 1 )); done
  printf '%s' "$p"
}

# Is the listener on TCP $1 a container of THIS instance (compose project
# $PROJECT)? Used so re-running the installer for an already-running instance
# points the user at it instead of starting a duplicate — while a DIFFERENT
# instance on the same port just triggers a port-bump (each instance has its
# own network now, so they no longer cross-talk).
port_is_this_instance() {
  local p="$1"
  require_cmd docker || return 1
  docker ps --filter "label=com.docker.compose.project=${PROJECT}" \
    --format '{{.Ports}}' 2>/dev/null | grep -qE ":${p}->"
}

preflight_ports() {
  local dash="${DASHBOARD_PORT:-5173}" api="${SERVER_PORT:-3000}"
  if ! port_in_use "$dash" && ! port_in_use "$api"; then
    ok "Ports ${dash} + ${api} are free."
    return 0
  fi

  # If THIS instance ($PROJECT) is already running on these ports, don't spin up
  # a duplicate — point the user at it instead. (A DIFFERENT instance falls
  # through to the port-bump below.)
  if { port_in_use "$dash" && port_is_this_instance "$dash"; } ||
     { port_in_use "$api" && port_is_this_instance "$api"; }; then
    warn "vonzio instance '${PROJECT}' already appears to be running on ${dash}/${api}."
    log  "  Open ${C_BOLD}http://localhost:${dash}${C_RESET} — or stop it first and re-run:"
    log  "    ${C_DIM}(cd ${INSTALL_DIR:-<install-dir>} && make docker-down)${C_RESET}"
    err "Not starting a duplicate of '${PROJECT}'."
    exit 1
  fi

  # Another process (or a DIFFERENT vonzio instance) holds a port → offer to
  # bump to the next free pair. This is the multi-instance path: a second
  # install lands on 3001/5174, etc.
  local busy="" new_dash new_api
  port_in_use "$dash" && busy="${dash} (dashboard)"
  port_in_use "$api"  && busy="${busy:+$busy, }${api} (API)"
  new_dash="$(find_free_port "$dash")"
  new_api="$(find_free_port "$api")"
  [[ "$new_api" == "$new_dash" ]] && new_api="$(find_free_port "$(( new_dash + 1 ))")"

  warn "Port(s) already in use: ${busy}."
  if confirm "Use free ports ${new_dash} (dashboard) + ${new_api} (API) instead?" "default-yes"; then
    DASHBOARD_PORT="$new_dash"; SERVER_PORT="$new_api"
    export DASHBOARD_PORT SERVER_PORT
    PORTS_BUMPED=true
    ok "Using ports ${new_dash} (dashboard) + ${new_api} (API)."
  else
    err "Free the port(s) and re-run, or set DASHBOARD_PORT / SERVER_PORT yourself."
    exit 1
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
      --name) INSTANCE_NAME="$2"; shift 2 ;;
      --name=*) INSTANCE_NAME="${1#*=}"; shift ;;
      --tag) TARGET_TAG="$2"; shift 2 ;;
      --tag=*) TARGET_TAG="${1#*=}"; shift ;;
      --yes|-y) ASSUME_YES=true; shift ;;
      --no-start) NO_START=true; shift ;;
      --reset-env) RESET_ENV=true; shift ;;
      --build) BUILD_FROM_SOURCE=true; shift ;;
      --purge) PURGE=true; shift ;;
      --remove-dir) REMOVE_DIR=true; shift ;;
      --remove-base) REMOVE_BASE=true; shift ;;
      *) echo "Unknown arg: $1 (try --help)" >&2; exit 2 ;;
    esac
  done
}

show_help() {
  sed -n '/^# vonzio core/,/^set -/p' "$0" 2>/dev/null | sed -e 's/^# \{0,1\}//' -e '/^set -/d'
}

print_banner() {
  log ""
  log "${C_BOLD}vonzio core${C_RESET} installer"
  log "${C_DIM}https://github.com/vonzio/vonzio${C_RESET}"
  log ""
}

# Resolve and announce WHICH app version we're about to install, up front —
# before the install-location prompt — so it's never a surprise. (The banner's
# vX above is the installer's own version, not the app's.) Caches the result in
# RESOLVED_REF so setup_source_tree doesn't hit the remote twice.
announce_version() {
  if $IN_CLONE; then
    local ref
    ref="$(git -C "$INSTALL_DIR" describe --tags --always --dirty 2>/dev/null || echo "unknown")"
    info "Installing from this checkout: ${C_BOLD}${ref}${C_RESET} ${C_DIM}(${INSTALL_DIR})${C_RESET}"
    return 0
  fi
  RESOLVED_REF="$(resolve_target_tag || true)"
  if [[ -n "$RESOLVED_REF" ]]; then
    local how="latest release"
    [[ -n "$TARGET_TAG" ]] && how="pinned"
    info "Installing: ${C_BOLD}vonzio core ${RESOLVED_REF}${C_RESET} ${C_DIM}(${how})${C_RESET}"
  else
    warn "Couldn't resolve a release version from the remote — will fall back to main HEAD."
  fi
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
      # Adopt the checkout as the install dir ONLY when the user didn't point us
      # elsewhere. An explicit --dir (and every uninstall, which targets a dir by
      # path) must win — otherwise running the in-repo install.sh to manage an
      # install at another path would silently operate on the repo instead.
      if [[ -z "$INSTALL_DIR" && "$ACTION" != "uninstall" ]]; then
        INSTALL_DIR="$SCRIPT_DIR"
      fi
    fi
  fi
  if ! $IN_CLONE; then
    info "Running in one-shot mode (piped from curl)."
  fi
}

# Tiered uninstall:
#   (default)        stop + remove containers + network. Keeps data/images/dir.
#   --purge          + all volumes (DB + sessions) + app images. IRREVERSIBLE.
#   --remove-base    (with --purge) also drop the heavy agent-base image.
#   --remove-dir     delete the checkout.
do_uninstall() {
  step "Uninstalling vonzio core"
  local target="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
  # Resolve to an ABSOLUTE path first. Critical: a relative --dir (e.g. `.`
  # from `make nuke`) combined with --remove-dir would otherwise become
  # `cd /; rm -rf .` — i.e. wipe the filesystem root.
  local abs
  abs="$(cd "$target" 2>/dev/null && pwd || true)"
  if [[ -z "$abs" || ! -d "$abs/docker" ]]; then
    warn "Couldn't find a vonzio install at ${target}. Pass --dir <path> if it lives elsewhere."
    exit 1
  fi
  target="$abs"
  cd "$target"

  # Which instance is this? Read COMPOSE_PROJECT_NAME from the install's .env,
  # else derive from the dir basename (matches resolve_install_target). Default
  # "vonzio". Everything below is scoped to this project so uninstalling one
  # instance never touches another on the same host.
  local proj net
  proj="$(grep -E '^COMPOSE_PROJECT_NAME=' .env 2>/dev/null | head -1 | cut -d= -f2-)"
  [[ -z "$proj" ]] && proj="$(sanitize_project "$(basename "$target")")"
  [[ -z "$proj" ]] && proj="vonzio"
  net="$(grep -E '^VONZIO_NETWORK=' .env 2>/dev/null | head -1 | cut -d= -f2-)"
  [[ -z "$net" ]] && net="${proj}-network"
  info "Uninstalling instance '${proj}' at ${target}."

  # Stop + remove the stack. compose needs --env-file to interpolate the required
  # ENCRYPTION_KEY; the BASE file alone identifies every core service + the
  # project's network (overlays only add/retag), so this works for pull and
  # build installs alike. Fall back to removing by project label when there's no
  # .env (a partial/broken install).
  info "Stopping the stack…"
  if [[ -f .env ]]; then
    ( cd docker && docker compose --env-file ../.env -f docker-compose.yml down 2>&1 | tail -2 ) || true
  else
    docker ps -aq --filter "label=com.docker.compose.project=${proj}" 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true
  fi
  docker rm -f vonzio-pg 2>/dev/null && info "Removed legacy standalone postgres" || true
  # Spawned agent containers are ephemeral (not in compose). Scope removal to
  # THIS instance's network so other running instances' agents are untouched.
  docker ps -aq --filter "network=${net}" --filter "label=managed-by=vonzio" 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 && info "Removed network ${net}." || true
  ok "Stack stopped + containers removed."

  if ! $PURGE; then
    log ""
    ok "Light uninstall done — your database, images, and checkout were kept."
    log "  Deep clean: ${C_DIM}bash install.sh --uninstall --purge${C_RESET}  ${C_DIM}(deletes the DB + images)${C_RESET}"
    return 0
  fi

  # --purge: irreversible.
  log ""
  warn "${C_BOLD}--purge permanently deletes your database and credentials.${C_RESET}"
  warn "  The ENCRYPTION_KEY in .env is the only key to your stored credentials."
  if ! confirm "Delete all vonzio volumes + images? (irreversible)" "default-no"; then
    err "Aborted — nothing purged."
    exit 1
  fi

  # Volumes: this instance's data (project-prefixed) + legacy names + per-session.
  docker volume rm "${proj}_pgdata" "${proj}_vonzio-data" 2>/dev/null || true
  [[ "$proj" == "vonzio" ]] && docker volume rm docker_pgdata docker_vonzio-data 2>/dev/null || true
  docker volume ls -q 2>/dev/null | grep -E "^${proj}-(ws|sdk)-" | xargs -r docker volume rm >/dev/null 2>&1 || true
  ok "Volumes removed."

  # Images: app images always; agent-base only with --remove-base (it's the
  # ~GB one with the slow rebuild, so we keep it unless asked).
  docker image rm -f vonzio-server:latest vonzio-agent:latest >/dev/null 2>&1 || true
  docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
    | grep -E '^vonzio-agent-' | xargs -r docker image rm -f >/dev/null 2>&1 || true
  if $REMOVE_BASE; then
    docker image rm -f ghcr.io/vonzio/vonzio/agent-base:latest >/dev/null 2>&1 || true
    ok "Images removed (including agent-base)."
  else
    ok "Images removed (kept agent-base — pass --remove-base to drop it too)."
  fi

  if $REMOVE_DIR; then
    cd /
    rm -rf "$target" && ok "Removed checkout ${target}."
  else
    log "  Checkout kept at ${target} — delete with ${C_DIM}--remove-dir${C_RESET} or ${C_DIM}rm -rf ${target}${C_RESET}."
  fi
  log ""
  ok "Deep uninstall complete."
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

# Write a tiny management Makefile into a fetched (source-free) install so the
# same `make docker-pull-oss / docker-logs / docker-down` UX works without the
# repo's full Makefile. printf (not a heredoc) guarantees literal TABs in the
# recipe lines, which make requires.
write_run_makefile() {
  local mk="$1"
  local install_url="${RAW_BASE}/main/install.sh"
  # SC2016: the `$(COMPOSE)` / `$(CURDIR)` / `$(INSTALL_URL)` here are Make
  # variable references that must land in the file LITERALLY — single quotes
  # (no shell expansion) are exactly what we want. Only $install_url (the bash
  # local) is interpolated, via a %s.
  # shellcheck disable=SC2016
  {
    printf '# Minimal management Makefile for a pull-based vonzio install.\n'
    printf '# Generated by install.sh; the full repo Makefile has many more targets.\n'
    printf '# Pin a version with:  VONZIO_IMAGE_TAG=0.3.9 make docker-pull-oss\n'
    printf 'COMPOSE = docker compose --env-file ../.env -f docker-compose.yml -f docker-compose.pull.yml\n'
    # uninstall/nuke re-run the installer (this dir has no install.sh) against
    # THIS install dir, so they target only this instance (its compose project,
    # network, and volumes — never another instance on the same host).
    printf 'INSTALL_URL = %s\n\n' "$install_url"
    printf '.PHONY: docker-pull-oss docker-logs docker-down docker-restart uninstall nuke\n\n'
    printf 'docker-pull-oss:\n'
    printf '\tcd docker && $(COMPOSE) pull\n'
    printf '\tcd docker && $(COMPOSE) up -d --no-build\n\n'
    printf 'docker-logs:\n'
    printf '\tcd docker && $(COMPOSE) logs -f\n\n'
    printf 'docker-down:\n'
    printf '\tcd docker && $(COMPOSE) down\n\n'
    printf 'docker-restart: docker-down docker-pull-oss\n\n'
    printf '# Stop + remove this instance (containers + network). Keeps your data.\n'
    printf 'uninstall:\n'
    printf '\tcurl -fsSL $(INSTALL_URL) | bash -s -- --uninstall --dir $(CURDIR)\n\n'
    printf '# Remove EVERYTHING for this instance: containers, network, volumes\n'
    printf '# (your DB!), and this directory. Shared images are kept (other\n'
    printf '# instances may use them; re-pulled on next install). IRREVERSIBLE.\n'
    printf 'nuke:\n'
    printf '\tcurl -fsSL $(INSTALL_URL) | bash -s -- --uninstall --purge --remove-dir --dir $(CURDIR)\n'
  } > "$mk"
}

# Source-free pull install: fetch ONLY the files needed to run the prebuilt
# images — the two compose files + .env.example — at the resolved ref, plus the
# minimal Makefile above. No git clone, no source tree (the server image now
# carries config/ + tools/, see docker/Dockerfile.server).
fetch_run_files() {
  local ref="$1"
  mkdir -p "$INSTALL_DIR/docker"
  local f
  for f in docker/docker-compose.yml docker/docker-compose.pull.yml .env.example; do
    if ! curl -fsSL "${RAW_BASE}/${ref}/${f}" -o "$INSTALL_DIR/${f}"; then
      err "Failed to fetch ${f} from ${RAW_BASE}/${ref}/"
      err "  Check your network, or pass --build to install from a full source clone."
      exit 1
    fi
  done
  write_run_makefile "$INSTALL_DIR/Makefile"
  ok "Fetched compose files for the pull-based stack — no source tree needed."
}

# Compose project names allow [a-z0-9_-]. Lowercase, replace any run of other
# chars with a single dash, trim leading/trailing dashes.
sanitize_project() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//'
}

# Resolve the install dir (prompting in curl mode) and derive the compose
# PROJECT from --name or the dir basename. Runs BEFORE preflight so the port
# check can tell "THIS instance already running" (refuse) from "a DIFFERENT
# instance" (bump to free ports). Each project gets its own containers,
# volumes, and network, so installs to different dirs coexist on one host.
# Default ~/vonzio (no --name) → project "vonzio" — fully backward compatible.
resolve_install_target() {
  if ! $IN_CLONE && [[ -z "$INSTALL_DIR" ]]; then
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
  local src="${INSTANCE_NAME:-$(basename "${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}")}"
  PROJECT="$(sanitize_project "$src")"
  [[ -z "$PROJECT" ]] && PROJECT="vonzio"
  if [[ "$PROJECT" != "vonzio" ]]; then
    info "Instance: ${C_BOLD}${PROJECT}${C_RESET} ${C_DIM}(its own containers, volumes + network)${C_RESET}"
  fi
}

setup_source_tree() {
  step "[3/6] Source tree"

  if $IN_CLONE; then
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
    return 0
  fi

  # INSTALL_DIR was resolved by resolve_install_target (before preflight).

  # Resolve target release tag. Default = latest v* release. Falls back to main
  # only if none resolves. Reuse the version already announced earlier.
  local target_ref="${RESOLVED_REF:-$(resolve_target_tag)}"
  if [[ -z "$target_ref" ]]; then
    warn "Couldn't resolve a release tag — falling back to main."
    target_ref="main"
  fi

  # DEFAULT: source-free pull install — fetch just the compose files.
  if ! $BUILD_FROM_SOURCE; then
    info "Fetching run files for vonzio @ ${target_ref} → $INSTALL_DIR (no clone)"
    fetch_run_files "$target_ref"
    cd "$INSTALL_DIR"
    return 0
  fi

  # --build: need the full source → git clone. -c advice.detachedHead=false
  # silences git's noisy detached-HEAD banner (we pin to a tag on purpose).
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    info "Existing checkout at $INSTALL_DIR — fetching and switching to ${target_ref}."
    if ! (cd "$INSTALL_DIR" && git fetch --tags --quiet origin && git checkout --quiet "$target_ref"); then
      err "Failed to switch $INSTALL_DIR to ${target_ref}."
      err "  If you have local commits or uncommitted changes there, stash or move them and re-run."
      exit 1
    fi
  else
    info "Cloning vonzio/vonzio @ ${target_ref} → $INSTALL_DIR (--build: full source)"
    git clone --quiet -c advice.detachedHead=false --branch "$target_ref" --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
  cd "$INSTALL_DIR"
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
    # Bind this install to its own compose project + network so multiple vonzio
    # instances coexist on one host. compose reads COMPOSE_PROJECT_NAME from the
    # --env-file; VONZIO_NETWORK names the agent network (see docker-compose.yml).
    # For the default install both equal the legacy values, so nothing changes.
    set_env_var "COMPOSE_PROJECT_NAME" "$PROJECT"
    set_env_var "VONZIO_NETWORK" "${PROJECT}-network"
    ok ".env created (random ENCRYPTION_KEY + BETTER_AUTH_SECRET + POSTGRES_PASSWORD)."
    [[ "$PROJECT" != "vonzio" ]] && ok "Instance '${PROJECT}': isolated project, volumes (${PROJECT}_*) + network (${PROJECT}-network)."
    warn "Back up .env now — losing ENCRYPTION_KEY bricks your credential vault."
    # Only meaningful on a freshly generated .env — never rewrite a kept one.
    # NB: `if`, not `$PORTS_BUMPED && …` — the latter returns 1 when false, and
    # as setup_env's last statement that fails the function under `set -e`.
    if $PORTS_BUMPED; then apply_bumped_ports; fi
  fi
}

# Upsert KEY=VALUE in .env (replace the line if present, else append).
set_env_var() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" .env; then
    sed_inplace "s|^${key}=.*|${key}=${val}|" .env
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}

# When preflight bumped the ports, the port number alone isn't enough: auth
# (BETTER_AUTH_URL), CORS, and agent previews (PREVIEW_URL_TEMPLATE) all encode
# the ports. Rewrite them together so a bumped install actually works.
apply_bumped_ports() {
  set_env_var DASHBOARD_PORT "$DASHBOARD_PORT"
  set_env_var SERVER_PORT "$SERVER_PORT"
  set_env_var BETTER_AUTH_URL "http://localhost:${DASHBOARD_PORT}"
  set_env_var CORS_ORIGIN "http://localhost:${DASHBOARD_PORT},http://localhost:${SERVER_PORT}"
  set_env_var PREVIEW_URL_TEMPLATE "http://localhost:${SERVER_PORT}/preview/{container_id}/{port}/"
  info "Wrote bumped ports + coupled URLs (BETTER_AUTH_URL, CORS_ORIGIN, PREVIEW_URL_TEMPLATE) to .env."
}

# NOTE: there is intentionally no host `npm install`. The docker stack builds
# its own node_modules inside the server/agent images (Dockerfile.server.dev
# runs `npm install`), and the dev compose mounts only `…/src`, never
# node_modules — so the running stack never touches the host's. Host-mode dev
# (make dev-oss) and the CLI targets DO need host modules; their make targets
# auto-install on first use (the `node_modules` target).

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
  # Check THIS instance's volume, not a global one. PROJECT is the shell var set
  # by resolve_install_target (COMPOSE_PROJECT_NAME only lives in .env, never in
  # the installer's environment — reading it here would always fall back to
  # "vonzio" and falsely flag a different instance's database).
  local project="${PROJECT:-vonzio}"
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
  local port="${OPEN_PORT:-${DASHBOARD_PORT:-5173}}" url deadline now
  url="http://localhost:${port}"
  now="$(date +%s)"
  deadline=$(( now + HEALTH_TIMEOUT_SECS ))
  while (( $(date +%s) < deadline )); do
    if require_cmd curl && curl -fsS -o /dev/null "${url}/health" 2>/dev/null; then
      local api_port="${SERVER_PORT:-3000}"
      log ""
      log "  ────────────────────────────────────────────────"
      ok "${C_BOLD}vonzio is up.${C_RESET}"
      log ""
      log "    Dashboard   ${C_BOLD}${url}${C_RESET}   ${C_DIM}← open this${C_RESET}"
      log "    API         http://localhost:${api_port}"
      log ""
      log "  ${C_DIM}Manage it (from ${INSTALL_DIR}):${C_RESET}"
      log "    Logs    ${C_DIM}make docker-logs${C_RESET}"
      log "    Stop    ${C_DIM}make docker-down${C_RESET}"
      log "    Start   ${C_DIM}${START_CMD:-make docker-dev-oss-detached}${C_RESET}"
      log "  ────────────────────────────────────────────────"
      log ""
      log "  First visit lands on /setup — create your admin account, then onboarding."
      open_browser "$url"
      return 0
    fi
    sleep 2
  done
  # Detached, so there's no live log stream to watch — point at the logs cmd.
  log ""
  warn "Still waiting on /health after ${HEALTH_TIMEOUT_SECS}s (cold builds can take longer)."
  warn "  The stack is running in the background. Watch it with:"
  warn "    cd ${INSTALL_DIR} && make docker-logs"
  warn "  then open ${C_BOLD}${url}${C_RESET} once you see 'Server listening'."
  return 0
}

start_stack() {
  step "[6/6] Stack"
  if $NO_START; then
    log ""
    ok "Setup complete (stack not started — --no-start was passed)."
    log ""
    log "Next (from $INSTALL_DIR):"
    log "  make docker-pull-oss          ${C_DIM}# pull prebuilt images + run (fast, default)${C_RESET}"
    if $IN_CLONE || $BUILD_FROM_SOURCE; then
      log "  ${C_DIM}# OR${C_RESET}"
      log "  make docker-dev-oss-detached  ${C_DIM}# build from source (hot reload, for contributors)${C_RESET}"
    fi
    exit 0
  fi

  # Default: pull prebuilt images (no build, ~1 min). Fall back to building from
  # source if this version's images aren't published yet (or --build was given).
  if ! $BUILD_FROM_SOURCE; then
    local tag="${RESOLVED_REF#v}"
    [[ -z "$tag" || "$tag" == "main" ]] && tag="latest"
    info "Pulling prebuilt images (vonzio ${tag}) — no build needed…"
    if VONZIO_IMAGE_TAG="$tag" make docker-pull-oss; then
      OPEN_PORT="${SERVER_PORT:-3000}"     # prod server serves the dashboard itself
      START_CMD="make docker-pull-oss"
      wait_for_health
      return 0
    fi
    # Pull failed. We can only fall back to a source build when the full source
    # is present (in-clone). The default fetched install has no source tree, so
    # guide the user to --build instead of failing cryptically.
    if ! $IN_CLONE; then
      err "Couldn't pull prebuilt images for ${tag} (not published yet?)."
      err "  Re-run with --build to install from a full source checkout:"
      err "    curl -fsSL ${RAW_BASE}/main/install.sh | bash -s -- --build"
      exit 1
    fi
    warn "Prebuilt images for ${tag} aren't available — building from source instead."
    log ""
  fi

  info "Building images + starting the stack in OSS mode…"
  log "  ${C_DIM}First boot builds the agent base image (~3 min cold on Apple Silicon) — progress streams below.${C_RESET}"
  log ""
  # Build (progress shown), then start DETACHED so the terminal returns and the
  # summary below is the last, unmissable thing on screen.
  make docker-dev-oss-detached
  OPEN_PORT="${DASHBOARD_PORT:-5173}"       # dev stack serves the dashboard via vite
  START_CMD="make docker-dev-oss-detached"
  wait_for_health
}

# ─── Orchestration ─────────────────────────────────────────────────────
main() {
  parse_args "$@"

  case "$ACTION" in
    help)    show_help; exit 0 ;;
    version)
      # The installer is fetched fresh from `main` on every curl|bash, so it has
      # no meaningful standalone version. Report the vonzio release it WOULD
      # install instead — that's the version users actually care about.
      local app; app="$(resolve_target_tag 2>/dev/null || true)"
      log "vonzio core installer — installs vonzio core ${app:-<latest release>}"
      exit 0 ;;
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

  announce_version
  resolve_install_target   # resolve dir + PROJECT before preflight's port check
  preflight
  check_prereqs
  setup_source_tree
  setup_env
  setup_database
  start_stack
}

# Only run when executed, not when sourced (so tests can load the
# functions in isolation). "${BASH_SOURCE[0]:-$0}" handles `bash install.sh`,
# `./install.sh`, and `curl ... | bash` (where BASH_SOURCE is empty).
if [[ "${BASH_SOURCE[0]:-$0}" == "${0}" ]]; then
  main "$@"
fi
