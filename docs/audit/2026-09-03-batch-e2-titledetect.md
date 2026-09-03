# Batch E2 — lib/titleDetect.js (Dedup Helper)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Implemented — branch `batch-e2-titledetect`

## Scope

Pindahkan `detectTitleFromFilename` (Batch C helper) dari `scraper/bot.js` ke `scraper/lib/titleDetect.js` (E2). Dep ke `lib/parser` (E1) + `db.findMediaByPattern` + `logger`. Ganti 4 call site duplikat di `bot.js` jadi 1 baris.

**4 call site yang diganti:**
- `handleGofileUrl` direct (1906)
- `handleGofileUrl` share (2027)
- `handlePixeldrainUrl` (2221)
- `handleGdriveUrl` (2586)

Masing-masing dari blok duplikat `if (!customTitle) { extractSourcePattern → findMedia... → parseSamehadaku... }` menjadi `const { title } = await detectTitleFromFilename(fileName); if (title) customTitle = title;`

## Detail — 3 Syarat Batch C

**1. `.catch(()=>null)` dibedakan warn vs not-found:** Helper pakai `try/catch` eksplisit dengan `logger.warn` untuk error query (`findMediaByPattern error — beda dari not-found`) vs `logger.info` untuk not-found (`Pattern match result - no match`). Selaras Batch A.

**2. Loop `['kuronime','samehadaku']` cross-check identik:** Verifikasi `grep -n "for.*prov.*\['kuronime'" scraper/bot.js` — 4 handler + 2 lainnya semua `['kuronime','samehadaku']` urutan sama. Tidak ada handler yang beda list/order — aman untuk unify. Dilaporkan sebelum unify.

**3. Log tetap jalan via helper return:** Helper return `{ title, pattern, source }` dan log `Auto-detected via pattern/samehadaku short` di dalam helper. Call site tidak kehilangan log — pattern/source tetap ter-log via helper.

## Verification

- `node --check scraper/lib/parser.js` — lulus (E1)
- `node --check scraper/lib/titleDetect.js` — lulus
- `node --check scraper/bot.js` — lulus
- `node --check scraper/db.js` — lulus
- **Functional test helper (reuse Batch C suite):**
  ```
  GoFile direct samehadaku: TSSDK-S2-P2-1-... → Tensei... (samehadaku-short) ✓
  GoFile share kjny (fix unc): 1080p-...-kjny03unc... → Kaifuku... (pattern) ✓
  Pixeldrain kuronime: 1080p-...-tssdks401... → Tensei... (pattern) ✓
  GDrive samehadaku mixed case: TsSDKMGnoKh-... → Tensei Movie... (pattern) ✓
  Negative: random-unknown-xyz.mp4 → null ✓
  ```

## Rollback

Branch `batch-e2-titledetect` dari `main` (89965d0, setelah E1 merge). Jika bermasalah: `git checkout main -- scraper/bot.js scraper/lib/titleDetect.js` atau `git revert` 1 commit. DB tidak disentuh.
