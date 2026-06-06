#!/usr/bin/env bats
#
# Unit tests for install.sh. Made possible by the BASH_SOURCE==$0 guard at
# the bottom of install.sh: sourcing the script defines every function
# WITHOUT running the installer, so we can exercise them in isolation.
#
# Run: bats test/install.bats   (bats-core; `brew install bats-core` /
#                                `apt-get install bats`)

setup() {
  # Load the installer's functions. The guard keeps main() from firing.
  source "${BATS_TEST_DIRNAME}/../install.sh"
  # install.sh enables `set -euo pipefail`; relax it so non-zero returns in
  # assertions don't abort the test subshell.
  set +euo pipefail
  ASSUME_YES=false
}

# ─── gen_secret ────────────────────────────────────────────────────────
@test "gen_secret: 32 chars, no url-unsafe base64 padding chars" {
  run gen_secret
  [ "$status" -eq 0 ]
  [ "${#output}" -eq 32 ]
  [[ "$output" != *"/"* ]]
  [[ "$output" != *"+"* ]]
  [[ "$output" != *"="* ]]
}

@test "gen_secret: two calls differ (actually random)" {
  a="$(gen_secret)"; b="$(gen_secret)"
  [ "$a" != "$b" ]
}

# ─── resolve_target_tag ────────────────────────────────────────────────
@test "resolve_target_tag: returns explicit TARGET_TAG without hitting the network" {
  TARGET_TAG="v9.9.9"
  run resolve_target_tag
  [ "$status" -eq 0 ]
  [ "$output" = "v9.9.9" ]
}

@test "resolve_target_tag: falls back to the GitHub API (curl) when git is absent" {
  TARGET_TAG=""
  require_cmd() { case "$1" in git) return 1 ;; *) return 0 ;; esac; }   # no git
  curl() { printf '{\n  "tag_name": "v1.2.3",\n  "name": "v1.2.3"\n}\n'; }
  run resolve_target_tag
  [ "$status" -eq 0 ]
  [ "$output" = "v1.2.3" ]
}

# ─── confirm ───────────────────────────────────────────────────────────
@test "confirm: ASSUME_YES short-circuits to yes (the automatable path)" {
  ASSUME_YES=true
  run confirm "anything?"
  [ "$status" -eq 0 ]
}

# confirm_reply is the TTY-free reply parser. These cover the path that broke on
# macOS bash 3.2 (${reply,,} → "bad substitution"): a typed reply must be parsed
# case-insensitively without any bash-4 feature.
@test "confirm_reply: y/Y/yes/YES all accepted (case-insensitive, no \${,,})" {
  run confirm_reply "y"   "default-no"; [ "$status" -eq 0 ]
  run confirm_reply "Y"   "default-no"; [ "$status" -eq 0 ]
  run confirm_reply "yes" "default-no"; [ "$status" -eq 0 ]
  run confirm_reply "YES" "default-no"; [ "$status" -eq 0 ]
  run confirm_reply "yEs" "default-no"; [ "$status" -eq 0 ]
}

@test "confirm_reply: n/N/no rejected; empty + junk fall back to the default" {
  run confirm_reply "n"  "default-yes"; [ "$status" -eq 1 ]
  run confirm_reply "NO" "default-yes"; [ "$status" -eq 1 ]
  run confirm_reply ""   "default-no";  [ "$status" -eq 1 ]
  run confirm_reply ""   "default-yes"; [ "$status" -eq 0 ]
  run confirm_reply "xyz" "default-no"; [ "$status" -eq 1 ]
}

# ─── guard_existing_db ─────────────────────────────────────────────────
@test "guard_existing_db: no existing volume -> silent no-op (fresh install)" {
  docker() { case "$1 $2" in "volume inspect") return 1 ;; *) return 0 ;; esac; }
  export -f docker
  run guard_existing_db
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "guard_existing_db: existing volume + --yes KEEPS data, never wipes" {
  # The safety invariant: confirm() returns yes for everything under --yes, so
  # the destructive wipe must NOT route through it — non-interactive keeps data.
  ASSUME_YES=true
  marker="$BATS_TEST_TMPDIR/rm-called"
  docker() {
    case "$1 $2" in
      "volume inspect") return 0 ;;
      "volume rm") echo called > "$marker"; return 0 ;;
      *) return 0 ;;
    esac
  }
  export -f docker
  run guard_existing_db
  [ "$status" -eq 0 ]
  [ ! -f "$marker" ]                 # never wiped under --yes
  [[ "$output" == *"Keeping it"* ]]
}

