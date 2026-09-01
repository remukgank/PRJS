# 2026-08-09: cleanCaption — parse pola kuronime s{season}{ep} + part + tanpa season

## Konteks
File dari pixeldrain/gofile hasil scrape kuronime punya nama pola:
- `juduls{season}{episode}` (contoh `mtiihds209v0.mp4`)
- `juduls{season}prt{part}{episode}` (contoh `mtiihds2prt201.mp4`)
- `judul{episode}` tanpa penanda season (contoh `tnmkunjdgar07.mp4`)

Judul di nama file pixeldrain/gofile berupa singkatan (misal `tnmkunjdgar` =
"Tenmaku no Jaadugar"), bukan full judul.

Sebelumnya `cleanCaption` pakai `replace(/([a-zA-Z])(\d{1,3})$/, '$1 Ep $2')`
yang menempelkan "Ep" ke akhiran angka apa pun — termasuk hash file random,
sehingga muncul caption palsu seperti `Xdfghuio23 Ep 0` / "Ep 0". Selain itu
pola tanpa season (`tnmkunjdgar07`) tidak terpecah — tampil `tnmkunjdgar07`
padahal seharusnya `tnmkunjdgar Episode 7`.

## Root Cause
1. Regex lama `/([a-zA-Z])(\d{1,3})$/` tidak membedakan hash random dengan pola
   kuronime asli, jadi setiap nama yang berakhiran huruf+angka dapat label "Ep".
2. Regex kuronime yang baru awalnya hanya mengenali pola ber-penanda `s{season}`;
   pola `judul{episode}` tanpa season tidak tertangkap.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` | Hapus regex "Ep 0" palsu; tambah 3 regex pola kuronime di `cleanCaption`: `juduls{season}{ep}`, `juduls{season}prt{part}{ep}`, dan `judul{ep}` tanpa season |

## Detail Teknis

```js
// Parse pola kuronime "juduls{season}{episode}[v{n}]" → "judul s{season} Ep {episode}"
s = s.replace(/\b([a-z]{4,})s(\d)(\d{1,2})(?:v\d)?\b/g,
  (m, t, season, ep) => `${t} s${season} Ep ${String(Number(ep))}`);
// Parse pola kuronime part "juduls{season}prt{part}{episode}" → "judul Season {season} Part {part} Episode {episode}"
s = s.replace(/\b([a-z]{4,})s(\d)prt(\d{1,2})(\d{2})\b/g,
  (m, t, season, part, ep) => `${t} Season ${season} Part ${part} Episode ${String(Number(ep))}`);
// Parse pola kuronime tanpa season "judul{episode}" → "judul Episode {episode}"
s = s.replace(/\b([a-z]{4,})(\d{2})\b/g,
  (m, t, ep) => `${t} Episode ${String(Number(ep))}`);
// Handle "Ep15" → "Ep 15"
s = s.replace(/\b(ep)(\d{1,3})$/gi, '$1 $2');
```

- Regex kuronime butuh judul lowercase minimal 4 huruf (`[a-z]{4,}`) biar tidak
  menyentuh hash/mixed case yang sudah difilter di atas.
- `(?:v\d)?` menangani varian `v0`/`v1` di akhir nama kuronime.
- `String(Number(ep))` membuang leading zero pada episode/part.
- Regex tanpa season hanya cocok ke **tepat 2 digit** di akhir (`\d{2}`), jadi
  nama ber-akhiran 3-4 digit (misal `onepiece1085`) tidak ikut terpecah.
- Urutan penting: regex tanpa season dijalankan setelah regex `s{season}`/part,
  sehingga `mtiihds209v0` tetap jadi `Mtiihd s2 Ep 9` dan tidak terpecah ulang.

## Verification

- `node --check scraper/bot.js` — OK
- Test langsung hasil:
  - `1080p-BP3lzRI-kuronime-tnmkunjdgar07.mp4` → `1080p tnmkunjdgar Episode 7`
  - `1080p-kuronime-tnmkunjdgar01.mp4` → `1080p tnmkunjdgar Episode 1`
  - `tnmkunjdgar07.mp4` → `Tnmkunjdgar Episode 7`
  - `mtiihds209v0.mp4` → `Mtiihd s2 Ep 9`
  - `mtiihds2prt201.mp4` → `Mtiihd Season 2 Part 2 Episode 1`
  - `mtiihds2prt2101.mp4` → `Mtiihd Season 2 Part 21 Episode 1`
  - `abcdefs13v0` → `Abcdef s1 Ep 3`
  - `onepiece1085.mp4` → `Onepiece1085` (4 digit — tidak terpecah)
  - `somevideo.mp4` → `` (terfilter sebagai source name, di luar scope)
  - `narutos7ep12.mp4` → `Narutos7ep12` (tidak match pola — di luar scope)

## Trade-off
- Regex tanpa season bisa memecah hash lowercase yang berakhir 2 digit menjadi
  "judul + Episode N" (contoh teoretis `xdfghuio23`). Risiko rendah karena
  hash di file kuronime selalu mixed-case (misal `BP3lzRI`) dan sudah difilter.
