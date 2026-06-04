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
