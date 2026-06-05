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

# ─── port auto-bump (find_free_port / port_is_vonzio / set_env_var) ─────
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

@test "port_is_vonzio: true when a vonzio container publishes the port" {
  docker() { printf 'vonzio-server-1 vonzio-server 0.0.0.0:5173->5173/tcp\n'; }
  export -f docker
  run port_is_vonzio 5173
  [ "$status" -eq 0 ]
}

@test "port_is_vonzio: false when an unrelated process holds the port" {
  docker() { printf 'some-dev-server node:20 0.0.0.0:5173->80/tcp\n'; }
  export -f docker
  run port_is_vonzio 5173
  [ "$status" -eq 1 ]
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

@test "preflight_deps: an outdated node lands in MISSING_DEPS and arms the one-shot consent" {
  ASSUME_YES=true            # stand in for the user saying 'yes' once
  DEPS_AUTOCONFIRM=false
  require_cmd() { return 0; }
  git()    { echo "git version 2.40.0"; }
  openssl(){ return 0; }
  docker() { case "$1" in --version) echo "Docker version 27.0.0, build x";; *) return 0;; esac; }
  node()   { case "$1" in -e) printf 18;; --version) echo "v18.0.0";; esac; }
  preflight_deps
  [[ " ${MISSING_DEPS[*]} " == *" node "* ]]
  [ "$DEPS_AUTOCONFIRM" = true ]
}

# ─── on_error: friendly failure message ────────────────────────────────
@test "on_error: prints a re-runnable failure hint" {
  run on_error 42
  [[ "$output" == *"Install failed"* ]]
  [[ "$output" == *"re-running is safe"* ]]
}
