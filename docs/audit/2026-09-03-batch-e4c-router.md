# Batch E4c — downloadSamehadakuFile Router ke handlers/download.js

**Date**: 2026-09-03
**Author**: opencode
**Status**: Implemented — branch `batch-e4c-router`

## Scope

Pindahkan `downloadSamehadakuFile` (1310-1328 di main) dari `scraper/bot.js` ke `scraper/handlers/download.js`. `bot.js` 4281 → 4263 baris (−18). Router kini memanggil callee sebagai fungsi lokal dalam modul yang sama (bukan via wrapper `bot.js` atau `_ctx`).

**Keputusan cacheUrl (sesuai instruksi, diputus sebelum eksekusi):** masuk `lib/urlCache.js` (bukan ctx). Alasan terverifikasi: `urlCache` Map + counter dipakai lintas writer (router di modul, message handler `bot.js`) dan reader (callback `sam_*` di `bot.js`) — harus satu instance. Modul `lib/` dengan Map module-level otomatis satu instance via Node require cache. `cacheSlug`/`resolveSlug` ikut pindah (pasangan yang sama polanya). Tidak ada modul yang butuh Map berbeda — keputusan ctx tidak diperlukan.

## Detail

- `lib/urlCache.js` (baru): `cacheSlug`/`resolveSlug`/`cacheUrl`/`resolveUrl` + Map internal, copy persis dari `bot.js`.
- `bot.js`: hapus 4 definisi + 2 Map, ganti 1 baris import; router diganti wrapper delegasi tipis.
- Router di modul: `bot.sendMessage` → `_ctx.bot.sendMessage`; callee (`handleGofileUrl`/`handlePixeldrainUrl`/`handleFiledonUrl`) panggilan lokal langsung, **termasuk `titleArg` ke Filedon** (perubahan 017ae21 ikut terbawa).
- Tambah import di modul: `cacheUrl` dari `lib/urlCache`; `isPixeldrainUrl` sudah ada (hapus duplikat import saat append).

## Verification

- `node --check scraper/bot.js`, `scraper/handlers/download.js`, `scraper/lib/urlCache.js` — lulus
- **Functional test (sesuai proposal):**
  - null-server (`servers = {}`) → pesan "tidak tersedia" + `backKb` ✓
  - unknown-server (URL non-gofile/pixeldrain/filedon) → pesan fallback + `backKb` ✓
  - titleArg dibangun `"… S2"` dari `sameInfo{season:2}` dan diteruskan ke Filedon (line 780) ✓
  - `cacheUrl`→`resolveUrl` satu instance lintas modul ✓
- **Startup pm2 dari branch:** `Bot running`, `Polling started`, `Database tables initialized`, tidak ada `Unhandled` baru ✓

## Rollback

Branch `batch-e4c-router` dari `main` (5789fe1, setelah proposal E4c). Jika bermasalah: `git checkout main -- scraper/bot.js scraper/handlers/download.js` + hapus `scraper/lib/urlCache.js`, atau `git revert` 1 commit. DB tidak disentuh.
