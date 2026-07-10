#!/bin/bash
# Agent container entrypoint:
# 1. Start a static file server (FILE_SERVER_PORT env, default 8765) serving /workspace/
# 2. Keep container alive (agent runner is invoked via docker exec)

mkdir -p /workspace

# Start styled file server in the background
python3 /app/fileserver.py > /tmp/fileserver.log 2>&1 &

# Keep container alive — the agent runner is invoked via docker exec
exec sleep infinity
