# Fix GoFile share fallback scrape + DL progress + judul

**Date**: 2026-08-30
**Author**: opencode

## Root Cause

1. **Share `gofile.io/d/G1bJa0` / `qJJMOR6z` perlu inspect dev tools**: Di Replit `api.gofile.io:443` `timeout 15s` (IP `103.107.198.3/185`), `resolveGofileFiles` selalu `HTTP 000` → tidak dapat `child.link` (`store.../1080p-...mp4`) otomatis.

2. **Estimasi 60 detik (07:24:10 → 07:25:10)**: `curl -m 30` x 2 IP = `30s` baru `isNetworkBlock` → `scrapeGofileSharePage` baru jalan. Hasil valid: `status: ok, folder qJJMOR6z → 1080p-QMpAN3j-kuronime-ymintsgai19.mp4` (351 MB) tapi terlambat.

3. **Judul hilang & hash tidak terfilter**: `extractSourcePattern` tidak filter `0nizdxx`/`abc1234` (hash lowercase+digit) → `kuronime-ymintsgai` tidak match DB untuk `3N5MjFF4`.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/gofile.js` | `curlJson` tambah param `timeoutSec=30`; `api.gofile.io/contents/{id}` pakai `10s`; tambah fallback `error-notPremium` tanpa `Authorization` + scrape fallback `scrapeGofileSharePage(id)` (curl `gofile.io/d/{id}` regex `store.*gofile.io/download`); tambah `scrapeGofileSharePage` function |
| `scraper/bot.js` | `extractSourcePattern` tambah filter hash `^[a-z0-9]{5,8}$` (lowercase+digit) di posisi 1+; `dl_title_use` teruskan `detectedTitle` ke `handleGofileUrl/handlePixeldrainUrl`; progress `DL:` fallback + `capWithEp` untuk `RichProgress` |
| `scraper/downloader.js` | `onData` tambah `DL: XX MiB` tiap 5s saat tanpa `%` (hindari stuck `0%`) |

## Verification

- `node --check scraper/gofile.js scraper/bot.js scraper/downloader.js` → OK
- Skenario: `https://gofile.io/d/G1bJa0` → prompt `➧ Judul :- Yomi no Tsugai` (MfZMon9 terfilter → kuronime-ymintsgai) + tombol `📥 Download: Yomi no Tsugai`
- Skenario: `https://gofile.io/d/qJJMOR6z` → API `qJJMOR6z?wt=4fd6sg89d7s6` (`200 success` di browser) vs Replit `HTTP 000` → fallback scrape `store-eu-par-6.../1080p-QMpAN3j...19.mp4` (348 MB) langsung tanpa inspect
- Unit `extractSourcePattern`: `1080p-0nizdxx-kuronime-ymintsgai06.mp4` → `kuronime-ymintsgai` ✓
