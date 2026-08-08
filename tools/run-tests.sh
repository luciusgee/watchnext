#!/usr/bin/env bash
# Full test run. Starts a local server, runs every suite, tears down.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-8899}
PW=${PLAYWRIGHT_PATH:-/opt/node22/lib/node_modules/playwright}

echo "── unit ─────────────────────────────────────────"
node tools/match.test.mjs || UNIT=1

if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/index.html"; then
  echo "starting server on :$PORT"
  npx http-server -p "$PORT" -c-1 --silent >/dev/null 2>&1 &
  SERVER=$!
  trap 'kill $SERVER 2>/dev/null' EXIT
  sleep 3
fi

FAILED=0
for suite in migration legacy-scale meta-e2e keycheck offline durability viewport e2e; do
  echo ""
  echo "── $suite ───────────────────────────────────────"
  node "tools/$suite.js" || FAILED=1
done

[ "${UNIT:-0}" = "1" ] && FAILED=1
echo ""
if [ "$FAILED" = "0" ]; then echo "ALL SUITES PASSED"; else echo "SOME SUITES FAILED"; fi
exit $FAILED
