#!/usr/bin/env bash
# Fail if a shipped shell script uses a bash 4+ feature.
#
# Why: `curl -fsSL .../install.sh | bash` runs under whatever `bash` is on the
# user's PATH — and macOS still ships bash 3.2 as /bin/bash (frozen at GPLv2).
# ShellCheck doesn't flag bash-4 syntax (it's valid bash), and CI runs bash 5,
# so a `${var,,}` / `declare -A` / `mapfile` slips through unit tests and only
# explodes on a real Mac install ("bad substitution"). This grep is the guard.
#
# Scope: the scripts an end user actually executes from their host shell —
# install.sh and scripts/*.sh. (Container scripts run under their image's bash
# and are out of scope.)
set -euo pipefail

cd "$(dirname "$0")/.."

# Each pattern is a bash 4+ construct that breaks on 3.2. Keep descriptions
# terse — they're printed on failure. The `$` inside the single-quoted regexes
# is literal (regex syntax), not a variable — hence the disable.
# shellcheck disable=SC2016
patterns=(
  '\$\{[A-Za-z_][A-Za-z0-9_]*(,,|\^\^|~~)'  ':case-conversion ${var,,}/${var^^} (use tr)'
  '\bdeclare[[:space:]]+-A\b'               ':associative arrays declare -A'
  '\blocal[[:space:]]+-A\b'                 ':associative arrays local -A'
  '\bmapfile\b'                             ':mapfile (use a read loop)'
  '\breadarray\b'                           ':readarray (use a read loop)'
  '\$\{[A-Za-z_][A-Za-z0-9_]*@[QEPAaKkLU]'  ':${var@Q}-style transforms'
)

files=(install.sh)
while IFS= read -r f; do files+=("$f"); done < <(find scripts -maxdepth 1 -name '*.sh' ! -name 'check-bash-portability.sh' 2>/dev/null)

found=0
for ((i = 0; i < ${#patterns[@]}; i += 2)); do
  re="${patterns[i]}"
  desc="${patterns[i + 1]#:}"
  for f in "${files[@]}"; do
    # Blank full-line comments (keeping line numbers) so an explanatory comment
    # that *names* a bash-4 construct doesn't trip the check — only real code.
    if hits="$(sed 's/^[[:space:]]*#.*$//' "$f" | grep -nE "$re" 2>/dev/null)"; then
      found=1
      echo "✗ bash 4+ feature ($desc) — breaks macOS bash 3.2:" >&2
      printf '%s\n' "$hits" | sed "s|^|    $f:|" >&2
    fi
  done
done

if [ "$found" -ne 0 ]; then
  echo "" >&2
  echo "  These run via 'curl | bash' on hosts with bash 3.2. Rewrite with a" >&2
  echo "  3.2-safe equivalent (e.g. tr for lowercasing)." >&2
  exit 1
fi
echo "✓ install.sh + scripts/*.sh are bash 3.2 compatible."
