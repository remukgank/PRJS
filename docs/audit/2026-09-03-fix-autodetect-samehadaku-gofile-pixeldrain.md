# Fix Auto-Detect Judul Samehadaku Di GoFile & Pixeldrain

**Date**: 2026-09-03
**Author**: opencode

## Root Cause

Handler GoFile & Pixeldrain hanya pakai `extractSourcePattern()` untuk auto-detect judul. Untuk file samehadaku (format `SHORT-S2-P2-1-FULLHD-SAMEHADAKU.xxx`), `extractSourcePattern()` (cabang `/SAMEHADAKU/`) return SHORT **huruf kapital** (mis. `TSSDK`), sedangkan DB menyimpan pattern **lowercase** (`kuronime-tssdk`). `findMediaByPattern()` bersifat case-sensitive → **tidak match** → judul tidak auto-detect.

Sementara Filedon & GDrive sudah handle via `parseSamehadakuFilename()` + alias lowercase → bisa resolve `kuronime-tssdk`. Jadi GoFile & Pixeldrain **inkonsisten** dengan Filedon & GDrive.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` `handleGofileUrl` (direct URL) | Tambah fallback `parseSamehadakuFilename` + loop prov → `findMediaByPattern` |
| `scraper/bot.js` `handleGofileUrl` (share) | Tambah fallback yang sama |
| `scraper/bot.js` `handlePixeldrainUrl` | Tambah fallback yang sama |
| `scraper/bot.js` | Tambah `.catch(() => null)` di 3 panggilan `findMediaByPattern` (GoFile direct, GoFile share, Pixeldrain) untuk konsistensi dgn Filedon/GDrive |

## Detail Teknis

Tiap handler kini punya 2-level auto-detect:
1. **Level 1**: `extractSourcePattern(fileName)` → match exact
2. **Level 2 (fallback)**: `parseSamehadakuFilename(fileName)` → loop `['kuronime','samehadaku']` → `findMediaByPattern(<prov>-<short>)`

Contoh untuk file `TSSDK-S2-P2-1-FULLHD-SAMEHADAKU.VIP.mp4`:
- Level 1: pattern `TSSDK` → no match
- Level 2: short `tssdk` → loop `kuronime-tssdk` → **match** "Tensei shitara Slime Datta Ken"

## Verification

- `node --check scraper/bot.js` — lulus
- Simulasi via DB: `TSSDK-S2-P2-1-FULLHD-SAMEHADAKU.VIP.mp4` → parse short `tssdk` → match `kuronime-tssdk` → "Tensei shitara Slime Datta Ken" ✓
- **Functional test**: kirim link gofile/pixeldrain berisi file samehadaku (mis. TSSDK) → harus auto-detect judul (tidak manual). **Perlu bot restart.**

## Catatan

Season/Part suffix (`S2 P2`) untuk File samehadaku yang datang via GoFile/Pixeldrain **belum** ditambahkan ke judul (hanya Filedon/GDrive yang handle ini via `titleForMedia`). Ini dicatat sebagai evaluasi lanjutan — di luar scope fix ini.
