# Fix Auto-Detect Judul Kuronime Uncensored (kjny0Xunc)

**Date**: 2026-09-03
**Author**: opencode

## Root Cause

File kuronime uncensored punya pola nama `{code}{episode}unc` (mis. `kjny02unc`, `kjny03unc`, `kjny01unc01`). `extractSourcePattern()` menghasilkan `source_pattern` yang **berbeda per episode**:
- `kjny01unc01` → `kuronime-kjny01unc`
- `kjny02unc` → `kuronime-kjny02unc`
- `kjny03unc` → `kuronime-kjny03unc`

Karena episode number ikut ter-detect sebagai bagian pattern, file episode berbeda punya pattern berbeda. Akibatnya `findMediaByPattern()` gagal match → bot tidak bisa auto-detect judul → user harus isi judul manual **setiap episode** padahal satu judul.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` (`extractSourcePattern`) | Tambah 1 regex normalize `{code}{ep}unc` → `{code}` |
| DB `media` table | Update `source_pattern` entry spesifik `kuronime-kjny02unc` → `kuronime-kjny` |

## Detail Teknis

**1. Kode** (`scraper/bot.js:1684`):
```js
// Kuronime uncensored: "kjny02unc"/"kjny03unc" → "kjny" (strip {ep}unc)
// (Catatan: "kjny01unc01" sudah ter-strip oleh \d{2,3}$ menjadi "kjny01unc", lalu kena regex ini.)
normalized = normalized.replace(/([a-z]{2,})\d{1,3}unc$/i, '$1');
```
Hasil: semua `kjny01unc`/`kjny02unc`/`kjny03unc` → `kuronime-kjny`.

**2. DB update** (entry spesifik, aman):
```sql
UPDATE media SET source_pattern='kuronime-kjny'
WHERE slug='anime:kaifuku-jutsushi-no-yarinaoshi-uncensored'
  AND source_pattern='kuronime-kjny02unc';
```

## Keamanan (cross-check)

- **Samehadaku files** (`TsSDKMGnoKh`, `TSSDK`) → di-handle cabang `/SAMEHADAKU/` di `extractSourcePattern`, return SHORT langsung, **tidak lewat** jalur `kuronime-` normalization. Tidak terpengaruh.
- **Kuronime biasa** (`tssdk`, `ymintsgai`) → tidak ends dengan `...unc`, tidak terpengaruh.
- **TSS multi-season** (`tss` → S4, `tensei-s3` → S3) → `findMediaByPattern` tidak diubah, tetap exact match. Tidak ada regresi.
- DB verifikasi: tidak ada source_pattern duplikat yang rusak setelah update.

## Verification

- `node --check scraper/bot.js` — lulus
- Test `extractSourcePattern`:
  - `kjny01unc01`, `kjny02unc`, `kjny03unc` → semua `kuronime-kjny` ✓
  - `TsSDKMGnoKh-FULLHD-SAMEHADAKU...` → `TsSDKMGnoKh` (aman) ✓
  - `tssdks401` → `kuronime-tssdk`, `ymintsgai06` → `kuronime-ymintsgai` (tidak terpengaruh) ✓
- DB: pattern `kuronime-kjny` match "Kaifuku Jutsushi no Yarinaoshi (Uncensored)" ✓
- **Functional test**: kirim file ep3 `kjny03unc` (gofile/pixeldrain) → harus auto-detect judul + tersimpan sebagai part 3 (tanpa isi manual). **Perlu bot restart**.
