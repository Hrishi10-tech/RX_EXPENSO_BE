#!/bin/bash
# Run an isolated API instance with its own database, storage and port, for building and testing a client.
#   scripts/instance.sh <name> <port> [seed]     e.g. scripts/instance.sh web 4101 seed
# Database expenso_<name> must exist (createdb -O expenso expenso_<name>). Logs go to /tmp/expenso-<name>.log.
set -e
NAME=$1; PORT=$2
cd "$(dirname "$0")/.."
export DATABASE_URL="postgres://expenso:expenso@localhost:5432/expenso_${NAME}"
export STORAGE_DIR="./data/${NAME}/uploads"
export PORT WEB_ORIGIN="${WEB_ORIGIN:-http://localhost:5173,http://localhost:5180,http://127.0.0.1:5173,http://127.0.0.1:5180}"
export DEV_ECHO_OTP=true RUN_JOBS=true
PIDF=/tmp/expenso-${NAME}.pid
if [ -f "$PIDF" ]; then kill "$(cat "$PIDF")" 2>/dev/null || true; sleep 1; fi
if [ "$3" = "seed" ]; then npx tsx src/db/seed.ts; fi
nohup npx tsx src/index.ts > "/tmp/expenso-${NAME}.log" 2>&1 &
echo $! > "$PIDF"
for i in $(seq 1 40); do curl -sf "localhost:${PORT}/api/v1/health" >/dev/null && break; sleep 0.5; done
curl -s "localhost:${PORT}/api/v1/health"; echo
