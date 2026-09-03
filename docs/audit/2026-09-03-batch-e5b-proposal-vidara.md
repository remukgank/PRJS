# Proposal E5b — handlers/vidara.js (4 action + helpers)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Proposal — belum dieksekusi, menunggu approve

## 1. 4 Fungsi + Test Coverage

| Fungsi | Baris di main | Test scenario |
|--------|---------------|---------------|
| `actionVidaraPerEp` (1852-1902) | Vidara per-episode 1 drama kecil → `ensureMp4` + `uploadFileViaCurl` + link `saveDomain` terkirim, `vidaraBusy` release |
| `actionVidaraMerge10` (1903-1947) | Merge batch via `uploadDramaBatchesVidara` → progress done tanpa error baru |
| `actionVidaraAndTelegramMerge10` (1948-2085) | Vidara+TG merge: `ffmpegConcat` + upload Vidara + kirim Telegram (`sendVideo` via ctx) |
| `actionVidaraAndTelegramPerEp` (2086-2132) | Vidara+TG per-ep: panggil `downloadAndSend` (via ctx, tetap di bot.js) + upload Vidara |

Helper ikut modul: `buildResolveVideoUrl` (1842, resolver reelfren/dramafren), `pad` (1840). `buildChunks` (1495) **tidak ikut** — dipakai `actionMerge10` (Telegram-only, tetap di bot.js facade).

## 2. Shared State (hasil audit)

- **Map: hanya `vidaraBusy`** (set di awal, delete di finally — lock per-chat). Tidak ada Map lain.
- **ctx**: `{ bot, logger, config, vidaraBusy, sendVideo, Progress, RichProgress, downloadAndSend }`. `downloadAndSend` (1387) tetap di bot.js → diteruskan via ctx (bukan `require('../bot')`).
- **Inline require ×4 jadi import top-level di modul**: `vidara-uploader` (`V`: `VIDARA_KEY`, `VIDARA_DOMAIN`, `DOWNLOADS`, `uploadFileViaCurl`), `services/vidaraService` (`ensureMp4`, `uploadDramaBatchesVidara`, `ffmpegConcat`), `getVidaraActiveDomain` dari `db`.
- **Tidak ada dependensi ke Library/Admin** — 4 action tidak memanggil keyboard builder, VIP, atau Saweria. Independen, sesuai keputusan pecah E5.

## 3. Tidak Dipecah Lagi

E5b tetap 1 commit (tidak jadi E5b1/b2). Alasan: 4 action berbagi helper yang sama (`buildResolveVideoUrl`, `pad`, pola `vidaraBusy` lock + `V` guard + `saveDomain`), dan `VT_*` memanggil pola yang sama dengan versi PerEp/Merge10. Memecah per-fungsi hanya menambah overhead branch tanpa mengurangi risk (risk terkonsentrasi di wiring ctx yang sama untuk keempatnya).

## 4. Rollback Plan

- Branch `batch-e5b-vidara` terpisah — 1 commit, merge setelah verifikasi.
- DB tidak disentuh. `bot.js` simpan wrapper delegasi tipis (pola E4a/E4b).
- Jika bermasalah: `git checkout main -- scraper/bot.js` + hapus `scraper/handlers/vidara.js`, atau `git revert` 1 commit.

## 5. Testing

1. `node --check` semua file berubah
2. Functional (mock dulu): mock `uploadFileViaCurl`/`uploadDramaBatchesVidara` untuk 1 batch kecil → progress done; `vidaraBusy` release setelah selesai (cek tidak deadlock chat berikutnya).
   **Kenapa mock dulu, bukan langsung live seperti E4b/E4c:** upload Vidara makan bandwidth besar (ratusan MB per file), butuh waktu menit, dan memakai kuota/API key produksi (`VIDARA_KEY`). Mock memverifikasi wiring ctx + lock release tanpa biaya. Ini keputusan sadar, bukan downgrade standar diam-diam.
3. **Live test wajib 1x sebelum merge** (setelah mock lolos): `actionVidaraPerEp` untuk 1 file kecil beneran → upload ke Vidara asli → konfirmasi link `saveDomain` valid & `vidaraBusy` release (chat berikutnya tidak keblokir). Tidak harus semua 4 fungsi live — minimal 1 untuk pastikan wiring ctx jalan di kondisi nyata.
4. Restart pm2 dari branch → polling jalan, tidak ada `Unhandled` baru

Tunggu approve sebelum mulai E5b.
