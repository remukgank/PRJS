# Batch E4b — handlers/download.js: Pixeldrain, Filedon, GDrive, UcDrive (tanpa router)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Implemented — branch `batch-e4b-other`

## Scope

Pindahkan 4 fungsi dari `scraper/bot.js` ke `scraper/handlers/download.js` (append ke modul E4a) via ctx injection:
- `handlePixeldrainUrl` (1365-1508), `handleFiledonUrl` (1514-1597), `handleGdriveUrl` (1664-1767), `handleUcDriveUrl` (1185-1255)
- `bot.js` 4996 → 4304 baris (−692). Wrapper delegasi tipis di `bot.js` agar call site lama (`sam_*`, message handler) tetap jalan.
- Router `downloadSamehadakuFile` TIDAK termasuk — masuk E4c setelah E4a+E4b merge.

## Detail — Preservasi pola per fungsi (sesuai proposal)

- **Pixeldrain**: `sami?.episode ?? parseSamehadakuFilename ?? extract` di `pixPart`/`part` — dipertahankan; `findMediaByPattern` via helper Batch C.
- **Filedon**: jalur title sendiri (SHORT_ALIAS + 3-step lookup `kuronime-*`/`samehadaku-*` + suffix `S{season}`) dipindah apa adanya — **tidak** dipaksa lewat helper. `titleForCap` vs save dipertahankan terpisah.
- **GDrive**: `titleForMedia` S-suffix anti-dobel + `epNum = gdSame?.episode ?? extract` dipertahankan.
- **UcDrive**: `getShareInfo`/`downloadShare`, tidak ada Map/title logic.
- **ctx E4b** = pola E4a (`bot`, `config: {MAX_UPLOAD_MB}`, `samehadakuEpisodeMap`, `sendVideo/Audio/Document`, `Progress/RichProgress`) + import resolver (`getPixeldrainInfo`, `resolveFiledonFile`, `resolveGdriveFile`, `getShareInfo`, `downloadShare`, `sanitize`, `axios`), `remuxToMp4` dari downloader, `getSetting`/`findMediaByPattern` dari db.
- `ensureCtx` dipanggil di awal ke-4 fungsi (temuan E4a: guard ada tapi lupa dipanggil → `Cannot read properties of null`).

## Verification

- `node --check scraper/bot.js`, `scraper/handlers/download.js` — lulus
- **Functional test (sesuai proposal):** guard tanpa init throw jelas 4/4; init lalu resolve lanjut (bukan guard error)
- **Startup pm2 dari branch:** `Bot running`, `Polling started`, `Database tables initialized`, tidak ada `Unhandled` baru

## Rollback

Branch `batch-e4b-other` dari `main` (a2ca113, setelah E4a merge). Jika bermasalah: `git checkout main -- scraper/bot.js` + revert `scraper/handlers/download.js` ke versi E4a, atau `git revert` 1 commit. DB tidak disentuh.
