# Batch E4a — handlers/download.js (GoFile family)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Implemented — branch `batch-e4a-gofile`

## Scope

Pindahkan 3 fungsi GoFile dari `scraper/bot.js` ke `scraper/handlers/download.js` dengan ctx injection:
- `handleGofileUrl` (direct+share), `handleGofileBatch`
- `bot.js` 4996 → 4686 baris (−310). `handlers/download.js` ~340 baris.

`bot.js` menyimpan wrapper delegasi tipis agar semua call site lama (`sam_*`, message handler, batch) tetap jalan tanpa diubah.

## Detail — Guard & ctx

- `initDownload(ctx)` + `ensureCtx(caller)` — pola sama seperti E3a/E3b (closure-init, throw jelas, bukan silent fail)
- `ensureCtx` dipanggil di awal **kedua** handler (temuan test: awalnya hanya guard tanpa pemanggilan, error jadi `Cannot read properties of null`)
- ctx: `{ bot, config: { MAX_UPLOAD_MB }, samehadakuEpisodeMap, sendVideo, sendAudio, sendDocument, Progress, RichProgress }`
- Tidak ada `require('../bot')` dari handler — cegah cyclical
- `hashUrl`, `VIDEO_EXTS`/`AUDIO_EXTS` didefinisikan lokal di modul (pure, tidak perlu ctx)
- `db` fns (`getPartFileId`, `savePartFileId`, `upsertMedia`, `getSetting`) di-import langsung dari `../db` (stateless wrapper, bukan shared Map)
- `sendVideo/sendAudio/sendDocument` via ctx (masih di bot.js, belum E3 — sengaja tidak dipindah di E4a)

## Verification

- `node --check scraper/bot.js`, `scraper/handlers/download.js` — lulus
- **Functional test (sesuai proposal):**
  - guard tanpa init → throw `handlers/download belum di-init` (url + batch) ✓
  - post-init → lanjut ke resolve GoFile API (bukan guard error) ✓
  - `handleGofileBatch` kosong → tidak throw struktur ✓
- **Startup pm2 dari branch:** `Bot running`, `Polling started`, `Database tables initialized`, tidak ada `Unhandled` baru ✓

## Rollback

Branch `batch-e4a-gofile` dari `main` (7b97972, setelah koreksi proposal). Jika bermasalah: `git checkout main -- scraper/bot.js` + hapus `scraper/handlers/download.js`, atau `git revert` 1 commit. DB tidak disentuh.
