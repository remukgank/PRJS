#!/usr/bin/env bash
# Start Telegram Local Bot API Server
# Requires: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_API_PORT
#
# Opsional:
#   TELEGRAM_API_BIN  — path ke binary telegram-bot-api (kalau pakai custom build)
#                       Contoh: export TELEGRAM_API_BIN=~/telegram-bot-api/build/telegram-bot-api

set -e

if [ -z "$TELEGRAM_API_ID" ] || [ -z "$TELEGRAM_API_HASH" ] || [ -z "$TELEGRAM_API_PORT" ]; then
  echo "ERROR: TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_API_PORT harus di-set!"
  exit 1
fi

# Cari binary: custom env → local build (prioritas) → Nix PATH (fallback)
if [ -n "$TELEGRAM_API_BIN" ] && [ -x "$TELEGRAM_API_BIN" ]; then
  BIN="$TELEGRAM_API_BIN"
  echo "[local-api] Menggunakan custom binary: $BIN"
elif [ -x "/home/runner/workspace/telegram-bot-api/build/telegram-bot-api" ]; then
  BIN="/home/runner/workspace/telegram-bot-api/build/telegram-bot-api"
  echo "[local-api] Menggunakan local build: $BIN"
elif command -v telegram-bot-api &>/dev/null; then
  BIN="$(command -v telegram-bot-api)"
  echo "[local-api] Menggunakan binary dari PATH (fallback): $BIN"
else
  echo "ERROR: telegram-bot-api binary tidak ditemukan!"
  echo "Set env var: export TELEGRAM_API_BIN=/path/to/telegram-bot-api"
  exit 1
fi

echo "[local-api] Versi: $("$BIN" --version 2>&1 | head -1 || echo 'unknown')"
echo "[local-api] Starting on port $TELEGRAM_API_PORT (--local mode)..."

LOG_DIR="${LOG_DIR:-$(dirname "$0")/../logs}"
mkdir -p /tmp/tgapi-data /tmp/tgapi-temp "$LOG_DIR"

echo "[local-api] Logs: $LOG_DIR/local-api.log"

exec "$BIN" \
  --api-id="$TELEGRAM_API_ID" \
  --api-hash="$TELEGRAM_API_HASH" \
  --http-port="$TELEGRAM_API_PORT" \
  --dir=/tmp/tgapi-data \
  --temp-dir=/tmp/tgapi-temp \
  --local \
  --verbosity=2 >> "$LOG_DIR/local-api.log" 2>&1
