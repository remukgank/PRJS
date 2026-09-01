# Solusi GoFile via Cloudflare Worker relay

**Date**: 2026-08-31
**Author**: opencode

## Root Cause (final)

`api.gofile.io` **diblokir di level jaringan** dari IP Replit/cloud (datacenter). TLS-impersonation curl_cffi dan Node https semuanya timeout TCP ke `103.107.198.3` & `.185`. Ini **bukan** masalah token/website-token — implementasi WT kita (sha256 UA::lang::accountToken::window::salt, salt `12af056dacea0b`) terbukti identik dengan tools populer (gofile-dl, GoFileDownloader) dan terverifikasi match browser.

`store-*.gofile.io` CDN **tetap bisa diakses** (itulah kenapa download manual `store-*` link selalu sukses). Yang diblokir hanya host `api.gofile.io` dan `gofile.io` web.

## Solusi

Sebuah **Cloudflare Worker relay** berjalan di network Cloudflare (tidak diblokir) yang memproksi `api.gofile.io/contents/<id>` dan mengembalikan JSON. Bot memanggil worker sebagai fallback saat API langsung gagal.

- Worker: `gofile-worker.js` (deploy ke `gofile.remuk-gank.workers.dev`, variable `TOKEN=MOrCvgQDAkNCsgbMPHhhxhH862yPAwzJ`)
- Endpoint worker: `GET /resolve?code=<id>` → `{ok, data}` (folder/children)
- Bot: `scraper/gofile.js` fallback order → API langsung (`GOFILE_TOKEN`) → **worker** (`GOFILE_WORKER_URL`) → FlareSolverr scrape.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/gofile.js` | TUK `WEBSITE_TOKEN` statis → `generateWebsiteToken()` dinamis (UA Chrome/152, X-BL, `X-Website-Token`, salt). Query params `page/pageSize/sortField`. Auth headers konsisten (UA hash match). Nambah `resolveViaWorker()`. Fallback 429 & network-block → worker relay → scrape. UA header pakai `GOFILE_UA`. Timeout API 25s. |
| `gofile-worker.js` (root, baru) | Cloudflare Worker relay untuk `api.gofile.io/contents/<id>`. `TOKEN` dari variable. Endpoint `/health`, `/resolve`. |

## Verification

- Langsung worker: `GET https://gofile.remuk-gank.workers.dev/resolve?code=qJJMOR6z` → `ok:true`, folder `qJJMOR6z`, child `1080p-QMpAN3j-kuronime-ymintsgai19.mp4` (351892574 bytes), link `store-eu-par-6`.
- Bot end-to-end: `node` call `resolveGofileFirstFile("https://gofile.io/d/qJJMOR6z")` dengan `GOFILE_WORKER_URL`+`GOFILE_TOKEN` → `OK {"url":"https://store-eu-par-6.gofile.io/download/web/dd99acbd-6dd4-4792-9d9d-fde3e80149d4/1080p-QMpAN3j-kuronime-ymintsgai19.mp4","name":"1080p-QMpAN3j-kuronime-ymintsgai19.mp4","size":351892574}`.
- `node --check scraper/gofile.js` → OK.

## Action user

- Set Replit Secrets: `GOFILE_WORKER_URL = https://gofile.remuk-gank.workers.dev` (dan `GOFILE_TOKEN = MOrC...`).
