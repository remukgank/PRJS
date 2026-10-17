# Fix — FlareSolverr mati total ("Could not find Xvfb") + self-heal paket nix

**Date**: 2026-10-17
**Author**: opencode

## Root Cause

Bot start 17 Okt 04:34 → `Menunggu FlareSolverr...` berulang 30× lalu
`WARN FlareSolverr tidak tersedia; melanjutkan dengan request langsung`.
Semua PID berubah (bot 176→…, FlareSolverr 232→hilang) = container Replit
di-rebuild.

`.solver/flaresolverr.log` (bukti):

```
OSError: Could not find Xvfb. Please install it and try again
[flaresolverr] 04:39:08 exited code=1 — restarting in 3s...
```

`paths.env` menunjuk `/nix/store/sx3d9r61…-xorg-server-21.1.18/bin` — **path-nya
sama persis**, tapi **output-nya hilang dari store** (tinggal `.drv`), sedangkan
chromium masih ada. Output `/nix/store` Replit tidak persisten: bisa dicoret saat
container di-rebuild, sementara `.solver/src|pkg` (source FlareSolverr) tetap
karena berada di filesystem workspace.

Dampak: bot tetap jalan (fallback request langsung) tapi scraping yang butuh
bypass Cloudflare (samehadaku, kamenime, gofile, dramafren, reelfren, saweria)
gagal.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/start-flaresolverr.sh` | +44 baris: `set_path_var()` + `heal_nix_pkg()` — build ulang paket nix yang hilang dari store & rewrite `paths.env` (idempotent, ~8 detik dari cache.nixos.org) |
| `.solver/paths.env` (gitignored) | tidak berubah — path hasil `nix build` deterministik, sama persis dengan yang tertulis |

Pemulihan awal (tidak butuh restart/kill apa pun): `nix build nixpkgs#xorg.xvfb`
→ supervisor `start-flaresolverr.sh` yang retry tiap 3 detik langsung menemukan
Xvfb → FlareSolverr hidup sendiri.

## Detail Teknis

`heal_nix_pkg <VAR> <attr> <subpath> <nilai-skrg>`:
- kalau direktori sudah ada → no-op (tidak ada biaya pada start normal);
- kalau hilang → `nix build nixpkgs#<attr> --print-out-paths`, validasi
  `${path}${subpath}` benar-benar ada, `printf -v` perbarui variabel runtime +
  `sed` rewrite baris di `paths.env`;
- kalau paket tidak bisa dibangun → pesan jelas di `.solver/flaresolverr.log`
  (`jalankan: bash scripts/setup-flaresolverr.sh`) dan lanjut (script supervisor
  tetap retry, tidak lockup).

## Verification

- `bash -n scraper/start-flaresolverr.sh` → clean (file bash, tidak ada `.js`
  yang diubah → `node --check` tidak relevan; smoke test = lihat bawah)
- **Heal unit test** (fungsi yang sama persis dari file, `SOLVER_DIR` diarahkan
  ke salinan di `/tmp`, produksi tidak disentuh):
  - `CHROMIUM_BIN` dipalsukan jadi path tidak ada → heal mengembalikan path
    valid, `dir ada? YA`, `paths.env` ter-rewrite ✓
  - attr tidak ada → `return=1` + pesan "heal GAGAL … setup-flaresolverr.sh" ✓
- **Smoke test end-to-end** (`request.get` — endpoint yang dipakai
  `scraper/index.js`, gofile, reelfren, dramafren, saweria):
  `status: ok` · `url: https://v2.samehadaku.how/anime/one-piece/` ·
  title `One Piece – Samehadaku` · 255 403 bytes · marker episode ada ✓
- **Boot bot (owner yang restart)**: log `04:49:29 FlareSolverr siap` →
  `Bot running` → `Polling started` → `Database tables initialized` →
  `vidaraActiveAccount: 1` ✓ (tanpa WARN fallback)

## Risiko / efek samping

- Tidak ada perubahan perilaku bot; tidak ada breaking change; tidak ada
  perubahan config produksi/secret.
- Start script FlareSolverr tidak boleh dijalankan dua kali (port 8191) — log
  sudah memberi tahu (`Already available`).
- Kalau `nix build` gagal (offline / cache.nixos.org tak terjangkau), FlareSolverr
  tetap crashloop dengan pesan jelas di `.solver/flaresolverr.log`; perlu
  `bash scripts/setup-flaresolverr.sh` manual.