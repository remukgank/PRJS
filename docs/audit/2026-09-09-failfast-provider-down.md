# Fail-fast batch saat provider down global (2026-09-09)

## Insiden (koreksi narasi)
Drama `reelfren_dramanova/1991075341651861504-permainan-hasrat-2` (30 ep,
merge10 → 3 part), log 03:47–03:49: resolve 10/10 gagal 502 lalu retry
serial per-ep 100% gagal (±1 mnt + ~60 baris log terbuang).
**Jalur insiden = bot serial (`actionVidaraAndTelegramMerge10`,
handlers/vidara.js), BUKAN `downloadAll` paralel.** Hook paralel (Hook 1)
tetap benar untuk jalur batch, tapi bukan spek harfiah insiden ini.

## Desain (approve + 2 catatan)
- Helper `providerDownSig` (klasifikasi 502/503/504/invalid response/
  video URL kosong/timeout; error lokal -> null) + `pushStreak` +
  `providerDownVerdict` (100% identik, konservatif) +
  `providerDownSerialMsg` — di `scraper/services/vidaraService.js`.
- Hook 1 (`downloadAll`, vidaraService.js): pasca-`Promise.all`, 100%
  gagal + sig identik -> vonis, else error generik lama. Pesan dipadatkan
  (sig pendek) agar muat progress-line onBatch (60 char, di-test).
- Hook 2 (`actionVidaraAndTelegramMerge10`, vidara.js:186-194, varian
  max-3 per catatan): streak resolve-gagal per chunk; 3 berurutan sig
  sama -> vonis + flag `providerDownMsg` -> chunk sisa di-skip (continue
  dalam try, finally cleanup tetap jalan). Gagal non-streak: perilaku
  lama persis (throw error asli / `video URL kosong Ep N`). Flag per-run,
  tidak persist — false positive pulih via retry manual.
- Pesan user via jalur existing (rp.note 80 char / onBatch 60 char /
  summary counts); panjang di-test. Tanpa plumbing baru.
- Jangan diubah: fallback /api/detail, retry 3x getReelFrenVideo,
  break server-loop getVideoUrlReelFren:307, backpressure,
  merge/concat/upload. Out-of-scope: actionVidaraPerEp/
  actionVidaraAndTelegramPerEp (tanpa chunk).

## Verifikasi
- `node --check` + ESLint 0 (2 file impl + 1 file test).
- `scraper/tests/test-failfast-provider-down.js` 26/26 tanpa live:
  sig (10), streak (5), verdict T1/T2/T3 + tepi (6), serial msg (2),
  downloadChunk T1-integration mock-null x10 (3: resolve tepat 10x,
  error identik, vonis di ujung fase).
- Hook 2 wiring loop (streak/flag/skip) verifikasi review + check
  (butuh mock _ctx/RichProgress penuh untuk harness — dinyatakan jujur).
