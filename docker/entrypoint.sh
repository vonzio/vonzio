#!/bin/bash
# Agent container entrypoint:
# 1. Start a static file server on port 8000 serving /workspace/output/
# 2. Keep container alive (agent runner is invoked via docker exec)

mkdir -p /workspace/output

# Start styled file server in the background
python3 /app/fileserver.py > /tmp/fileserver.log 2>&1 &

# Keep container alive — the agent runner is invoked via docker exec
exec sleep infinity
