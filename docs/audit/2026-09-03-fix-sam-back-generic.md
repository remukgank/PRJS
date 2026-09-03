# Fix sam_back Kembali ke List Episode untuk Anime Selain Tensura

**Date**: 2026-09-03
**Author**: opencode

## Root Cause

Callback `sam_back` (Kembali ke list episode) mengandalkan `animeUrl.includes('/anime/')` check dengan fallback hardcode hanya untuk Tensura:

```js
if (!animeUrl.includes('/anime/')) animeUrl = animeUrl.replace(/\/tensei[^/]+\/.*/, '/anime/tensei-shitara-slime-datta-ken-season-4/');
```

Untuk episode anime lain (mis. Gaikotsu), `animeUrl` yang dikirim via `sam_ep` adalah `episodeUrl.split('/episode-')[0] + '/'` tanpa prefix `/anime/` (mis. `https://v2.samehadaku.how/gaikotsu-...-season-2-/`), sehingga tidak mengandung `/anime/` dan tidak match regex Tensura → `animeUrl` tetap salah → `resolveSamehadakuFullhd(animeUrl)` gagal → `⚠️ Gagal load episode.`

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` `sam_ep` (4745) | Bikin `animeUrlBack` secara generic dari `parseSamehadakuEpisode(episodeUrl).slug` → `https://v2.samehadaku.how/anime/<slug>/` |
| `scraper/bot.js` `sam_back` (4760) | Fallback generic: jika `!includes('/anime/')`, coba `parseSamehadakuEpisode(animeUrl + '-episode-1/').slug` → reconstruct, fallback hardcode Tensura hanya sebagai last resort |

## Verification

- `node --check scraper/bot.js` — lulus
- Manual: alur samehadaku `anime Gaikotsu S2 → pilih ep → pilih server → Kembali ke list episode` harus kembali ke daftar episode (bukan Gagal load episode).
