#!/usr/bin/env bash
# MM Agent container entrypoint. Two long-running processes:
#   1. AXL node (background) — TLS peer + HTTP API on 9002.
#   2. mm-agent daemon (foreground) — pricing, signing, lockMMSide.
#
# We don't need supervisord here (only two processes, no Python). Plain bash
# with a SIGTERM handler is enough. tini (PID 1) reaps zombies.

set -euo pipefail

AXL_PEM_PATH="${AXL_PRIVATE_KEY_PATH:-/run/parley/axl.pem}"
if [[ ! -f "${AXL_PEM_PATH}" ]]; then
  echo "[mm-agent] FATAL: AXL identity not found at ${AXL_PEM_PATH}." >&2
  echo "[mm-agent] Mount the mm-agent's axl.pem into the container — see compose.yml." >&2
  echo "[mm-agent] Generate one with: openssl genpkey -algorithm ed25519 -out axl.pem" >&2
  echo "[mm-agent] Then set its ENS axl_pubkey text record (Phase 3 register-mm script)." >&2
  exit 1
fi

if [[ "${AXL_PEM_PATH}" != "/run/parley/axl.pem" ]]; then
  ln -sf "${AXL_PEM_PATH}" /run/parley/axl.pem
fi

# Start AXL in background.
/usr/local/bin/axl-node -config /opt/parley/axl/node-config.json &
AXL_PID=$!

# Forward SIGTERM/SIGINT to both children for clean shutdown.
shutdown() {
  echo "[mm-agent] shutting down"
  kill -TERM "${AXL_PID}" 2>/dev/null || true
  kill -TERM "${MM_PID}" 2>/dev/null || true
  wait
  exit 0
}
trap shutdown TERM INT

# mm-agent reads from the AXL HTTP API; AXL boots fast but give it a moment.
# The mm-agent already retries `recv` on errors, so a brief delay is enough.
sleep 1

cd /opt/parley/packages/mm-agent
node dist/index.js &
MM_PID=$!

# Wait on whichever exits first; if either dies, propagate the exit code so
# Docker / compose can decide whether to restart.
wait -n "${AXL_PID}" "${MM_PID}"
EXIT_CODE=$?
echo "[mm-agent] one child exited (code=${EXIT_CODE}); shutting down siblings" >&2
shutdown
