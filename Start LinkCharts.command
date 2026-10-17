#!/bin/sh
# Double-click to start LinkCharts on macOS (or run ./"Start LinkCharts.command" on Linux).
# Keep this window open while you use it.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org, then run this again."
  (open https://nodejs.org || xdg-open https://nodejs.org) >/dev/null 2>&1
  exit 1
fi
exec node server.mjs --open
