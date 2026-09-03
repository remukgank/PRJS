# Proposal Batch E — Fragmentasi scraper/bot.js (5610 baris)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Proposal — belum dieksekusi, menunggu approve per sub-batch

## 1. Peta Modul yang Diusulkan

| Modul | Isi | Baris Asal | Ketergantungan |
|-------|-----|------------|----------------|
| `lib/parser.js` | `extractSourcePattern`, `extractPartFromFilename`, `parseKuronimeSeasonEpisode`, `parseSamehadakuFilename`, `cleanCaption`, `sanitizeSlug`, `extractProvider`, `truncateText`, `stripHtml` | ~1380-1720, 2522-2580 | Pure functions, 0 dep ke bot/db |
| `lib/titleDetect.js` | `detectTitleFromFilename` (Batch C) | helper setelah 2580 | Dep ke `parser` + `db.findMediaByPattern` + `logger` |
| `lib/telegram.js` | `apiPost`, `sendVideo`, `sendAudio`, `sendDocument`, `sendPhoto`, `floodRetryMs`, `sleep` | 83-220 | Dep ke `bot` instance, `config` |
| `lib/progress.js` | `Progress`, `RichProgress` | ~812-1213 | Dep ke `bot` |
| `handlers/download/` | `handleGofileUrl` (direct+share), `handlePixeldrainUrl`, `handleFiledonUrl`, `handleGdriveUrl`, `handleUcDriveUrl`, `downloadSamehadakuFile` | 1889-2600 | Dep ke `parser`, `titleDetect`, `downloader`, `db`, `vidaraService`, `bot`, `sessions` |
| `handlers/library.js` | `librarySearchResultKeyboard`, `buildLibraryKeyboard`, `libraryPartsKeyboard`, `searchDrama` flow, `lib_*` callbacks | 1346-1515, 4222-4240 | Dep ke `db`, `bot`, `sessions` |
| `handlers/vidara.js` | `handleVidara*`, `uploadToVidara` wrappers, `vidaraBusy` | 3335-3600 | Dep ke `vidaraService`, `db`, `bot` |
| `handlers/admin.js` | `isAdmin`, `adminPanelKeyboard`, VIP/Saweria, `act:vip` | 637-650, 1265-1290 | Dep ke `config`, `vipService`, `bot` |
| `bot.js` (facade) | `bot = new TelegramBot(...)`, `sessions` Maps, `safeHandler` wrapper, `bot.on(...)` routing | 1-100, 3617-5610 | Re-export semua handler |

`detectTitleFromFilename` masuk `lib/titleDetect.js`, bukan `lib/parser.js` — karena butuh async `findMediaByPattern`.

## 2. Shared State / Cross-Module Dependency (Kritis)

**State di-share dalam 1 file sekarang:**
- `bot` (TelegramBot instance) — semua handler
- `pool` (db) — via `db.js` wrapper, 12+ tempat
- **12 Map in-memory:** `sessions`, `reelfrenTopics`, `pendingDownloads`, `pendingDeletes`, `pendingReplaces`, `pendingAdds`, `pendingAiEndpoint`, `samehadakuEpisodeMap`, `vidaraBusy`, `aiChatSessions`, dll — paling rawan cyclical
- `config` global: `ADMIN_IDS`, `RF_GROUP_ID`, `STAR_PRICE`, dll
- `logger` (pino)

**Rencana akses lintas modul:**
- **Dipilih: Shared context object** — `bot.js` facade buat `ctx = { bot, pool, sessions, reelfrenTopics, pending*, samehadakuEpisodeMap, config, logger }`, lalu `require('./handlers/download')(ctx)` inject. Tidak ada `require('../bot')` dari handler → cegah cyclical.
- **Ditolak: Import langsung `require('../bot')`** → handler require bot.js yang juga require handler → cyclical, risk tinggi.
- **Pure lib** (`parser`, `titleDetect`) tidak butuh `ctx`, hanya `db`/`logger`.

## 3. Urutan Ekstraksi

| Sub-batch | Modul | Kenapa Duluan | Risk |
|-----------|-------|---------------|------|
| **E1** | `lib/parser.js` | Pure functions, 0 dep — paling aman | Low |
| **E2** | `lib/titleDetect.js` | Dep hanya ke `parser` + `db` — setelah E1 | Low |
| **E3** | `lib/telegram.js` + `lib/progress.js` | Dep ke `bot` tapi tidak ke handler — siapkan infra | Medium |
| **E4** | `handlers/download` | Paling besar (~1500 baris) tapi sudah pakai E1-E3 | High |
| **E5** | `handlers/library` + `handlers/vidara` + `handlers/admin` | Sisa handler — setelah download stabil | Medium |
| **E6** | `bot.js` facade cleanup | Hapus duplikat, tinggal routing | Low |

Jangan gabung E1-E6 dalam 1 commit — tiap sub-batch 1 commit terpisah.

## 4. Strategi Testing Per Tahap

Tiap sub-batch wajib sebelum lanjut:
1. `node --check` semua file berubah
2. Functional test handler yang diekstrak:
   - E1: unit test `extractSourcePattern('kjny03unc')`, `parseSamehadakuFilename('TSSDK-S2-2-...')`
   - E2: helper test 4 provider + negative (sudah ada di Batch C)
   - E4: Test download 1 file GoFile/Pixeldrain Samehadaku S2 → progress & caption benar
   - E5: Test `/cari`, library keyboard, Vidara 1 batch
3. Regression: `npm test` + cek pm2 log tidak ada `Unhandled error in ...`
4. Tiap sub-batch restart pm2, verifikasi polling sebelum lanjut.

## 5. Rollback Plan

- **Per sub-batch branch:** Buat branch `batch-e1-parser`, `batch-e2-titledetect`, dll dari `main`. Merge per sub-batch setelah verifikasi. Jika bermasalah, `git revert` 1 commit / `git checkout main -- scraper/bot.js` tanpa ganggu sub-batch lain.
- **Facade fallback:** Selama E1-E3, `scraper/bot.js` original tetap ada sebagai facade yang `require` modul baru — jika gagal, facade bisa langsung require kode lama (comment switch 1 baris).
- **DB tidak disentuh** di Batch E — rollback hanya file.

**Estimasi:** Multi-session (E1-E2 1 sesi, E4 1 sesi penuh, E5-E6 sesi berikut). Tiap sub-batch butuh approve terpisah — jangan approve paket besar.
