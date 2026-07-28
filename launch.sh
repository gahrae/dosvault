#!/usr/bin/env bash
# Launcher for DOS Vault: starts the server if it isn't running, then opens the browser.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://localhost:3456"

if ! curl -sf -o /dev/null "$URL"; then
  cd "$DIR"
  setsid nohup node server.js >> "$DIR/server.log" 2>&1 < /dev/null &
  # Wait up to 10s for the server to come up
  for _ in $(seq 1 50); do
    curl -sf -o /dev/null "$URL" && break
    sleep 0.2
  done
fi

xdg-open "$URL"
