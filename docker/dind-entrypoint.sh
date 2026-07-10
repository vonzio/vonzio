#!/bin/bash
# DinD agent entrypoint (feature 0001): bring up the nested docker daemon via the
# narrow sudo rule, then hand off to the standard agent entrypoint (fileserver +
# keep-alive). Runs as the unprivileged `agent` user; only the bootstrap script
# runs as root. A dockerd start failure is non-fatal to the container so the agent
# can still be reached to diagnose it (see /var/log/dockerd.log).

sudo /usr/local/bin/vonzio-dind-start \
  || echo "vonzio-dind: dockerd failed to start — see /var/log/dockerd.log" >&2

exec /app/entrypoint.sh
