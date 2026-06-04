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
