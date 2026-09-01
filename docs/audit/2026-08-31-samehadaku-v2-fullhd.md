# Handler Samehadaku v2 (FULLHD/4K) via Worker relay

**Date**: 2026-08-31
**Author**: opencode

## Root Cause

User butuh scrape `https://v2.samehadaku.how/anime/../` untuk cari link server 1080p (Gofile|Krakenfiles|Pixeldrain|Filedon) secara otomatis, bukan paste manual. `v2.samehadaku.how` diblokir dari Replit (Cloudflare `cf_clearance`), tapi terverifikasi **bisa** via Cloudflare Worker fetch (network edge tidak diblokir). Kualitas prefer user: `4K > FULLHD (1080p) > MP4HD`, kalau 4K ada pilih 4K, kalau hanya FULLHD tidak masalah.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `gofile-worker.js` | Endpoint `/fetch` + `/samehadaku?url=...` — parse `<div class="download-eps">` → blocks per kualitas (4K/FULLHD/MP4HD/480p/360p). Prefer 4K > FULLHD > MP4HD. Support `CF_CLEARANCE` cookie (env `CF_CLEARANCE`). |
| `scraper/samehadaku.js` (baru) | `isSamehadakuUrl`, `resolveSamehadakuFullhd(url)` via Worker `/samehadaku`. |
| `scraper/bot.js` | Import samehadaku. Handler `isSamehadakuUrl(text)` → resolve via worker → keyboard server (Gofile/Krakenfiles/Pixeldrain/Filedon). Callback `sam_dl:<server>:<urlId>` → resolve lagi → teruskan ke `handleGofileUrl`/`handlePixeldrainUrl`. Pesan unknown ditambah `v2.samehadaku.how`. |

## Verification

- Worker `/fetch` verify: `v2.samehadaku.how/` bisa di-fetch via CF edge (via `gofile.remuk-gank.workers.dev/fetch?url=...`).
- Samehadaku page HTML berisi `download-eps` (FULLHD/MP4HD/4K) dengan Gofile/Pixeldrain/Krakenfiles/Filedon.
- `node --check scraper/bot.js` & `scraper/samehadaku.js` → OK (worker bukan Node check).

## Deploy notes

- Worker `gofile.remuk-gank.workers.dev`: deploy `gofile-worker.js` terbaru & set `TOKEN` + `CF_CLEARANCE` (cf_clearance dari browser) di Settings → Variables.
