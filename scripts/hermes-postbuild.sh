#!/usr/bin/env bash
# Hermes Agent postBuild — memastikan command hermes selalu tersedia
set -e

HERMES_WORKSPACE="/home/runner/workspace/.hermes"
HERMES_BIN="$HERMES_WORKSPACE/hermes-agent/venv/bin"

if [ ! -f "$HERMES_BIN/hermes" ]; then
    echo "⚠ Hermes belum terinstall. Jalankan installer dulu."
    exit 1
fi

mkdir -p ~/.local/bin

cat > ~/.local/bin/hermes << 'LAUNCHER'
#!/usr/bin/env bash
export HERMES_HOME="/home/runner/workspace/.hermes"
export PATH="$HERMES_HOME/hermes-agent/venv/bin:$PATH"
exec "$HERMES_HOME/hermes-agent/venv/bin/python" "$HERMES_HOME/hermes-agent/hermes" "$@"
LAUNCHER

chmod +x ~/.local/bin/hermes

mkdir -p ~/.config
echo 'export PATH="$HOME/.local/bin:$PATH"' > ~/.config/bashrc

echo "✓ Hermes launcher siap: $(~/.local/bin/hermes --version)"

# ─────────────────────────────────────────────────────────────────
# 9Router - AI Router
# ─────────────────────────────────────────────────────────────────
ROUTER_DIR="/home/runner/workspace/9router"
if [ -f "$ROUTER_DIR/node_modules/.bin/next" ] && [ -d "$ROUTER_DIR/.next" ]; then
    # Cek apakah 9Router udah jalan
    if ! curl -sf http://localhost:20128/v1/models > /dev/null 2>&1; then
        echo "→ Menjalankan 9Router..."
        cd "$ROUTER_DIR"
        PORT=20128 HOSTNAME=0.0.0.0 \
        NEXT_PUBLIC_BASE_URL=http://localhost:20128 \
        NODE_ENV=production \
        nohup node_modules/.bin/next start > "$ROUTER_DIR/9router.log" 2>&1 &
        echo "✓ 9Router started (PID $!)"
    else
        echo "✓ 9Router sudah berjalan"
    fi
else
    echo "⚠ 9Router belum di-build. Jalankan: cd 9router && npm install && npm run build"
fi
