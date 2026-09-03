# Insiden E5b — Simbol Hilang di handlers/vidara.js (4 error)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Fixed — menunggu live retest vt_merge10

## Kronologi

- Ekstraksi E5b (`handlers/vidara.js`) lolos `node --check` tapi gagal saat runtime — `ReferenceError`/`TypeError` karena simbol yang dipakai tidak ikut pindah.
- Ketahuan dari log pm2 saat user trigger `vt_merge10` (Reelfren netshort 43 episode): `Unhandled error in callback handler` via safeHandler Batch A (bot tidak crash, user dapat feedback error).
- Audit menyeluruh menemukan 4 simbol: `buildChunks`, `fileSizeMb`, `PART_SEND_DELAY_MS` (+`sleep`), `rp.fail`.

## Akar Masalah (per simbol)

1. **`buildChunks is not defined`** — fungsi lokal `bot.js` dipakai `actionVidaraAndTelegramMerge10`, tidak ikut pindah. Fix: pindah ke `lib/parser.js` (pure function, sesuai keputusan E4c untuk kasus lintas-modul), import di `vidara.js` + `bot.js` (untuk `actionMerge10` yang tetap di facade).
2. **`fileSizeMb is not defined`** — dipakai hitung `sizeMb`, tidak di-import di `vidara.js`. Fix: tambah ke import `../downloader` (pola sama seperti `handlers/download.js`).
3. **`PART_SEND_DELAY_MS is not defined`** — konstanta `bot.js` (baca `process.env`). Fix: teruskan via `_ctx.config` (wiring `initVidara` ditambah), `sleep` di-import dari `lib/telegram` (sudah ada).
4. **`rp.fail is not a function`** — `rp` adalah `RichProgress` yang **aslinya memang tidak punya `fail()`** (cek git history pra-E3b: hanya `Progress` biasa yang punya). Call-site salah objek sejak awal, bukan method yang kelewat ekstraksi. Fix: ganti `await rp.fail(msg)` → `rp.note('❌ Error: ...')` + `await rp.done()`. Semantik gagal tetap jelas: `renderRichDone` menampilkan counter `Gagal N` + note blockquote + status fail per baris — user tidak disesatkan jadi sukses.

## Kenapa Lolos Audit E5b

- `node --check` tidak menangkap `ReferenceError` runtime — hanya syntax.
- Audit shared-state E5b fokus ke Map/ctx, tidak scan semua identifier bebas. Pelajaran: setiap ekstraksi modul wajib scan referensi tak-terdefinisi (sudah dilakukan ke 4 modul handler — tidak ada sisa selain yang di-fix di sini; false positive seperti `Set`, Promise executor `resolve/reject`, arrow lokal `isAnime` diverifikasi satu per satu).

## Verification (dilakukan)

- `node --check` bot.js, handlers/vidara.js, lib/parser.js — lulus
- Unit `buildChunks` (43 ep → 10+10+10+13, 2 ep → 1, 0 ep → 0) — lulus
- Scan referensi 4 modul handler — bersih
- Live retest `vt_merge10` — menunggu trigger, laporan menyusul sebelum merge
