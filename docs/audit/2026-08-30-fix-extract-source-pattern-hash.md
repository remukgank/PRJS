# Fix extractSourcePattern: hash lowercase+digit terfilter

**Date**: 2026-08-30
**Author**: opencode

## Root Cause

`extractSourcePattern` tidak memfilter token hash yang hanya lowercase+digit di posisi 2 setelah resolusi. Filename `1080p-0nizdxx-kuronime-ymintsgai06.mp4` → pattern `0nizdxx-kuronime-ymintsgai` → `findMediaByPattern` tidak match DB (`kuronime-ymintsgai`). Sementara `oyHLfzP` (mixedCase) berhasil karena terfilter. Hash `abc1234` juga lolos karena tidak mixedCase.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` `extractSourcePattern` | Tambah filter: token di posisi 1+ yang `^[a-z0-9]{5,8}$` DAN mengandung huruf DAN digit → hash random, buang. Menangkap `0nizdxx`, `abc1234`, `a1b2c3e4` tanpa membuang source names asli (`kuronime`, `shortmax`, `flickreels`). |

## Verification

- `node --check scraper/bot.js` → OK
- Unit test `extractSourcePattern`:
  - `1080p-0nizdxx-kuronime-ymintsgai06.mp4` → `kuronime-ymintsgai` ✓
  - `1080p-nIVJp5U-kuronime-blcktrch04.mp4` → `kuronime-blcktrch` ✓
  - `1080p-oyHLfzP-kuronime-ymintsgai04.mp4` → `kuronime-ymintsgai` ✓
  - `1080p-abc1234-shortmax-drama03.mp4` → `shortmax-drama` ✓
  - `720p-a1b2c3e4-flickreels-myshow01.mp4` → `flickreels-myshow` ✓
