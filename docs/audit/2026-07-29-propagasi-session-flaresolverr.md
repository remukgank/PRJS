# Propagasi FlareSolverr Session ke getAllEpisodes & fetchPageHtml

**Date**: 2026-07-29
**Author**: opencode

## Root Cause

`getAllEpisodes` dan `fetchPageHtml` di `scraper/index.js` tidak menerima parameter `session`, sehingga setiap request detail page ke d明fren.org selalu membuat sesi FlareSolverr baru tanpa cookie. Cloudflare memberikan challenge berat (timeout 60s) karena tidak ada cookie/sesi yang reusable.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/index.js` | `fetchPageHtml(url, session, _isRetry)` — tambah param session + retry logic; `getAllEpisodes(subdomain, id, slug, lang, session)` — tambah param session, di-pass ke `fetchPageHtml` |
| `scraper/batch-download.js` | Panggilan `getAllEpisodes(...)` dikasih `session` dari `createSession()` |
| `scraper/vidara-uploader.js` | `processDrama(key, info, session)` — terima session dari `main()`; dikasih ke `getAllEpisodes` dan `getVideoUrl` |

## Detail Teknis

- `session` opsional (default `undefined`), caller lama tanpa session tetap jalan.
- `fetchPageHtml` sekarang punya retry 1x (mirip `interceptVideoUrl`) — kalau FlareSolverr error/500, coba sekali lagi.
- `vidara-uploader.js`: session dibuat di `main()` → di-pass ke `processDrama()` → dipakai buat `getAllEpisodes` (scrape episode list) dan `getVideoUrl` (scrape tiap episode).

## Verification

- `node --check` lulus untuk ketiga file.
- Test manual di server: batch download berjalan normal, FlareSolverr session terlihat reusable (detail page gak timeout lagi).
