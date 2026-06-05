#!/usr/bin/env bash
# Fail if package-lock.json is out of sync with package.json — WITHOUT a full
# install, so npm bug #4828 (the @tailwindcss/oxide native-binding skip that
# breaks `npm ci` on a host-generated lockfile) never bites.
#
# Approach: regenerate the lock metadata-only, then flag ONLY changes to
# version / resolved / integrity. Those are platform-independent and are the
# real "the lock doesn't match package.json" signal. The "os" / "cpu" optional-
# dep arrays churn across darwin↔linux and are platform metadata, not drift, so
# they're ignored — that churn is what made a naive `git diff` false-positive on
# the linux CI runner.

set -euo pipefail

npm install --package-lock-only --ignore-scripts >/dev/null 2>&1

# Flag any changed `"key": "string-value"` line — that covers dependency ranges,
# version, resolved, and integrity (all platform-independent). It does NOT match
# `"os": [` / `"cpu": [` (array values) or their bare `"linux"` / `"x64"` array
# elements, which is the darwin↔linux churn we must ignore.
drift="$(git diff -- package-lock.json | grep -E '^[-+] *"[^"]+": "' || true)"

# Leave the working tree as we found it.
git checkout -- package-lock.json 2>/dev/null || true

if [ -n "$drift" ]; then
  echo "✗ package-lock.json is out of sync with package.json." >&2
  echo "  Run 'npm install' and commit the updated lockfile. Changed entries:" >&2
  printf '%s\n' "$drift" | head -20 >&2
  exit 1
fi

echo "✓ package-lock.json is in sync with package.json."
