# Bug: Part Save Salah Utk File Samehadaku (extractPartFromFilename gagal)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Ditemukan saat tes manual Batch A (bot live via pm2) — **belum di-fix**, tunggu approval

## Temuan

File samehadaku format `SHORT-S{season}-{ep}-FULLHD-SAMEHADAKU.xxx` (mis. `GKsTIeO-S2-2-FULLHD-SAMEHADAKU.CARE.mp4`) tersimpan sebagai **part 1** alias bukan part sesuai episode.

## Bukti (dari log bot live / pm2)

```
Pixeldrain selesai
  file: "GKsTIeO-S2-2-FULLHD-SAMEHADAKU.CARE.mp4"   ← episode 2
Skip save: part already exists
  slug: "anime:gaikotsu-kishi-sama-tadaima-isekai-e-odekakechuu-s2"
  part: 1    ← SALAH (harusnya 2)
  existingFile: "GKsTIeO-S2-1-..."   ← bentrok dengan ep1
```

User report: caption yang dikirim **sudah benar** "Season 2 Episode 2", tapi progress/display tampil "Episode 1, 0✓/1" dan ep2 di-skip ("Skip save: part already exists, part: 1").

## Root Cause

`extractPartFromFilename()` tidak bisa mengekstrak episode dari file samehadaku format `SHORT-S{season}-{ep}-FULLHD-SAMEHADAKU`:
- pola `parseKuronimeSeasonEpisode` (`[a-z]{3,}s{d}{d}`) — tidak match (pakai `-S2-` uppercase)
- `{code}{ep}unc` — tidak match
- `Ep`/`Episode`/`E`/`Part` — tidak ada
- `(\d{1,3})\s*$` — file ends `...SAMEHADAKU.CARE` (bukan digit)
- → default return **1**

Padahal `parseSamehadakuFilename()` **sudah bisa** extract `{season:2, episode:2}` dari format ini.

## Dampak

1. Display/progress `capWithEp` jadi "Episode 1" (bukan episode sebenarnya)
2. Save part → 1 → bentrok dengan ep1 → "Skip save" → ep2 tidak tersimpan

Catatan: caption `finalCap` sudah benar (pakai `sami.episode` dari map) — hanya **part untuk save & display** yang salah.

## Lokasi & Pola per Handler

| Handler | Display part | Save part | Pakai `X?.episode ?? extract`? |
|---------|-------------|-----------|-------------------------------|
| `handlePixeldrainUrl` | `extractPartFromFilename` (2272) ❌ | `extractPartFromFilename` (2318) ❌ | ❌ gagal |
| `handleGofileUrl` direct | `goPart` (1958) ❌ | `goPart` (2011) ❌ | ❌ gagal |
| `handleGofileUrl` batch | `batchPart` (2092) ❌ | `batchPart` (2138) ❌ | ❌ gagal |
| `handleFiledonUrl` | `fdSame?.episode ?? extract` (2408) | `partN` (2473) | ✅ benar |
| `handleGdriveUrl` | `gdSame.episode` (caption) | `epNum = gdSame?.episode ?? extractPart` (2672) | ✅ benar |

**Pola yang benar** (dipakai Filedon & GDrive): `X?.episode ?? extractPartFromFilename(name)`. GoFile & Pixeldrain tidak pakai pola ini.

## Proposal Fix (butuh approval)

Di GoFile (direct + batch) & Pixeldrain handler: untuk file samehadaku pakai `parseSamehadakuFilename(fileName).episode` (atau `sami.episode`) sebagai part, fallback `extractPartFromFilename` untuk non-samehadaku — persis pola Filedon/GDrive.

- Helper: `part = (parseSamehadakuFilename(fileName)?.episode) ?? extractPartFromFilename(fileName)`
- Berlaku untuk display (`pixPart`/`goPart`/`batchPart`) dan save.

## Scope File (jika di-approve)

- `scraper/bot.js`: 4 titik koreksi (Pixeldrain display+save, GoFile direct display+save, GoFile batch display+save)

## Verification (untuk setelah fix di-approve)

- `node --check scraper/bot.js`
- Test `extractPartFromFilename` + `parseSamehadakuFilename.episode` untuk `GKsTIeO-S2-2-FULLHD-SAMEHADAKU.CARE.mp4` → harus part 2
- Functional test bot live: download ep2 samehadaku → tersimpan sebagai part 2 (bukan skip)

## Keterkaitan

Ini **berbeda/terpisah** dari Batch A/B yang sudah di-approve. Ditemukan saat tes manual Batch A. Tidak ikut di-fix tanpa approval terpisah (SOP: isu di luar scope proposal → laporkan dulu).