@test "guard_existing_db: existing volume + interactive 'yes' wipes it" {
  ASSUME_YES=false
  marker="$BATS_TEST_TMPDIR/rm-called"
  docker() {
    case "$1 $2" in
      "volume inspect") return 0 ;;
      "volume rm") echo called > "$marker"; return 0 ;;
      *) return 0 ;;
    esac
  }
  export -f docker
  confirm() { return 0; }            # stand in for the user typing 'y'
  export -f confirm
  run guard_existing_db
  [ "$status" -eq 0 ]
  [ -f "$marker" ]                   # wiped on explicit consent
}

# ─── announce_version ──────────────────────────────────────────────────
@test "announce_version: resolves + caches the (pinned) version, no network" {
  IN_CLONE=false
  TARGET_TAG="v9.9.9"        # resolve_target_tag short-circuits on this — no ls-remote
  run announce_version
  [ "$status" -eq 0 ]
  [[ "$output" == *"Installing"* ]]
  [[ "$output" == *"v9.9.9"* ]]
}

@test "announce_version: caches into RESOLVED_REF for reuse in step 3" {
  IN_CLONE=false
  TARGET_TAG="v9.9.9"
  announce_version >/dev/null
  [ "$RESOLVED_REF" = "v9.9.9" ]
}

# ─── port auto-bump (find_free_port / port_is_this_instance / set_env_var) ──
@test "find_free_port: returns the start port when it's free" {
  port_in_use() { return 1; }   # everything free
  run find_free_port 5173
  [ "$output" = "5173" ]
}

@test "find_free_port: skips consecutive busy ports to the next free one" {
  port_in_use() { case "$1" in 5173|5174) return 0 ;; *) return 1 ;; esac; }
  run find_free_port 5173
  [ "$output" = "5175" ]
}

@test "port_is_this_instance: true when THIS project's container holds the port" {
  PROJECT="vonzio"
  # The function filters `docker ps` by the project label; only "find" a
  # container when that filter is present.
  docker() { [[ "$*" == *"com.docker.compose.project=vonzio"* ]] && printf '0.0.0.0:5173->5173/tcp\n'; return 0; }
  run port_is_this_instance 5173
  [ "$status" -eq 0 ]
}

@test "port_is_this_instance: false when the port belongs to a DIFFERENT instance" {
  PROJECT="vonzio-staging"
  # Filtering for THIS project (vonzio-staging) finds nothing — the port is held
  # by some other project, so a bump (not a refusal) is the right move.
  docker() { [[ "$*" == *"com.docker.compose.project=vonzio-staging"* ]] && printf '\n'; return 0; }
  run port_is_this_instance 5173
  [ "$status" -eq 1 ]
}

# ─── multi-instance: project derivation ────────────────────────────────
@test "sanitize_project: lowercases + replaces invalid chars + trims dashes" {
  [ "$(sanitize_project 'Vonzio')" = "vonzio" ]
  [ "$(sanitize_project 'vonzio Staging')" = "vonzio-staging" ]
  [ "$(sanitize_project '/Users/me/My.App/')" = "users-me-my-app" ]
  [ "$(sanitize_project 'keep_under-score')" = "keep_under-score" ]
}

@test "resolve_install_target: --name wins; default dir → 'vonzio' (backward compatible)" {
  IN_CLONE=false; ASSUME_YES=true; INSTANCE_NAME=""; INSTALL_DIR="$HOME/vonzio"
  resolve_install_target >/dev/null 2>&1
  [ "$PROJECT" = "vonzio" ]

  PROJECT=""; INSTANCE_NAME="Staging Box"; INSTALL_DIR="$HOME/vonzio"
  resolve_install_target >/dev/null 2>&1
  [ "$PROJECT" = "staging-box" ]
}

