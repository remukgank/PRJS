# Proposal E4b — handlers/download: Pixeldrain, Filedon, GDrive, UcDrive (tanpa router)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Proposal — belum dieksekusi, menunggu approve

## 1. 4 Fungsi + Test Coverage

| Fungsi | Baris di main | Test scenario |
|--------|---------------|---------------|
| `handlePixeldrainUrl` (1365-1508) | Pixeldrain: `GKsTIeO-S2-5` → `pixPart` = 5 via `sami?.episode ?? parseSamehadakuFilename ?? extract` |
| `handleFiledonUrl` (1514-1597) | Filedon: `TSSDK-S2-P2-1` → `partN = fdSame?.episode` + alias `tss→tssdk`, suffix S2P2 |
| `handleGdriveUrl` (1664-~1850) | GDrive: `TsSDKMGnoKh-FULLHD` → `titleForMedia` S-suffix anti-dobel, `epNum` benar |
| `handleUcDriveUrl` (1185-1255) | UC Drive: share invalid → pesan error, share valid → download + kirim (mock `getShareInfo`) |

Router `downloadSamehadakuFile` TIDAK termasuk — masuk E4c setelah E4a+E4b merge (sesuai koreksi split yang disepakati).

## 2. Shared State Per Fungsi (hasil audit di main)

**Map — hanya baca, 1 fungsi:**
- `handlePixeldrainUrl`: `samehadakuEpisodeMap.get(url)` ×1 — baca saja (`sami`)
- Filedon, GDrive, UcDrive: **TIDAK** akses Map apa pun langsung

**ctx untuk E4b (pola E4a):**
```js
initDownload({
  bot,
  config: { MAX_UPLOAD_MB },
  samehadakuEpisodeMap,                       // hanya dibaca Pixeldrain
  sendVideo, sendAudio, sendDocument,         // masih lokal di bot.js (tertunda ke E6, per keputusan tracked)
  Progress, RichProgress,
});
```
Tambahan dibanding E4a: `getSetting` (untuk gate `libsimpan` di Filedon/GDrive save), `resolveFiledonFile`/`resolveGdriveFile`/`getPixeldrainInfo`/`getShareInfo`/`downloadShare` di-import langsung dari modul masing-masing (stateless resolver, bukan shared Map), `remuxToMp4` dari downloader (Filedon mkv→mp4).

Tidak ada `require('../bot')` dari handler — cegah cyclical.

## 3. Temuan Verifikasi (jujur, mempengaruhi eksekusi)

**a. Filedon TIDAK pakai helper `detectTitleFromFilename`.** Dia punya jalur title sendiri (SHORT_ALIAS `tss→tssdk` + 3-step lookup `kuronime-*`/`samehadaku-*` + suffix `S{season}`, plus komentar anti-collision `TSS`). Saat ekstraksi E4b, blok ini **dipindah apa adanya** — tidak dipaksa lewat helper. Helper Batch C tetap dipakai GoFile/Pixeldrain/GDrive yang memang memanggilnya.

**b. Gate `getSetting('libsimpan')` di save Filedon/GDrive** (`titleForMedia`/`titleForCap` + slug `anime:*`). Modul perlu akses `getSetting` — masuk daftar import, bukan ctx (stateless db wrapper seperti di E4a).

**c. Perbedaan caption vs save title (Filedon/GDrive):** caption pakai `titleForCap`/`titleForMedia` (sudah include `S{season}` anti-dobel), save pakai slug yang sama. Ekstraksi harus pertahankan kedua variabel ini utuh — bukan disederhanakan.

## 4. Rollback Plan

- Branch `batch-e4b-other` terpisah dari `main` — 1 commit, merge setelah verifikasi.
- DB tidak disentuh. `bot.js` facade simpan wrapper delegasi tipis (pola E4a) — jika wiring ctx gagal, fallback ke kode lama 1 baris.
- Jika bermasalah: `git checkout main -- scraper/bot.js` + hapus tambahan di `scraper/handlers/download.js`, atau `git revert` 1 commit.

Tunggu approve sebelum mulai E4b. E4c (`downloadSamehadakuFile` router) dibahas setelah E4a+E4b merge.
