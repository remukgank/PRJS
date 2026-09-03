# Fix Anti-Collision Season & Progress Samehadaku di GoFile

**Date**: 2026-09-03
**Author**: opencode

## Root Cause

Alur Samehadaku via GoFile (yang dipakai user: server gofile) punya 2 inkonsistensi vs Pixeldrain (yang sudah benar):

1. **Progress label `Episode 1` (harusnya N)** — `handleGofileUrl` direct pakai `goPartInit = extractPartFromFilename(fileName)` untuk `capWithEp` (progress). Fungsi ini gagal extract episode dari file samehadaku (`GKsTIeO-S2-6-FULLHD-SAMEHADAKU.xxx` → default 1), padahal `sami.episode` (dari `samehadakuEpisodeMap`, di-set saat `sam_go`) sudah tahu N.

2. **Judul hilang `S{season}`** — caption final di GoFile direct/share pakai `cleanTitle = sami.title || ...` yang memprioritaskan `sami.title` (dari `parseSamehadakuEpisode`, tidak mengandung `S{n}`) alih-alih `customTitle` (dari preview, sudah `... S2`). Pixeldrain sudah benar (`customTitle && !/S\d/.test(sami.title) ? customTitle : ...`). Akibatnya video S2 dikirim dengan judul tanpa S2, dan **fomo-drama** yang menangkap berdasarkan caption bisa menimpa Season 1 (slug sama: `anime:gaikotsu-...e-odekakechuu` vs `...-s2`).

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` `handleGofileUrl` direct (1932) | `goPartInit = sami?.episode ?? extractPartFromFilename(fileName)` |
| `scraper/bot.js` `handleGofileUrl` direct (1968) | `cleanTitle = (customTitle && !/S\\d/.test(sami.title||'')) ? customTitle : ...` (samakan dgn Pixeldrain) |
| `scraper/bot.js` `handleGofileUrl` share (2102) | `cleanTitle` — sama |
| `scraper/bot.js` `handlePixeldrainUrl` (2325) | `part = sami?.episode ?? parseSamehadakuFilename(info.name)?.episode ?? extractPartFromFilename(info.name)` |

## Detail Teknis

Pola yang disamakan:
- **Pixeldrain** sudah: `sami?.episode ?? extractPartFromFilename` untuk `pixPart` (label progress) + judul `customTitle && !/S\d/` untuk cleanTitle.
- **GoFile** disamakan ke pola Pixeldrain (progress + cleanTitle). Pixeldrain save `part` juga diperluas dengan `parseSamehadakuFilename` fallback agar robust kapan pun (jika `sami` null tapi fileName mengandung `S2-N`).

## Verification

- `node --check scraper/bot.js` — lulus
- Manual: alur samehadaku `...season-2` episode 6 via gofile — preview "S2 Ep 6" harus diikuti progress "Episode 6" dan caption final `➧ Judul :- Gaikotsu ... S2` / `➧ Season :- 2 Episode 6` → slug `anime:...-s2` (pisah dari Season 1) → tidak menimpa `anime:...` (Season 1).