@test "resolve_install_target: project derives from the install-dir basename" {
  IN_CLONE=false; ASSUME_YES=true; INSTANCE_NAME=""; INSTALL_DIR="/tmp/vonzio-staging"
  resolve_install_target >/dev/null 2>&1
  [ "$PROJECT" = "vonzio-staging" ]
}

@test "set_env_var: replaces an existing key and appends a missing one" {
  cd "$BATS_TEST_TMPDIR"
  printf 'BETTER_AUTH_URL=http://localhost:5173\nFOO=bar\n' > .env
  set_env_var BETTER_AUTH_URL "http://localhost:5273"
  set_env_var DASHBOARD_PORT "5273"
  grep -qx 'BETTER_AUTH_URL=http://localhost:5273' .env
  grep -qx 'DASHBOARD_PORT=5273' .env
  grep -qx 'FOO=bar' .env          # untouched
}

@test "apply_bumped_ports: writes all five coupled values coherently" {
  cd "$BATS_TEST_TMPDIR"
  printf 'BETTER_AUTH_URL=http://localhost:5173\nCORS_ORIGIN=http://localhost:5173,http://localhost:3000\n' > .env
  DASHBOARD_PORT=5273 SERVER_PORT=3100 apply_bumped_ports >/dev/null
  grep -qx 'DASHBOARD_PORT=5273' .env
  grep -qx 'SERVER_PORT=3100' .env
  grep -qx 'BETTER_AUTH_URL=http://localhost:5273' .env
  grep -qx 'CORS_ORIGIN=http://localhost:5273,http://localhost:3100' .env
  grep -q 'PREVIEW_URL_TEMPLATE=http://localhost:3100/preview/' .env
}

# Regression: the installer runs under `set -e`. setup_env ended with
# `$PORTS_BUMPED && apply_bumped_ports`, which returns 1 when not bumped (the
# common path) and, as the function's last statement, failed the whole install.
# The rest of the suite relaxes set -e in setup(), so this test re-enables it.
@test "setup_env: returns 0 under set -e on the free-ports path (not bumped)" {
  cd "$BATS_TEST_TMPDIR"
  printf 'ENCRYPTION_KEY=\nBETTER_AUTH_SECRET=\nPOSTGRES_PASSWORD=\n' > .env.example
  RESET_ENV=false
  PORTS_BUMPED=false
  INSTALL_DIR="$PWD"
  ( set -e; setup_env )   # subshell exits non-zero → test fails if the bug is back
}

# ─── detect_platform ───────────────────────────────────────────────────
@test "detect_platform: Darwin -> macos" {
  uname() { echo "Darwin"; }
  export -f uname
  detect_platform
  [ "$OS" = "macos" ]
}

# ─── ensure_docker: the permission-vs-daemon fix ───────────────────────
@test "ensure_docker: 'permission denied' tells the user about the docker group, not 'daemon unreachable'" {
  docker() {
    case "$1" in
      info) echo "permission denied while trying to connect to the Docker daemon socket" >&2; return 1 ;;
      *) return 0 ;;
    esac
  }
  export -f docker
  run ensure_docker
  [ "$status" -eq 1 ]
  [[ "$output" == *"docker"*"group"* ]] || [[ "$output" == *"newgrp"* ]]
  [[ "$output" != *"daemon isn't running"* ]]
}

@test "ensure_docker: a stopped daemon points at systemctl/start, not the group" {
  OS="linux"
  docker() {
    case "$1" in
      info) echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2; return 1 ;;
      *) return 0 ;;
    esac
  }
  export -f docker
  run ensure_docker
  [ "$status" -eq 1 ]
  [[ "$output" == *"daemon isn't running"* ]]
  [[ "$output" == *"start docker"* ]]
}

