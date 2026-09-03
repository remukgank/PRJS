# Batch E5b — handlers/vidara.js (4 action + helpers)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Implemented — branch `batch-e5b-vidara`

## Scope

Pindahkan dari `scraper/bot.js` ke `scraper/handlers/vidara.js` via ctx injection:
- `pad`, `buildResolveVideoUrl`, `actionVidaraPerEp`, `actionVidaraMerge10`, `actionVidaraAndTelegramMerge10`, `actionVidaraAndTelegramPerEp`
- `bot.js` 4101 → 3809 baris (−292). Wrapper delegasi tipis agar callback `v_per_ep`/`v_merge10`/`vt_*` tetap jalan.
- `buildChunks` TIDAK ikut (dipakai `actionMerge10` Telegram-only, tetap di facade).

## Detail — ctx & dependensi

- `initVidara({ bot, config: {MAX_UPLOAD_MB}, vidaraBusy, sendVideo, Progress, RichProgress, downloadAndSend })` + `ensureCtx` guard (pola E4/E5a)
- `downloadAndSend` (1387) tetap di `bot.js` → diteruskan via ctx (function declaration ter-hoist, referensi aman)
- Inline require ×4 jadi import top-level di modul: `vidara-uploader` (`V`), `services/vidaraService` (`ensureMp4`, `uploadDramaBatchesVidara`, `ffmpegConcat`), `getVidaraActiveDomain` dari `db`
- Tidak ada `require('../bot')` — cegah cyclical. Tidak ada dependensi ke Library/Admin.

## Verification

- `node --check scraper/bot.js`, `scraper/handlers/vidara.js` — lulus
- **Functional test (mock):** guard tanpa init throw jelas ✓; init menerima `vidaraBusy` custom ✓
- **Startup pm2 dari branch:** `Bot running`, `Polling started`, `Database tables initialized`, tidak ada `Unhandled` baru ✓
- **Live test (wajib sebelum merge):** ✅ LOLOS — batch Vidara 43/43 episode (`Ciuman di Sisik Naga`, netshort) selesai via kode branch E5b: `✅ 43 ok · ❌ 0 gagal`, link `vidara.so/e/...` valid per episode (Ep 10-29 terverifikasi), tidak ada `Unhandled`/`ERROR` baru. Catatan: sempat ditemukan bug `saveVidaraUpload is not defined` dari live test awal → di-fix (tambah import) di commit terpisah dalam branch yang sama sebelum tes ulang lolos.

## Rollback

Branch `batch-e5b-vidara` dari `main` (05c0787, setelah proposal E5). Jika bermasalah: `git checkout main -- scraper/bot.js` + hapus `scraper/handlers/vidara.js`, atau `git revert` 1 commit. DB tidak disentuh.
