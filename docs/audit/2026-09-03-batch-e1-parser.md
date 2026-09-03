# Batch E1 — lib/parser.js (Pure Functions)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Implemented — branch `batch-e1-parser`

## Scope

Ekstrak 9 pure functions dari `scraper/bot.js` ke `scraper/lib/parser.js` (E1, low risk, 0 dep ke bot/db):

- `stripHtml`, `truncateText`, `cleanCaption`, `parseKuronimeSeasonEpisode`, `extractPartFromFilename`, `sanitizeSlug`, `extractSourcePattern`, `extractProvider`, `parseSamehadakuFilename`

`scraper/bot.js` diubah jadi import dari `lib/parser` (1 baris), 9 definisi lokal dihapus.

## Detail

- `lib/parser.js` (171 baris, 0 deps eksternal) — copy exact dari `bot.js` termasuk fix terbaru (uncensored `kjny`, surrogate-safe `truncateText`).
- `bot.js` — tambah `require('./lib/parser')` di line 29, hapus 9 definisi lokal. `detectTitleFromFilename` helper (Batch C) tetap di `bot.js` dan kini pakai import (hoisted, aman).

## Verification

- `node --check scraper/lib/parser.js` — lulus
- `node --check scraper/bot.js` — lulus
- `node --check scraper/db.js` — lulus
- **Unit test lib/parser.js:**
  ```
  extractSourcePattern('kjny01unc01') → kuronime-kjny ✓
  extractSourcePattern('kjny02unc') → kuronime-kjny ✓
  extractSourcePattern('TSSDK-S2-P2-1') → TSSDK ✓
  parseSamehadakuFilename('TSSDK-S2-P2-1') → {short:tssdk, season:2, part:2, ep:1} ✓
  parseSamehadakuFilename('GKsTIeO-S2-2') → {short:gkstieo, season:2, ep:2} ✓
  extractPartFromFilename('kjny02unc') → 2 ✓
  truncateText surrogate → valid UTF-16 ✓
  sanitizeSlug('Gaikotsu S2') → gaikotsu-...-s2 ✓
  stripHtml('<b>hello</b> &amp;') → hello world ✓
  ```

## Rollback

Branch `batch-e1-parser` dari `main` (afa1839). Jika bermasalah: `git checkout main -- scraper/bot.js scraper/lib/parser.js` atau `git revert` 1 commit. DB tidak disentuh.