# ─── install_node_linux: the deb-vs-rpm NodeSource fix ─────────────────
@test "install_node_linux: apt-based distro uses the DEB NodeSource setup script" {
  CURL_LOG="$BATS_TEST_TMPDIR/curl.log"; : > "$CURL_LOG"
  require_cmd() { [[ "$1" == "apt-get" ]]; }          # apt present, dnf/yum absent
  curl() { echo "$*" >> "$CURL_LOG"; }                # capture the URL, swallow
  sudo() { return 0; }                                # no-op (also swallows `sudo apt-get …`)
  install_node_linux
  grep -q "deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x" "$CURL_LOG"
  ! grep -q "rpm.nodesource.com" "$CURL_LOG"
}

@test "install_node_linux: rpm-based distro uses the RPM NodeSource setup script" {
  CURL_LOG="$BATS_TEST_TMPDIR/curl.log"; : > "$CURL_LOG"
  require_cmd() { [[ "$1" == "dnf" ]]; }              # dnf present, apt-get absent
  curl() { echo "$*" >> "$CURL_LOG"; }
  sudo() { return 0; }
  sudo_install() { return 0; }
  install_node_linux
  grep -q "rpm.nodesource.com/setup_${NODE_MIN_MAJOR}.x" "$CURL_LOG"
  ! grep -q "deb.nodesource.com" "$CURL_LOG"
}

# ─── node_major ────────────────────────────────────────────────────────
@test "node_major: parses the major from a mocked node" {
  node() { [[ "$1" == "-e" ]] && printf "18"; }
  export -f node
  run node_major
  [ "$output" = "18" ]
}

# ─── --reset-env arg ───────────────────────────────────────────────────
@test "parse_args: --reset-env sets RESET_ENV" {
  RESET_ENV=false
  parse_args --reset-env
  [ "$RESET_ENV" = true ]
}

@test "parse_args: uninstall tier flags" {
  ACTION=install; PURGE=false; REMOVE_DIR=false; REMOVE_BASE=false
  parse_args --uninstall --purge --remove-dir --remove-base
  [ "$ACTION" = uninstall ]
  [ "$PURGE" = true ]
  [ "$REMOVE_DIR" = true ]
  [ "$REMOVE_BASE" = true ]
}

@test "do_uninstall: errors clearly when target isn't a vonzio install" {
  INSTALL_DIR="$BATS_TEST_TMPDIR/not-vonzio"   # no docker/ dir
  run do_uninstall
  [ "$status" -eq 1 ]
  [[ "$output" == *"Couldn't find a vonzio install"* ]]
}

@test "do_uninstall: light path returns 0 under set -e (mocked docker)" {
  mkdir -p "$BATS_TEST_TMPDIR/inst/docker"
  : > "$BATS_TEST_TMPDIR/inst/.env"
  INSTALL_DIR="$BATS_TEST_TMPDIR/inst"
  PURGE=false
  docker() { return 0; }   # every docker op no-ops successfully
  export -f docker
  ( set -e; do_uninstall >/dev/null 2>&1 )   # fails the test if it returns non-zero
}

@test "do_uninstall --remove-dir resolves a relative --dir (never nukes the CWD)" {
  cd "$BATS_TEST_TMPDIR"
  mkdir -p inst/docker; : > inst/.env
  : > SENTINEL                # in the CWD — must survive; proves no `rm -rf .`
  INSTALL_DIR="inst"          # RELATIVE (as `make nuke` passes `--dir .`)
  PURGE=true; REMOVE_BASE=false; REMOVE_DIR=true; ASSUME_YES=true
  docker() { return 0; }; export -f docker
  ( set -e; do_uninstall >/dev/null 2>&1 ) || true
  [ ! -d "$BATS_TEST_TMPDIR/inst" ]      # resolved to abs path + removed the install dir
  [ -f "$BATS_TEST_TMPDIR/SENTINEL" ]    # the CWD was NOT wiped
}

# ─── disk_free_gb ──────────────────────────────────────────────────────
@test "disk_free_gb: converts df's 1K-blocks to whole GB" {
  # df -Pk 'Available' column (4th) in 1024-byte blocks; 20 GiB = 20971520.
  df() { printf "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 100 100 20971520 1%% /\n"; }
  export -f df
  run disk_free_gb /whatever
  [ "$output" = "20" ]
}

