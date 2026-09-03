# Fix Caption Filedon Samehadaku — Teruskan titleArg dari sam_go

**Date**: 2026-09-03
**Author**: opencode
**Status**: Implemented — branch `batch-e4b-other`

## Root Cause

Alur `sam_go` → `downloadSamehadakuFile` membangun `titleArg` ("... S2") dan meneruskannya ke GoFile/Pixeldrain sebagai `customTitle`, tapi **tidak** ke Filedon. `handleFiledonUrl(chatId, url)` tidak menerima parameter judul, sehingga caption/progress Filedon hanya bergantung pada DB lookup (`kuronime-<short>`). Untuk `GKsTIeO-S2-07` lookup gagal (DB menyimpan `GKsTIeO` tanpa prefix, leftover dari save lama) → `title` null → fallback `cleanCaption` → progress "S2 07 FULLHD SAMEHADAKU CARE".

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/handlers/download.js` `handleFiledonUrl` | Terima `customTitle = null`; fallback pakai `customTitle` bila DB lookup null, dengan anti-dobel suffix `S{season}` |
| `scraper/bot.js` `handleFiledonUrl` wrapper | Teruskan `customTitle` ke modul |
| `scraper/bot.js` `downloadSamehadakuFile` | Teruskan `titleArg` ke Filedon (seperti GoFile/Pixeldrain) |

## Verification

- `node --check scraper/bot.js`, `scraper/handlers/download.js` — lulus
- Simulasi `GKsTIeO-S2-07` (DB null, customTitle "... S2"): final `➧ Judul :- ... S2`, `➧ Season :- 2 Episode 7`; progress `... S2 — Episode 7` ✓
