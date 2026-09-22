# PROPOSAL: Fix parsing episode Part X Episode Y di fomo-drama (+ cross-check checklist)

- Date: 2026-09-22
- Scope: repo fomo-drama (terpisah, github.com/tentangblockchain/fomo-drama) — public repo PRJS TIDAK berubah
- Type: read-only osama dari PRJS; implementasi dipegang agent fomo-drama

## 1. Konteks

PRJS mengirim video anime dengan caption format `➧ ... :- ...` (eperator ` :- `).

Ada dua bentuk caption yang diproduksi PRJS (`scraper/bot.js`):

| Label | Caption | Produksi |
|---|---|---|
| A | `➧ Judul :- One Piece S2 P1` / `➧ Season :- 2 Part 1 Episode 1125` / `➧ Provider :- samehadaku` | gdriveplayer & samehadaku saat season+part (bot.js:3151, 3589) |
| B | `➧ Judul :- X` / `➧ Episode :- 24` / `➧ Provider :- <tg-spoiler>..</tg-spoiler>` | gofile direct, batch, dll (bot.js:1781-1917) |
| C | `➧ Judul :- Naruto` / `➧ Episode :- 220` / ... | batch (download.js) |
| D | `➧ Judul :- Yomi no Tsugai` / `➧ Season :- 1 Episode 8` / `➧ Provider :- kuronime` | kuronime (bot.js) |

## 2. Findings (reproducible)

`_parseEpisodeFromText` fomo-drama (`handlers/contentHandler.js` ~60-90) mengecek
regex **`part` PERTAMA** dan `return` langkah (last-match):

```
\bpart\s*:?\s*[-–—]?\s*(\d{1,4})\b   → return di match terakhir
```

Hasil parse dengan caption asli PRJS (diuji persis dengan regex f574716):

```
A Season+Part  "➧ Season :- 2 Part 1 Episode 1125"  → EP=1   ✗ HARUS 1125
B Episode saja "➧ Episode :- 24"                    → EP=24  ✓
C Batch        "➧ Episode :- 220"                   → EP=220 ✓
D Kuronime     "➧ Season :- 1 Episode 8"            → EP=8   ✓
```

**Bug**: caption A (format yang dipakai PRJS untuk season+part) ter-parse ke
nomor PART, bukan EPISODE. Patch f574716 sudah memperbaiki separator ` :- ` dan
penyimpanan caption, tetapi tidak menangani prioritas `part` vs `episode`.

## 3. Root cause

- Handler utama sudah punya `seasonMatchUp` yang benar:
  `/Season\s*:?[\s-]*\s*(\d+)(?:\s+Part\s+\d+)?\s+Episode\s+(\d+)/i`
  (group 1 = season, group 2 = episode) — tetapi HANYA dipakai untuk `detectedSeason`,
  lalu `episodeNumber` tetap dari `_parseEpisodeFromText`.
- `_parseEpisodeFromText` balik regex; `part` → `ep` → `episode` → tail-number.

## 4. Usulan fix (opsi)

### Opsi A (disarankan, perubahan minimal di handler)
Di blok `if (waitingInfo.isAuto)`:

```js
const detectedEp = seasonMatchUp
  ? parseInt(seasonMatchUp[2], 10)   // episode asli dari "Season X [... Part Y] Episode Z"
  : this._parseEpisodeFromText(caption);
```

Artinya: kapan format `Season ... Episode N` cocok, episode diambil langsung dari
regex yang sudah benar; `_parseEpisodeFromText` hanya fallback.

### Opsi B (perkuat juga helper, untuk konsistensi `_parseEpisodeFromText`)
Urutkan prioritas regex: `episode` → `part` → `ep/e` → tail-number, alias:

```js
matches = [...cleaned.matchAll(/\bepisode\s*:?\s*[-–—]?\s*(\d{1,4})\b/gi)];
if (matches.length) return parseInt(matches.at(-1)[1], 10);
// lalu part, eps/ep/e, dst
```

Milestone narik: regex `ep` (`\b(?:eps|ep|e)\s*...`) juga bisa false-match teks
caption lain yang berakhiran e + angka — kosongkan bila ragu.

## 5. Kasus uji (wajib PASS setelah implementasi)

| # | Input | Expected |
|---|---|---|
| 1 | `➧ Season :- 2 Part 1 Episode 1125` | EP 1125, season 2 |
| 2 | `➧ Season :- 3 Part 2 Episode 41` | EP 41, season 3 |
| 3 | `➧ Episode :- 24` | EP 24 |
| 4 | `➧ Season :- 1 Episode 8` | EP 8 |
| 5 | `➧ Episode :- 220` | EP 220 |
| 6 | filename tanpa caption `OP-1125-4K-SAMEHADAKU.CARE.mp4` | EP 1125 (range regex) atau null → auto-number, TIDAK EP salah |
| 7 | filename tanpa caption `1080p-0nizdxx-kuronime-ymintsgai06.mp4` | null → auto-number (bukan 6) |

## 6. Checklist cross-check untuk agent fomo-drama

- [ ] Tulis ulang/migrasi `_parseEpisodeFromText` + handler mengikuti Opsi A dan/atau B.
- [ ] Pastikan `caption` disimpan ke `media_parts.caption` pada mode auto & manual (sudah mulai di f574716 — verifikasi dua-duanya).
- [ ] `_parseEpisodeRangeFromText` tetap jalan duluan (merged part) sebelum parse tunggal.
- [ ] Pastikan `detectedSeason` tidak diisi untuk caption tanpa kata Season.
- [ ] Verifikasi tidak ada regresi pada captioan `<tg-spoiler>` di `_extractProvider`.
- [ ] Jalan-ulang semua test di repo fomo-drama; tambahkan kasus 1-7 di atas.
- [ ] Cross-check hasil dengan caption asli yang dikirim PRJS (format ➧ ... :-).

## 7. Status

- [ ] Disetujui owner
- [ ] Implementasi fomo-drama
- [ ] Test 1-7 hijau
- [ ] Commit + push fomo-drama