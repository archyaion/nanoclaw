#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /mnt/f/Claude/nanoclaw/nanoclaw.pid)

set -euo pipefail

cd "/mnt/f/Claude/nanoclaw"

# Stop existing instance if running
if [ -f "/mnt/f/Claude/nanoclaw/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/mnt/f/Claude/nanoclaw/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup "/usr/bin/node" "/mnt/f/Claude/nanoclaw/dist/index.js" \
  >> "/mnt/f/Claude/nanoclaw/logs/nanoclaw.log" \
  2>> "/mnt/f/Claude/nanoclaw/logs/nanoclaw.error.log" &

echo $! > "/mnt/f/Claude/nanoclaw/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /mnt/f/Claude/nanoclaw/logs/nanoclaw.log"
