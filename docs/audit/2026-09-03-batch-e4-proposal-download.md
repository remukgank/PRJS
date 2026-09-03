# Proposal E4 — handlers/download (GoFile, Pixeldrain, Filedon, GDrive, UcDrive, downloadSamehadakuFile)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Proposal — E4a approved, E4b menunggu approve terpisah, E4c setelah E4a+E4b merge

## 1. 8 Fungsi + Test Coverage (wajib 7 fungsi + 1 router)

| Fungsi | Baris | Sub-step | Test scenario |
|--------|-------|----------|---------------|
| `handleGofileUrl` direct (1344-~1520) | GoFile direct: `kjny03unc` → judul Kaifuku auto-detect, part 3, caption S-episode benar | E4a |
| `handleGofileUrl` share (~1520-1580) | GoFile share: judul auto-detect dari share, part benar | E4a |
| `handleGofileBatch` (1584-1657) | Batch multi-file: loop per-file tanpa judul prompt, `batchPart` per file, tidak throw kosong list | E4a |
| `handlePixeldrainUrl` (1658-1806) | Pixeldrain: `GKsTIeO-S2-5` → `pixPart` = 5 via `sami?.episode ?? parseSamehadakuFilename ?? extract` | E4b |
| `handleFiledonUrl` (1807-1892) | Filedon: `TSSDK-S2-P2-1` → `partN = fdSame?.episode` + alias `tss→tssdk`, suffix S2P2 | E4b |
| `handleGdriveUrl` (1957-~2120) | GDrive: `TsSDKMGnoKh-FULLHD` → `titleForMedia` S-suffix anti-dobel, `epNum` benar | E4b |
| `handleUcDriveUrl` (1175-1245) | UC Drive: share invalid → pesan error, share valid → download + kirim (mock `getShareInfo`) | E4b |
| `downloadSamehadakuFile` (1893-1911) | Router: server gofile→handleGofileUrl, pixeldrain→handlePixeldrainUrl, filedon→handleFiledonUrl, server tak dikenal→ pesan fallback | E4c (setelah E4a+E4b merge) |

## 2. Shared State Per Fungsi (hasil audit baris di atas)

**Map dipakai langsung di `handlers/download` (hanya baca):**
- `handleGofileUrl`: `samehadakuEpisodeMap.get(url)` ×1 (line 1352) — baca saja (`sami`)
- `handlePixeldrainUrl`: `samehadakuEpisodeMap.get(url)` ×1 (line 1660) — baca saja
- 6 fungsi lain (Batch, Filedon, `downloadSamehadakuFile`, GDrive, UcDrive, + share): **TIDAK** akses Map apa pun secara langsung

**Map di-tulis** (`set/delete`) HANYA di callback handlers (`sam_*`, bukan di download) — lines 3734, 4142, 4174, 4223. Jadi `handlers/download` **tidak menulis Map**, hanya membaca `samehadakuEpisodeMap` di 2 fungsi.

**Pola context-object injection (disepakati):**
```js
// handlers/download.js
module.exports = (ctx) => ({
  handleGofileUrl: (chatId, url, customTitle) => handleGofileUrlImpl({ ...ctx, chatId, url, customTitle }),
  ...
});
// ctx = { bot, logger, config, sessions, samehadakuEpisodeMap, pendingDownloads?, db fns }
```
Tidak ada `require('../bot')` langsung dari handler — cegah cyclical. `sessions`, `pendingDownloads` **tidak** dibutuhkan di 7 fungsi ini (audit: 0 pemakaian), jadi **tidak** masuk ctx untuk E4 (tambah nanti jika E5 butuh).

**Dependensi lain per fungsi (sudah diekstrak di E1-E3):**
- E1 (`lib/parser`): semua 7 fungsi pakai `extractPartFromFilename`/`parseSamehadakuFilename`/`cleanCaption`/`sanitizeSlug`/`extractSourcePattern`
- E2 (`lib/titleDetect`): GoFile direct/share, Pixeldrain, GDrive pakai `detectTitleFromFilename`
- E3 (`lib/progress`, `lib/telegram`): semua pakai `new Progress/RichProgress`, `sendVideo/Audio/Document`, `downloadWithAria2c` (downloader), `db` wrappers
- Tidak ada dependensi baru ke `vidara-uploader`/`vidaraService` di 7 fungsi ini (audit: 0 — Vidara dipanggil dari callback, bukan handler download)

## 3. Pecah E4 Jadi Sub-Step?

**Rekomendasi: YA, pecah jadi 2 sub-step (bukan 1 commit besar).** Alasan:
- 7 fungsi bukan independen penuh: `downloadSamehadakuFile` adalah router yang **memanggil 3 fungsi lain** (`handleGofileUrl`, `handlePixeldrainUrl`, `handleFiledonUrl`) — memindahkannya sekaligus dengan yang dipanggil berisiko urutan wiring salah.
- GoFile direct + share + batch saling berbagi helper (`resolveGofileFirstFile`, `filenameFromGofileUrl`) dan pattern `goPart` yang sudah diperbaiki berlapis — pindah bareng lebih aman daripada per-fungsi.

| Sub-step | Isi | Risk |
|----------|-----|------|
| **E4a** | `handleGofileUrl` (direct+share), `handleGofileBatch` — 3 fungsi GoFile sekaligus | Medium |
| **E4b** | `handlePixeldrainUrl`, `handleFiledonUrl`, `handleGdriveUrl`, `handleUcDriveUrl` (tanpa router) | Medium |
| **E4c** | `downloadSamehadakuFile` router saja — mulai setelah E4a+E4b merge & verifikasi | Low |

**Koreksi:** router (`downloadSamehadakuFile`) memanggil `handleGofileUrl`/`handlePixeldrainUrl`/`handleFiledonUrl`, sehingga harus menunggu callee stabil. Ia dipisah ke E4c sendiri setelah E4a+E4b merge, bukan digabung dalam commit yang sama dengan callee-nya.

**Catatan perubahan router pra-E4c (commit 017ae21 di branch E4b):** `downloadSamehadakuFile` semula hanya meneruskan `titleArg` ke GoFile/Pixeldrain, kini juga ke Filedon (`handleFiledonUrl(chatId, url, titleArg)`). Saat E4c memindahkan router, kode yang dipindah sudah termasuk perubahan ini — bukan versi proposal awal.

Tidak dipecah per-fungsi lebih jauh (overhead terlalu besar), tapi tidak juga 1 commit raksasa.

## 4. Rollback Plan

- Branch `batch-e4a-gofile`, `batch-e4b-other` terpisah dari `main` — 1 commit per sub-step, merge per sub-step setelah verifikasi.
- DB tidak disentuh. `bot.js` facade tetap ada sebagai fallback: jika wiring ctx gagal, `bot.js` bisa langsung require kode lama (comment switch 1 baris) tanpa kondisi setengah-pecah.
- Jika sub-step bermasalah: `git checkout main -- scraper/bot.js scraper/handlers/download.js` atau `git revert` 1 commit.

Tunggu approve sebelum mulai E4a. E4b tetap butuh approve terpisah setelah E4a selesai.
