# Insiden E5b — Simbol Hilang di handlers/vidara.js (7 error)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Fixed — menunggu live retest vt_merge10

## Kronologi

- Ekstraksi E5b (`handlers/vidara.js`) lolos `node --check` tapi gagal saat runtime — `ReferenceError`/`TypeError` karena simbol yang dipakai tidak ikut pindah.
- Ketahuan dari log pm2 saat user trigger `vt_merge10` (Reelfren netshort 43 episode): `Unhandled error in callback handler` via safeHandler Batch A (bot tidak crash, user dapat feedback error).

## Akar Masalah (7 simbol, satu pola)

Semua artifact ekstraksi E5b yang lolos audit — simbol dipakai tapi tidak di-import/di-ctx:

| # | Simbol | Dipakai di | Fix |
|---|--------|-----------|-----|
| 1 | `buildChunks` | `actionVidaraAndTelegramMerge10:136` | Pindah ke `lib/parser.js`, import di vidara.js + bot.js, hapus definisi lokal bot.js |
| 2 | `fileSizeMb` | hitung `sizeMb` mergedFile | Import dari `../downloader` |
| 3 | `PART_SEND_DELAY_MS` + `sleep` | jeda antar chunk | `sleep` import `lib/telegram`, konstanta via `_ctx.config` + wiring |
| 4 | `rp.fail` | catch outer `vt_merge10` | **Bukan method hilang** — `RichProgress` aslinya memang tidak punya `fail()` (cek git history pra-E3b). Call-site salah objek. Fix: `rp.note('❌ Error...')` + `rp.done()` — semantik gagal tetap jelas (footer counter + note blockquote + status fail per baris) |
| 5 | `getVideoInfo` | baca durasi/resolusi mergedFile | Import dari `../downloader` |
| 6 | `isAdmin` / `sendToTopicVideo` / `RF_GROUP_*` | `mirrorToTopic` kirim ke topic grup | Via ctx (`_ctx.isAdmin`, `_ctx.sendToTopicVideo`, `_ctx.config.RF_GROUP_*`) + wiring lazy getter (pola TDZ E5b) |

## Kenapa Lolos Audit E5b

- `node --check` tidak menangkap `ReferenceError` runtime — hanya syntax.
- Audit shared-state E5b fokus ke Map/ctx, tidak scan semua identifier bebas. Pelajaran: setiap ekstraksi modul wajib scan referensi tak-terdefinisi (sudah dilakukan ke 4 modul handler — tidak ada sisa selain yang di-fix di sini; false positive seperti `Set`, Promise executor `resolve/reject`, arrow lokal `isAnime` diverifikasi satu per satu).

## Verification (dilakukan)

- `node --check` bot.js, handlers/vidara.js, lib/parser.js — lulus
- Unit `buildChunks` (43 ep → 10+10+10+13, 2 ep → 1, 0 ep → 0) — lulus
- Scan referensi 4 modul handler — bersih
- Live retest `vt_merge10` — menunggu trigger, laporan menyusul sebelum merge
