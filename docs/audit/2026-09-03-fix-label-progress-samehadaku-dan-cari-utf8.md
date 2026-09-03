# Fix Label Progress Samehadaku + Bug /cari UTF-8

**Date**: 2026-09-03
**Author**: opencode
**Status**: Implemented

## Fix 1 — Label progress samehadaku salah (Episode 1 padahal 2)

### Root Cause
`handlePixeldrainUrl` dan `handleGofileUrl` membangun label progress `capWithEp` dari `extractPartFromFilename(info.name)`. Fungsi ini **gagal** mengekstrak episode dari file samehadaku format `SHORT-S2-N-FULLHD-SAMEHADAKU.xxx` (return default 1), karena regex tidak match pola `-S{d}-{ep}-`. Padahal `sami.episode` (dari `samehadakuEpisodeMap`, di-set saat callback `sam_go`) sudah tahu episode yang benar.

Akibat: label progress saat download tampil "Episode 1" padahal sebenarnya episode N (mis. 2). Setelah video terkirim, caption final benar (pakai `sami.episode`).

### Perubahan (`scraper/bot.js`)
| Lokasi | Sebelum | Sesudah |
|--------|---------|---------|
| `handlePixeldrainUrl` (line ~2272) | `extractPartFromFilename(info.name)` | `sami?.episode ?? extractPartFromFilename(info.name)` |
| `handleGofileUrl` direct (line ~1958) | `extractPartFromFilename(fileName)` | `sami?.episode ?? extractPartFromFilename(fileName)` |
| `handleGofileUrl` share (line ~2092) | `extractPartFromFilename(file.name)` | `sami?.episode ?? extractPartFromFilename(file.name)` |

## Fix 2 — Bug `/cari` : "inline keyboard button text must be encoded in UTF-8"

### Root Cause
`truncateText(t, max)` memakai `t.slice(0, max-1)`. Jika posisi potong jatuh **di tengah surrogate pair** (emoji 🎌/🎬 = 2 code unit), hasilnya string berisi **high surrogate tunggal** (mis. `\ud83c`) yang tidak berpasangan → bukan valid UTF-8 saat di-encode ke JSON API Telegram → reject "must be encoded in UTF-8".

Contoh: `'A'.repeat(62) + '🎬'` dipotong `slice(0,63)` → `...AAAA + '\ud83c'(high) + '…'` → invalid.

### Perubahan (`scraper/bot.js` `truncateText`)
```js
function truncateText(t, max = 64) {
  if (t.length <= max) return t;
  let cut = t.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1); // buang high surrogate menggantung
  return cut + '…';
}
```
Ini fix di fungsi inti → mencakup semua pemanggil (library search, keyboard, dll), bukan cuma `/cari`.

## Verification

- `node --check scraper/bot.js` — lulus
- Fix2 test: `truncateText('A'.repeat(62)+'🎬'+..., 64)` → `...A…` (tanpa surrogate menggantung), valid UTF-16 ✓
- Fix1: `sami?.episode ?? extractPart` → utk file samehadaku pakai episode dari map (2), bukan extract yang return 1
- **Functional test (perlu restart bot)**: 
  - Download ep2 samehadaku via pixeldrain/gofile → label progress "Episode 2"
  - Ketik `/cari nama` → keyboard muncul tanpa error UTF-8

## Catatan

Terpisah (dicatat di audit terpisah): `extractPartFromFilename` juga dipakai untuk **save part ke library** (Pixeldrain line ~2318, GoFile line ~2011/2138) — ep2 samehadaku saat ini **tidak tersimpan** ke library (skip save part 1). Ini belum di-fix di sesi ini (fokus ke label progress sesuai request user). Tracked di `docs/audit/2026-09-03-bug-part-save-samehadaku.md`.