# ─── port_in_use ───────────────────────────────────────────────────────
@test "port_in_use: reports a busy port via lsof" {
  require_cmd() { [[ "$1" == "lsof" ]]; }
  lsof() { return 0; }   # something is listening
  run port_in_use 5173
  [ "$status" -eq 0 ]
}

@test "port_in_use: reports a free port via lsof" {
  require_cmd() { [[ "$1" == "lsof" ]]; }
  lsof() { return 1; }   # nothing listening
  run port_in_use 5173
  [ "$status" -eq 1 ]
}

@test "port_in_use: assumes free when no probe tool exists" {
  require_cmd() { return 1; }   # no lsof, no ss
  run port_in_use 5173
  [ "$status" -eq 1 ]
}

# ─── preflight_deps: the summary + MISSING_DEPS scan ───────────────────
@test "preflight_deps: all present -> empty MISSING_DEPS, no consent needed" {
  require_cmd() { return 0; }
  git()    { echo "git version 2.40.0"; }
  openssl(){ return 0; }
  docker() { case "$1" in --version) echo "Docker version 27.0.0, build x";; *) return 0;; esac; }
  node()   { case "$1" in -e) printf 22;; --version) echo "v22.1.0";; esac; }
  preflight_deps
  [ "${#MISSING_DEPS[@]}" -eq 0 ]
}

@test "preflight_deps: node is OPTIONAL — a missing node does NOT block or enter MISSING_DEPS" {
  MISSING_DEPS=()
  # All required deps present; node absent. The docker stack doesn't need it.
  require_cmd() { case "$1" in node) return 1 ;; *) return 0 ;; esac; }
  git()    { echo "git version 2.40.0"; }
  openssl(){ return 0; }
  docker() { case "$1" in --version) echo "Docker version 27.0.0, build x";; *) return 0;; esac; }
  preflight_deps >/dev/null 2>&1
  [ "${#MISSING_DEPS[@]}" -eq 0 ]
}

@test "preflight_deps: git is OPTIONAL on the default pull path (no --build)" {
  MISSING_DEPS=(); BUILD_FROM_SOURCE=false; IN_CLONE=false
  require_cmd() { case "$1" in git) return 1 ;; *) return 0 ;; esac; }   # git absent
  openssl(){ return 0; }
  docker() { case "$1" in --version) echo "Docker version 27.0.0, build x";; *) return 0;; esac; }
  preflight_deps >/dev/null 2>&1
  # missing git must NOT block a pull install
  [[ " ${MISSING_DEPS[*]} " != *" git "* ]]
}

@test "preflight_deps: git is REQUIRED when --build is set" {
  MISSING_DEPS=(); BUILD_FROM_SOURCE=true; IN_CLONE=false
  require_cmd() { case "$1" in git) return 1 ;; *) return 0 ;; esac; }   # git absent
  openssl(){ return 0; }
  docker() { case "$1" in --version) echo "Docker version 27.0.0, build x";; *) return 0;; esac; }
  confirm() { return 0; }   # don't block on the install-missing-deps prompt
  preflight_deps >/dev/null 2>&1
  [[ " ${MISSING_DEPS[*]} " == *" git "* ]]
}

# ─── write_run_makefile (source-free pull install) ─────────────────────
@test "write_run_makefile: emits a valid Makefile (TAB recipes) make can parse" {
  mk="$BATS_TEST_TMPDIR/Makefile"
  write_run_makefile "$mk"
  [ -f "$mk" ]
  # The literal Make variable reference must survive verbatim (not shell-expanded).
  grep -q 'COMPOSE = docker compose' "$mk"
  # make parses it AND expands $(COMPOSE) — proves the recipe TABs are real.
  run make -f "$mk" -n docker-pull-oss
  [ "$status" -eq 0 ]
  [[ "$output" == *"docker compose"*"pull"* ]]
  [[ "$output" == *"up -d --no-build"* ]]
}

# ─── on_error: friendly failure message ────────────────────────────────
@test "on_error: prints a re-runnable failure hint" {
  run on_error 42
  [[ "$output" == *"Install failed"* ]]
  [[ "$output" == *"re-running is safe"* ]]
}
