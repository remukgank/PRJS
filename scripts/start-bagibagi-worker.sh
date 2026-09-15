#!/usr/bin/env bash
# Start BagiBagi payment worker (scripts/bagibagi-worker.py) tanpa Docker.
#
# Pola sama dengan scraper/start-flaresolverr.sh: source .solver/paths.env,
# set PYTHONPATH ke .solver/pkg + .solver/src, jalankan Chromium (nix) dengan
# undetected_chromedriver + Xvfb. Supervisor loop biar worker bangkit lagi
# kalau crash.
set -u

SOLVER_DIR="$(cd "$(dirname "$0")/../.solver" && pwd)"
WORKER_PORT="${BAGIBAGI_WORKER_PORT:-8192}"

if curl -fsS --max-time 2 "http://127.0.0.1:${WORKER_PORT}/health" >/dev/null 2>&1; then
  echo "[bagibagi-worker] Already available at http://127.0.0.1:${WORKER_PORT}"
  exec tail -f /dev/null
fi

if [ ! -f "$SOLVER_DIR/paths.env" ] || [ ! -d "$SOLVER_DIR/src" ] || [ ! -d "$SOLVER_DIR/pkg" ]; then
  echo "[bagibagi-worker] ERROR: solver not set up. Run: bash scripts/setup-flaresolverr.sh"
  exec tail -f /dev/null
fi

# shellcheck disable=SC1091
source "$SOLVER_DIR/paths.env"

export PYTHONPATH="$SOLVER_DIR/pkg:$SOLVER_DIR/src"
export HEADLESS="${HEADLESS:-false}"
export CHROME_BIN="$CHROMIUM_BIN"
export PATH="$XVFB_BIN:$PATH"
export LD_LIBRARY_PATH="$GLIB_LIB:$NSS_LIB:$XCB_LIB:$NSPR_LIB"
export BAGIBAGI_SOLVER_DIR="$SOLVER_DIR"
export BAGIBAGI_WORKER_PORT="$WORKER_PORT"

WORKER_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$SOLVER_DIR/bagibagi-worker.log"

echo "[bagibagi-worker] Starting (chromium + undetected_chromedriver)..."
cd "$WORKER_DIR"
while true; do
  python3 bagibagi-worker.py >> "$LOG_FILE" 2>&1
  code=$?
  echo "[bagibagi-worker] $(date '+%H:%M:%S') exited code=$code — restarting in 3s..." >> "$LOG_FILE"
  sleep 3
done