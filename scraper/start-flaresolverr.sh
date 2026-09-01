#!/usr/bin/env bash
# Start FlareSolverr without Docker.
#
# Environment: this Replit workspace has REPLIT_DISABLE_DOCKER=1, so the old
# docker-based workflow never starts. We run FlareSolverr 3.5.0 (python source
# in .solver/src, deps in .solver/pkg) with a nix-built Chromium + patched
# undetected_chromedriver + Xvfb. Store paths are resolved at build time and
# recorded in .solver/paths.env (see scripts/setup-flaresolverr.sh).
set -u

SOLVER_DIR="$(cd "$(dirname "$0")/../.solver" && pwd)"

if curl -fsS --max-time 2 http://127.0.0.1:8191/ >/dev/null 2>&1; then
  echo "[flaresolverr] Already available at http://127.0.0.1:8191"
  exec tail -f /dev/null
fi

if [ ! -f "$SOLVER_DIR/paths.env" ] || [ ! -d "$SOLVER_DIR/src" ] || [ ! -d "$SOLVER_DIR/pkg" ]; then
  echo "[flaresolverr] ERROR: solver not set up. Run: bash scripts/setup-flaresolverr.sh"
  exec tail -f /dev/null
fi

# shellcheck disable=SC1091
source "$SOLVER_DIR/paths.env"

export PYTHONPATH="$SOLVER_DIR/pkg:$SOLVER_DIR/src"
export HEADLESS=true
export PATH="$XVFB_BIN:$PATH"
export LD_LIBRARY_PATH="$GLIB_LIB:$NSS_LIB:$XCB_LIB:$NSPR_LIB"

echo "[flaresolverr] Starting FlareSolverr 3.5.0 (chromium + undetected_chromedriver)..."
cd "$SOLVER_DIR/src"
# Supervisor loop: FlareSolverr kadang crash saat solve challenge paralel —
# restart otomatis supaya bot tidak perlu di-restart.
while true; do
  python3 -m flaresolverr >> "$SOLVER_DIR/flaresolverr.log" 2>&1
  code=$?
  echo "[flaresolverr] $(date '+%H:%M:%S') exited code=$code — restarting in 3s..." >> "$SOLVER_DIR/flaresolverr.log"
  sleep 3
done