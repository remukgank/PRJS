# Proposal E6 — Facade Cleanup + Migrasi sendVideo Family

**Date**: 2026-09-03
**Author**: opencode
**Status**: Proposal — belum dieksekusi, menunggu approve

## 1. Ringkasan Akhir Batch E (sebelum E6)

`scraper/bot.js`: **5610 → 3726 baris** (−1884). Modul yang sudah terbentuk:

| Modul | Baris | Isi |
|-------|-------|-----|
| `lib/parser.js` (E1) | 171 | 9 pure functions |
| `lib/titleDetect.js` (E2) | 40 | helper dedup Batch C |
| `lib/telegram.js` (E3a) | 59 | sleep, floodRetryMs, apiPost + init |
| `lib/progress.js` (E3b) | 444 | Progress, RichProgress + init guard |
| `lib/urlCache.js` (E4c) | 39 | slug/url cache satu instance |
| `handlers/download.js` (E4a/b/c) | 788 | 7 fungsi download + router |
| `handlers/library.js` (E5a) | 143 | 4 builder + lib_menu |
| `handlers/vidara.js` (E5b) | 309 | 4 action + helpers |
| `handlers/admin.js` (E5c) | 248 | panel, VIP, payment, pre_checkout |

Sisa di `bot.js` (3726): routing `bot.on(...)`, message/callback handler besar, dan **4 fungsi sender yang tertunda dari E3b**.

## 2. Scope E6

**a. Migrasi `sendVideo`/`sendAudio`/`sendDocument`/`sendPhoto` (bot.js:77-158) ke `lib/telegram.js`.**
Pemakai saat ini: bot.js 33x, download.js 18x, admin.js 1x, library.js 2x, vidara.js 2x. Setelah migrasi, semua pemakai import dari `lib/telegram` (atau via ctx yang sudah ada — ctx meneruskan referensi, jadi cukup ganti sumber referensinya).

**b. Facade cleanup:** hapus wrapper delegasi yang sudah tidak diperlukan bila handler dipanggil langsung, rapikan import duplikat (`require` inline → top-level), hapus komentar Batch yang sudah usang.

**Tidak termasuk:** message/callback handler besar (tetap di facade — itu E6+ di luar scope Batch E, butuh proposal terpisah bila mau dipecah).

## 3. Shared State & Risiko

- Sender memakai `apiPost` (sudah di `lib/telegram` via E3a) + `LOCAL_API_PORT`/`TOKEN` dari config — pola init yang sama, tidak ada Map baru.
- `sendVideo` punya logic `cacheInfo`/`file_id` (file_cache DB) — ikut pindah utuh, bukan disederhanakan.
- Risk: Medium — 56 call site, tapi perubahan mekanis (pindah + import). Test: `node --check` + 1 download tiap provider (GoFile/Pixeldrain) verifikasi file terkirim.

## 4. Rollback Plan

- Branch `batch-e6-facade` terpisah — 1 commit, merge setelah verifikasi.
- DB tidak disentuh. Jika bermasalah: `git checkout main -- scraper/bot.js scraper/lib/telegram.js` atau `git revert` 1 commit.

Tunggu approve sebelum mulai E6.
