# Batch C — Dedup Helper detectTitleFromFilename (H2)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Implemented — 3 syarat Batch C dipenuhi

## Root Cause

Duplikasi logic auto-detect judul di 4 handler (`handleGofileUrl` direct, `handleGofileUrl` share, `handlePixeldrainUrl`, `handleGdriveUrl`) — masing-masing mengulang blok `extractSourcePattern` → `findMediaByPattern` → fallback `parseSamehadakuFilename` + alias lowercase. Tiap fix harus diedit di 4 tempat → rawan inkonsistensi (H2).

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` (helper) | Tambah `detectTitleFromFilename(fileName)` — helper terpusat setelah `parseSamehadakuFilename` |
| `scraper/bot.js` `handleGofileUrl` direct (1906) | Ganti blok duplikat → `const { title } = await detectTitleFromFilename(fileName); if (title) customTitle = title;` |
| `scraper/bot.js` `handleGofileUrl` share (2027) | Sama |
| `scraper/bot.js` `handlePixeldrainUrl` (2221) | Sama |
| `scraper/bot.js` `handleGdriveUrl` (2586) | Sama |

## Detail Teknis — 3 Syarat Batch C

**1. `.catch(()=>null)` dibedakan jadi warn vs not-found:**
Helper pakai `try/catch` eksplisit, bukan `.catch(()=>null)` silent:
```js
try { const m = await findMediaByPattern(pattern); if (m) return ...; logger.info(..., 'no match'); }
catch (err) { logger.warn({ pattern, err: err.message }, 'findMediaByPattern error — beda dari not-found'); }
```
Log `warn` untuk error query vs `info` untuk not-found — selaras Batch A (jangan silent).

**2. Loop `['kuronime','samehadaku']` cross-check identik di 4 handler:**
Verifikasi via `grep -n "for.*prov.*\['kuronime'" scraper/bot.js` — 4 handler + 2 tempat lain (Filedon, dl_title) semua `['kuronime','samehadaku']` urutan sama. Tidak ada handler yang beda list/order — aman untuk unify. Dilaporkan sebelum unify.

**3. Log statement tetap jalan via helper:**
Helper mengembalikan `{ title, pattern, source }` dan log `Auto-detected via pattern` / `via samehadaku short` di dalam helper. Call site tidak perlu lagi `logger.info` terpisah — log tetap muncul dengan pattern/source yang benar. Tidak ada variable hilang.

## Verification

- `node --check scraper/bot.js` — lulus
- `node --check scraper/db.js` — lulus (Batch B)
- **Functional test** helper untuk 4 provider + samehadaku bug + negative:
  ```
  GoFile direct samehadaku: TSSDK-S2-P2-1-... → Tensei... (samehadaku-short) ✓
  GoFile share kjny (fix unc): 1080p-...-kjny03unc... → Kaifuku... (pattern) ✓
  Pixeldrain kuronime: 1080p-...-tssdks401... → Tensei... (pattern) ✓
  GDrive samehadaku mixed case: TsSDKMGnoKh-... → Tensei Movie... (pattern, case-insensitive) ✓
  Negative: random-unknown-xyz.mp4 → null ✓
  ```
