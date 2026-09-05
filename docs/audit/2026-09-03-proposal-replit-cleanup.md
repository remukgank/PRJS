# Proposal — Perbaikan .replit (postMerge, Workflow Rusak, Bot Ganda, Port 20128, RF_GROUP)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Proposal — belum dieksekusi, menunggu approve

Verifikasi aktual di `main` (bukan asumsi).

## 1. postMerge menunjuk file hilang

- `.replit`: `[postMerge] path = "scripts/post-merge.sh"`.
- Fakta: `scripts/` hanya berisi `hermes-postbuild.sh` + `setup-flaresolverr.sh`. File tidak ada.
- Usulan: hapus blok `[postMerge]` (atau ganti path ke hook yang memang ada, bila user punya niat khusus — default: hapus).

## 2. Workflow "Gila DL" rusak

- `.replit`: `args = "python3 vdy_to_vidara.py --resume"`.
- Fakta: `vdy_to_vidara.py` tidak ada di root workspace.
- Usulan: hapus workflow `Gila DL` (atau perbaiki path bila file-nya ada di lokasi lain — perlu konfirmasi user).

## 3. Bot ganda / 409 conflict — KEPUTUSAN UTAMA

Fakta (`main:.replit`):
- Workflow `Project` (parallel, runButton target `PRJS` adalah workflow lain) menjalankan: 9router + FlareSolverr + Telegram Local API + **Telegram Bot** (`node scraper/bot.js`).
- Workflow `PRJS` (parallel) menjalankan: 9router + FlareSolverr + Telegram Local API + **Telegram Bot** (sama persis).
- Keduanya mem-polling token yang sama → `409 Conflict: terminated by other getUpdates` bila dua-duanya jalan.

Usulan keputusan (pilih satu):
- **Opsi A (disarankan): pertahankan `PRJS` sebagai satu-satunya workflow bot.** Hapus task `Telegram Bot` dari workflow `Project` (biarkan FlareSolverr + Local API di sana bila masih dibutuhkan service-nya tanpa bot), atau hapus workflow `Project` seluruhnya bila redundan.
- **Opsi B: pertahankan `Project`, hapus `PRJS`.** Kurang disarankan karena `runButton = "PRJS"` — tombol run utama menunjuk ke sana.

Butuh keputusan eksplisit user sebelum eksekusi — ini inti proposal.

## 4. Port 20128 → external 80

- Fakta: ada listener di 20128; HTTP me-return Next.js app (`/_next/static/...`) dengan `/dashboard` → redirect `/login`. Proses `next-server (v16.3.4)` jalan (pid 12881). Folder `9router/` tidak ada di workspace (kemungkinan symlink/`$HOME/.9router`), tapi `start.sh` menjalankan `9router` dan workflow `9router` + `PRJS`/`Project` memanggilnya.
- Ini kemungkinan panel 9router yang sah (punya halaman login), bukan service asing.
- Usulan: **jangan hapus mapping** tanpa konfirmasi — tapi catat sebagai temuan: pastikan halaman `/login` memang punya auth yang kuat sebelum port 80 publik dipakai produksi. Kalau panel ini tidak dipakai, hapus mapping + hentikan service-nya.

## 5. `[userenv.shared] RF_GROUP_ENABLED = "true"`

- Fakta: mirror topic grup aktif global untuk semua run.
- Usulan: biarkan (non-breaking), kecuali user mau dibuat per-workflow. Tidak ada aksi wajib.

## Eksekusi (setelah approve)

1. Edit `.replit` sesuai keputusan (satu commit config terpisah, pola commit 9222 kemarin).
2. `node --check` tidak relevan (file TOML, bukan JS) — verifikasi via baca ulang diff.
3. Tidak perlu restart pm2/bot untuk perubahan `.replit` (berlaku saat workflow Replit dijalankan manual).
