#!/bin/sh
# Air Builder: double-click to start on a Mac (or run: sh start-mac.command).
# Starts a tiny local web server here and opens the app in your browser.
cd "$(dirname "$0")" || exit 1
PORT=8000
URL="http://localhost:$PORT"

echo ""
echo "  Air Builder is running at $URL"
echo "  Keep this window open while you use it. Press Ctrl+C to stop."
echo ""
(sleep 1 && open "$URL") &

if command -v python3 >/dev/null 2>&1; then
  python3 -m http.server "$PORT"
elif command -v npx >/dev/null 2>&1; then
  npx --yes serve -l "$PORT" .
else
  echo "  Python 3 isn't installed yet."
  echo "  Type python3 in Terminal and macOS will offer to install it (free, one click),"
  echo "  then double-click this file again."
  read -r _
fi
