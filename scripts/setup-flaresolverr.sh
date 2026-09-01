#!/usr/bin/env bash
# One-time setup: build the FlareSolverr runtime from nix + pip (no Docker).
#
# Requires: nix (builds chromium, xvfb and the shared libs the patched
# undetected_chromedriver needs), network access to pypi.org.
# Produces .solver/{src,pkg,paths.env} — all gitignored.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOLVER_DIR="$ROOT/.solver"
mkdir -p "$SOLVER_DIR"

echo "[setup] Building nix packages (chromium, xvfb, glib, nss, nspr, libxcb)..."
CHROMIUM=$(nix build nixpkgs#chromium --print-out-paths 2>&1 | tail -1)
XVFB_PKG=$(nix build nixpkgs#xorg.xvfb --print-out-paths 2>&1 | tail -1)
GLIB=$(nix build nixpkgs#glib.out --print-out-paths 2>&1 | tail -1)
NSS=$(nix build nixpkgs#nss.out --print-out-paths 2>&1 | tail -1)
NSPR=$(nix build nixpkgs#nspr.out --print-out-paths 2>&1 | tail -1)
XCB=$(nix build nixpkgs#xorg.libxcb --print-out-paths 2>&1 | tail -1)
PIP_PKG=$(nix build nixpkgs#python3Packages.pip --print-out-paths 2>&1 | tail -1)

echo "[setup] Writing $SOLVER_DIR/paths.env"
cat > "$SOLVER_DIR/paths.env" <<EOF
CHROMIUM_BIN="$CHROMIUM/bin/chromium-browser"
XVFB_BIN="$XVFB_PKG/bin"
GLIB_LIB="$GLIB/lib"
NSS_LIB="$NSS/lib"
NSPR_LIB="$NSPR/lib"
XCB_LIB="$XCB/lib"
EOF

echo "[setup] Cloning FlareSolverr v3.5.0 (turnstile solver)..."
if [ ! -d "$SOLVER_DIR/src" ]; then
  git clone --depth 1 --branch v3.5.0 https://github.com/FlareSolverr/FlareSolverr "$SOLVER_DIR/repo"
  cp -r "$SOLVER_DIR/repo/src" "$SOLVER_DIR/src"
  cp "$SOLVER_DIR/repo/requirements.txt" "$SOLVER_DIR/requirements.txt"
  rm -rf "$SOLVER_DIR/repo"
fi

echo "[setup] Installing python deps (pypi.org)..."
"$PIP_PKG/bin/pip" install --target="$SOLVER_DIR/pkg" --index-url https://pypi.org/simple -r "$SOLVER_DIR/requirements.txt"
"$PIP_PKG/bin/pip" install --target="$SOLVER_DIR/pkg" --index-url https://pypi.org/simple undetected-chromedriver

echo "[setup] Verifying undetected_chromedriver runs..."
# shellcheck disable=SC1091
source "$SOLVER_DIR/paths.env"
export LD_LIBRARY_PATH="$GLIB_LIB:$NSS_LIB:$XCB_LIB:$NSPR_LIB"
"$HOME/.local/share/undetected_chromedriver/undetected_chromedriver" --version

echo "[setup] Done. Start with: bash scraper/start-flaresolverr.sh"