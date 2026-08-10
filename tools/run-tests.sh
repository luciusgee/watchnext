#!/usr/bin/env bash
# Full test run. Starts a local server, runs every suite, tears down.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-8899}
PW=${PLAYWRIGHT_PATH:-/opt/node22/lib/node_modules/playwright}

echo "── unit ─────────────────────────────────────────"
node tools/match.test.mjs || UNIT=1
node tools/recommend.test.mjs || UNIT=1

# Always own the server. Previously this reused whatever was already listening,
# which meant a stray server from an earlier shell could be reaped part-way
# through the run — surfacing as ERR_CONNECTION_REFUSED or a reload timeout in
# whichever suite happened to be running, and looking exactly like a real bug.
# The [h] keeps the pattern from matching a shell whose own command line
# contains this string — including the one that launched this script.
pkill -f "[h]ttp-server -p $PORT" 2>/dev/null
sleep 0.5
npx http-server -p "$PORT" -c-1 --silent >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT

# Poll for readiness rather than guessing at a sleep.
for _ in $(seq 1 40); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/index.html" && break
  sleep 0.25
done
if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/index.html"; then
  echo "server failed to start on :$PORT"; exit 2
fi

FAILED=0
for suite in migration legacy-scale meta-e2e keycheck rematch offline durability viewport e2e; do
  echo ""
  echo "── $suite ───────────────────────────────────────"
  node "tools/$suite.js" || FAILED=1
done

[ "${UNIT:-0}" = "1" ] && FAILED=1
echo ""
if [ "$FAILED" = "0" ]; then echo "ALL SUITES PASSED"; else echo "SOME SUITES FAILED"; fi
exit $FAILED
