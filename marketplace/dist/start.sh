#!/bin/bash
cd "$(dirname "$0")"
PORT=8080
echo "Serving on http://localhost:$PORT  (Ctrl+C to stop)"
( sleep 1; (xdg-open "http://localhost:$PORT" >/dev/null 2>&1 || open "http://localhost:$PORT" >/dev/null 2>&1 || true) ) &
if command -v python3 >/dev/null 2>&1; then
  python3 -m http.server $PORT
elif command -v python >/dev/null 2>&1; then
  python -m SimpleHTTPServer $PORT
elif command -v npx >/dev/null 2>&1; then
  npx serve . -l $PORT
else
  echo "Need Python or Node installed. See README.txt"
fi
