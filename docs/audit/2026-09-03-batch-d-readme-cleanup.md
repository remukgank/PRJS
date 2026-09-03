# Batch D — README Update & Cleanup Legacy Files

**Date**: 2026-09-03
**Author**: opencode
**Status**: Implemented

## Root Cause

- `scraper/README.md` outdated: list subdomain lama, tidak sebut reelfren (34 provider), samehadaku, vidara, gofile/pixeldrain/filedon/gdrive/VIP/AI/library. Stack setup masih `docker run flaresolverr` (sudah native).
- Duplikat file root vs scraper: `test*.js` (5 file) MD5 identik di root & `scraper/`, root `bot.js` (2405 baris) legacy beda dari `scraper/bot.js` (5610 baris) dan tidak dipakai.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `bot.js` (root) | **Hapus** — legacy, tidak direferensikan di `.replit` workflow / `package.json` scripts / `start.sh` (hanya `scraper/bot.js` yang dipakai) |
| `test.js`, `test-all-subdomains.js`, `test-rich.js`, `test-rich-direct.js`, `test-ucdrive.js` (root) | **Hapus** 5 file — duplikat identik dengan `scraper/test*.js` (MD5 identik), pertahankan `scraper/` |
| `scraper/README.md` | **Update full** — outline: Overview, Supported Sources (reelfren 34 provider + dramafren + samehadaku + file hosting), Architecture (bot.js 5610, handlers, services), Setup (env vars, FlareSolverr native, Local API, pm2), Usage (slash commands, inline keyboards, library), Development (test, audit log, batch history) |

## Verification

- `node --check scraper/bot.js` — lulus
- `node --check scraper/db.js` — lulus
- `ls scraper/test*.js` — 5 file masih ada di scraper
- `ls test*.js` (root) — tidak ada (sudah terhapus)
- `.replit` workflow cek: hanya `scraper/bot.js` direferensikan — aman hapus root `bot.js`

## Catatan

Commit terpisah dari behavior-fix Batch A/B/C (sesuai instruksi). File legacy bisa diambil dari git history kapan pun.
