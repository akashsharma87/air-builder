#!/bin/sh
# Air Builder: double-click to start on a Mac (or run: sh start-mac.command).
# Gets the latest version (if this is a git download), starts a tiny local web
# server here and opens the app in your browser.
cd "$(dirname "$0")" || exit 1

# Update to the latest version quietly. Never asks for a password; skips if offline.
if [ -d .git ] && command -v git >/dev/null 2>&1; then
  GIT_TERMINAL_PROMPT=0 git pull --ff-only -q >/dev/null 2>&1 && echo "  Up to date."
fi

# Use port 8000, or the next free one if something else is already using it.
PORT=8000
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT + 1)); done
URL="http://localhost:$PORT"

echo ""
echo "  Air Builder is running at $URL"
echo "  Keep this window open while you use it. Press Ctrl+C to stop."
echo ""
(sleep 1 && open "$URL") &

if command -v python3 >/dev/null 2>&1; then
  python3 -m http.server "$PORT" --bind 127.0.0.1
elif command -v npx >/dev/null 2>&1; then
  npx --yes serve -l "$PORT" .
else
  echo "  Python 3 isn't installed yet."
  echo "  Type python3 in Terminal and macOS will offer to install it (free, one click),"
  echo "  then double-click this file again."
  read -r _
fi
