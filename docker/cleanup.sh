#!/bin/sh
# Pooled container cleanup — runs between tasks to prevent state leakage.
# Removes all workspace files (including dotfiles), temp files, and user caches.

set -e

# Workspace (including dotfiles)
rm -rf /workspace/* /workspace/.[!.]* /workspace/..?* 2>/dev/null || true
mkdir -p /workspace

# Temp files
rm -rf /tmp/* /tmp/.[!.]* /tmp/..?* 2>/dev/null || true

# User-level state that Claude Code may create
rm -rf ~/.cache ~/.config ~/.local 2>/dev/null || true
