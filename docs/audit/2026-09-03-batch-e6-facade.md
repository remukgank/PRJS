# Batch E6 — Facade Cleanup + Migrasi sendVideo Family

**Date**: 2026-09-03
**Author**: opencode
**Status**: Implemented — branch `batch-e6-facade`

## Scope

Pindahkan `sendVideo`/`sendAudio`/`sendDocument`/`sendPhoto` (bot.js:77-169) ke `scraper/lib/telegram.js`. `bot.js` 3726 → 3634 baris (−92). `lib/telegram.js` 59 → ~200 baris.

**Detail — copy exact, bukan rewrite:** 4 fungsi disalin persis dari `bot.js` (transform mekanis: `LOCAL_API_PORT`→`_config.LOCAL_API_PORT`, `bot.send*`→`_bot.send*`, `API_MAX_RETRY`→`_config.API_MAX_RETRY`, `setCachedFileId`→`_setCachedFileId` import dari `db`). `bot.js` ganti definisi dengan 1 baris import. `initTelegram` dipindah setelah `const bot` dibuat, dengan `bot` + `LOCAL_API_PORT` ikut di config.

**Guard (pola E3a):** tiap sender memanggil `ensureSender()` dulu — throw jelas bila dipakai sebelum `initTelegram`, bukan silent fail.

## Verification

- `node --check scraper/bot.js`, `scraper/lib/telegram.js` — lulus
- **Functional test:** exports lib lengkap ✓; `sendVideo`/`sendPhoto` via lib dengan mock bot ✓ (tidak throw guard)
- **ctx forwarding semua modul consumer:** ctx di `initDownload`/`initVidara` meneruskan referensi hasil import lib — handler modul (download, vidara, library, admin) otomatis pakai versi lib tanpa ubahan tambahan ✓
- **Startup pm2 dari branch:** `Bot running`, `Polling started`, `Database tables initialized`, tidak ada `Unhandled` baru ✓

## Rollback

Branch `batch-e6-facade` dari `main` (b64d894, setelah update proposal). Jika bermasalah: `git checkout main -- scraper/bot.js scraper/lib/telegram.js` atau `git revert` 1 commit. DB tidak disentuh.
