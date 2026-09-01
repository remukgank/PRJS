# Samehadaku v2 — Anime + Episode 2-tier (Tensura S4 Ep1-20)

**Date**: 2026-08-31
**Author**: opencode

## Root Cause

Trace Tensura (`https://v2.samehadaku.how/anime/tensei-shitara-slime-datta-ken-season-4/`): halaman anime bukan episode download — tidak punya `download-eps` (FULLHD/4K). Dia punya `lstepsiode` list: 20 `...-episode-N/` (HTML yang di-paste: `tensei-...-episode-20` → `...-episode-1`). Worker limit head 12000, anime 200 body terpotong. Perlu 2-tier: anime → list episode → episode → FULLHD.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `gofile-worker.js` | `/samehadaku` deteksi `isAnime` (`/anime/` di URL): parse `href="...-episode-N/"` → `episodes[]` (type `anime`). Episode page: parse `download-eps` (4K > FULLHD > MP4HD). |
| `scraper/samehadaku.js` | `resolveSamehadakuFullhd` return raw `json` (type anime/episode). |
| `scraper/bot.js` | Handler anime: keyboard `Ep 1..20` (5 per row, `sam_ep:`). Handler episode: keyboard server FULLHD/4K. Tambah `sam_ep:` callback. |
| `.replit` | Lokal (workflow), not committed. |

## Verification

- Trace `v2.samehadaku.how/anime/tensei-shitara-slime-datta-ken-season-4/` via Worker: 200, anime (20 eps). Episode Jepang (`...-エピソード-1/`) 302/404 tanpa cf_clearance — worker perlu CF_CLEARANCE untuk episode Jepang charset. Episode `...-episode-1/` (latin) akan FULLHD servers jika CF_CLEARANCE ter-set.
- `node --check` OK.

## Deploy notes

- Worker `gofile.remuk-gank.workers.dev`: deploy `gofile-worker.js` & set `CF_CLEARANCE` (cf_clearance dari browser Samehadaku) di Variables.
