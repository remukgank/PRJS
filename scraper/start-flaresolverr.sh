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
# --- Self-heal paket nix ------------------------------------------------------
# Output /nix/store TIDAK persisten: saat container Replit di-rebuild, paket hasil
# build bisa hilang walau path di paths.env masih sama. Gejalanya 17 Okt 2026:
# xorg-server dicoret → crashloop "Could not find Xvfb" → FlareSolverr tidak pernah
# hidup → bot jatuh ke request langsung (gagal kena Cloudflare).
# Karena path hasil build nix deterministik (hash konten), `nix build` mengembalikan
# path yang sama → cukup build ulang paket yang hilang: idempotent, ~8 detik dari
# cache.nixos.org, tidak menyentuh .solver/src|pkg (tetap persisten di workspace).
set_path_var() {
  # Tulis ulang variabel di paths.env (diformat ulang agar konsisten).
  local name="$1" val="$2"
  if grep -q "^${name}=" "$SOLVER_DIR/paths.env" 2>/dev/null; then
    sed -i "s|^${name}=.*|${name}=\"${val}\"|" "$SOLVER_DIR/paths.env"
  else
    printf '%s="%s"\n' "$name" "$val" >> "$SOLVER_DIR/paths.env"
  fi
}

heal_nix_pkg() {
  # $1 nama variabel paths.env, $2 atribut nixpkgs, $3 subpath, $4 nilai sekarang
  local name="$1" attr="$2" sub="$3" current="$4"
  if [ -n "$current" ] && [ -d "$current" ]; then
    return 0
  fi
  local built
  built="$(nix build "nixpkgs#$attr" --print-out-paths 2>>"$SOLVER_DIR/flaresolverr.log" | tail -1)"
  if [ -z "$built" ] || [ ! -d "${built}${sub}" ]; then
    echo "[flaresolverr] heal GAGAL: ${name} (${attr}) — jalankan: bash scripts/setup-flaresolverr.sh" \
      >> "$SOLVER_DIR/flaresolverr.log"
    return 1
  fi
  printf -v "$name" '%s' "${built}${sub}"
  set_path_var "$name" "${!name}"
  echo "[flaresolverr] heal ${name} → ${!name}" >> "$SOLVER_DIR/flaresolverr.log"
  return 0
}

heal_nix_pkg CHROMIUM_BIN chromium /bin "${CHROMIUM_BIN:-}" || true
heal_nix_pkg XVFB_BIN xorg.xvfb /bin "${XVFB_BIN:-}" || true
heal_nix_pkg GLIB_LIB glib.out /lib "${GLIB_LIB:-}" || true
heal_nix_pkg NSS_LIB nss.out /lib "${NSS_LIB:-}" || true
heal_nix_pkg NSPR_LIB nspr.out /lib "${NSPR_LIB:-}" || true
heal_nix_pkg XCB_LIB xorg.libxcb /lib "${XCB_LIB:-}" || true

export CHROME_BIN="$CHROMIUM_BIN"
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