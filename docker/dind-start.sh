#!/bin/sh
# Nested docker daemon bootstrap for a docker_access workspace (feature 0001).
# Run as root via the narrow sudo rule in Dockerfile.agent.dind. Idempotent: the
# agent entrypoint may re-run on container restart.
set -e

# Already up? (e.g. a re-exec of the entrypoint).
if docker info >/dev/null 2>&1; then
  exit 0
fi

# /var/lib/docker is where the daemon keeps images/build cache; the orchestrator
# mounts a persistent named volume there for pinned docker_access workspaces.
mkdir -p /var/lib/docker /var/run

# Launch dockerd in the background. Under sysbox-runc this runs unprivileged
# (user-namespace mapped); under a privileged container it has real root. Log to
# a file so a failed start is diagnosable from the workspace.
dockerd >/var/log/dockerd.log 2>&1 &

# Wait for the daemon socket to come up (<=30s).
i=0
while [ "$i" -lt 30 ]; do
  if docker info >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

if ! docker info >/dev/null 2>&1; then
  echo "vonzio-dind: dockerd did not become ready within 30s" >&2
  exit 1
fi

# Hand socket access to the unprivileged agent via the docker group.
chgrp docker /var/run/docker.sock 2>/dev/null || true
chmod 660 /var/run/docker.sock 2>/dev/null || true
