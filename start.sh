#!/bin/bash
# Auto-start 9router di Replit (persisten + auto-update aman).
# 1. Symlink data persisten workspace -> HOME (home di-reset tiap restart).
# 2. Update hanya jika versi tertinggal (tidak tiap boot buta).
# 3. Jalankan dengan --skip-update agar tidak kena auto-exit "Exiting...".

mkdir -p "$HOME/workspace/.9router"
ln -sfn "$HOME/workspace/.9router" "$HOME/.9router"

# Izinkan skip update manual: SKIP_9ROUTER_UPDATE=1 ./start.sh
if [[ "${SKIP_9ROUTER_UPDATE:-0}" != "1" ]]; then
  CURRENT="$(9router --version 2>/dev/null || echo "unknown")"
  LATEST="$(timeout 15 npm view 9router version --registry=https://registry.npmjs.org 2>/dev/null || echo "")"
  if [[ -n "$LATEST" && "$CURRENT" != "$LATEST" ]]; then
    echo "[start.sh] Update 9router $CURRENT -> $LATEST..."
    GLOBAL_ROOT="$(npm root -g)"
    # Bersihkan sisa update gagal (penyebab ENOTEMPTY rename error)
    rm -rf "$GLOBAL_ROOT/.9router-"* "$GLOBAL_ROOT/.better-sqlite3-"* 2>/dev/null || true
    if ! timeout 120 npm i -g "9router@$LATEST" --registry=https://registry.npmjs.org --no-audit --no-fund 2>&1 | tail -n 3; then
      echo "[start.sh] WARNING: update gagal, lanjut dengan versi $CURRENT"
    fi
  else
    echo "[start.sh] 9router sudah terbaru ($CURRENT)"
  fi
fi

unset DISPLAY
exec 9router -n -l --skip-update