# Catatan: Tensura 5 Judul (S, S2, S2 P2, S3, S4) — untuk agent fomo-drama

**Tanggal**: 2026-09-01
**Commit PRJS**: 2ddaf14 + 3afa22b (samehadaku S2 part 2), sebelumnya 77b149a (fomo `season` INT)
**Konteks**: PRJS scraper + fomo-drama auto-save via caption `➧ Judul / Season / Provider`

## Masalah yang diperbaiki

Tensei Shitara Slime Datta Ken punya 5 varian di Samehadaku v2:
- `tensei-shitara-slime-datta-ken` (S1, tanpa `-season-`) → 25 ep
- `tensei-shitara-slime-datta-ken-season-2` (S2, 11 ep)
- `tensei-shitara-slime-datta-ken-season-2-part-2` (S2 P2, 11 ep) ← **Part 2, bentrok S2 Ep1**
- `tensei-shitara-slime-datta-ken-season-3` (S3, 23 ep)
- `tensei-shitara-slime-datta-ken-season-4` (S4, 20 ep)

**Bug fomo-drama** (handlers/contentHandler.js:858 sebelum fix):
`find(p => p.part === partNumber)` hanya cek `part`, tidak cek `season`.
Akibat: DB sudah `tensei season=4 part=1 (S4E1)`, baru `season=null part=1 (S1E1)` → `find(part 1)` ketemu S4E1 → **overwrite**, bukan tambah. Log: `Scraper: update part 1 di "Tensei..."` bukan `tambah`.

## Solusi PRJS (read-only untuk fomo di sini, PRJS yang jalan via pm2 prjs-bot)

**Sebelum**: PRJS kirim 1 judul sama semua season:
`Tensei Shitara Slime Datta Ken` untuk S1, S2, S2 P2, S3, S4 → `mediaKey = tensei shitara slime datta ken` (sama) → bentrok `part`.

**Sesudah** (scraper/bot.js 4327 + scraper/samehadaku.js parseSamehadakuEpisode):
```js
const sameTitleArg =
  `${sameInfo.title}${sameInfo.season ? ` S${sameInfo.season}` : ''}${sameInfo.part ? ` P${sameInfo.part}` : ''}`;
// Hasil:
// S1           → "Tensei Shitara Slime Datta Ken"
// S2           → "Tensei Shitara Slime Datta Ken S2"
// S2 P2        → "Tensei Shitara Slime Datta Ken S2 P2"
// S3           → "Tensei Shitara Slime Datta Ken S3"
// S4           → "Tensei Shitara Slime Datta Ken S4"
```
`titleArg` ini diteruskan ke `handleGofileUrl(chatId, fileUrl, titleArg)` → caption `➧ Judul :- Tensei... S2 P2` + `➧ Season :- 2 Part 2 Episode 1` + `➧ Provider :- samehadaku`.

**Efek di fomo-drama** (fomo read-only di workspace ini, jalan di server kamu):
- `mediaKey = mediaName.toLowerCase()` → 5 media terpisah:
  - `tensei shitara slime datta ken` (S1)
  - `tensei shitara slime datta ken s2`
  - `tensei shitara slime datta ken s2 p2`
  - `tensei shitara slime datta ken s3`
  - `tensei shitara slime datta ken s4`
- `find(p.part === 1)` tidak bentrok lagi karena `mediaKey` beda.
- DB `77b149a`: `media_parts.season INT` + `UNIQUE(media_slug, season, part)` juga aman: `season=2 part=1` beda dengan `season=2 part=1` tapi slug beda (`...-s2` vs `...-s2-p2`) — tidak perlu andalkan `season` saja.

## Caption format (PRJS)

- S4 Ep1: `➧ Season :- 4 Episode 1` (+ `Part 2` jika `s2 p2` → `Season :- 2 Part 2 Episode 1`)
- S1 Ep1: `➧ Episode :- Episode 1` (season null → tanpa Season)
- File `tssdks401` (kuronime) juga `Season :- 4 Episode 1` via `parseKuronimeSeasonEpisode`

## Untuk agent fomo-drama

- Jika update `savePartFromScraper`, pastikan `provider` dari caption (`samehadaku`) prioritas > filename, agar `kategori: anime` benar.
- Jika handle `Season 4 Episode 1` di `index.js`, sudah ada `seasonMatch` → `seasonNum` + `episodeRange: "Season 4 Episode 1"` + `season: 4` (77b149a). Tetap pakai `mediaKey` dengan ` S2 P2` suffix dari judul PRJS agar tidak overwrite.
- fomo di sini read-only, PRJS (pm2 prjs-bot, pid 8546) yang jalan. Jangan `pm2 restart fomo-drama` dari sini.
