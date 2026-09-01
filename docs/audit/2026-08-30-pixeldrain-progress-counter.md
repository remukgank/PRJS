# Fix Pixeldrain Progress 0% & Counter 0✓

**Date**: 2026-08-30
**Author**: opencode

## Root Cause

1. **Progress 0% selama 1m55s**: `downloadWithAria2c` (`scraper/downloader.js:281`) hanya log jika ada `pctMatch \((\\d+)%\)`. Saat `aria2c` fase awal (DNS/connect) tidak ada `%`, `onLog` tidak terpanggil → `RichProgress` stuck 0%. File 448.7 MB selesai 7m30s (throttling Pixeldrain), tapi UI tidak update hingga ada progress.

2. **Counter 0✓ (padahal sukses 448.7 MB)**: `handlePixeldrainUrl:2164` pakai `rp = new RichProgress(cap, [{ep: cap}])` dengan key `cap` awal (`Yomi no Tsugai`). Setelah `customTitle`, `cap` ditimpa jadi `finalCap` blok (`➧ Judul :- ...`), tapi `rp.updateEpisode(cap, 'done')` dipanggil dengan `cap` baru → `RichProgress.updateEpisode` cari `e.ep === cap` tidak ketemu → status tetap `pending` → `doneCount=0`.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/downloader.js` | `onData` tambah fallback `DL:XX MiB` log tiap 5s jika tanpa `%` (tampilkan `DL: 12.3MiB`) |
| `scraper/bot.js` | `handlePixeldrainUrl` simpan `capEp = cap` sebelum timpa; `downloadWithAria2c` callback handle `DL:`; `sendVideo/savePartFileId` pakai `finalCap`; `rp.updateEpisode(capEp, 'done')` pakai key awal |

## Detail Teknis

- `downloader.js:283` `onData` sekarang: jika `pctMatch` tidak ada, cek `dlMatch DL:([\d\.]+)(\w+)` → `onLog DL: XXMiB` tiap 5s.
- `bot.js:2109` `capEp` capture key awal sebelum `finalCap` overwrite. `rp.updateEpisode(capEp, 'done')` jamin hit `ep === cap`.

## Verification

- `node --check scraper/bot.js` -> OK
- `node --check scraper/downloader.js` -> OK
- Skenario: kirim `https://pixeldrain.com/u/xBdBBnHN` (Yomi no Tsugai) → progress tidak lagi 0% (muncul `DL: XX MiB`), selesai `done:1` (bukan 0✓).
