# Label progress film: "— Movie" (bukan "— Episode 1")

**Date**: 2026-09-24
**Author**: opencode
**Proposal**: disetujui user
**Tahap**: lanjutan dukungan halaman film (v2.2.3)

## Root Cause

Setelah dukungan film masuk, RichProgress pada jalur unduh film menampilkan label
baris:

```
📤 upload | Assassination Classroom the Movie: Our Time Sub Indo — Episode 1 — 869.5 MB
```

Number "Episode 1" salah: film tidak punya nomor episode. Sumbernya di
`scraper/handlers/download.js`, 5 titik yang menempelkan sufiks episode ke label:

```js
capWithEp = customTitle ? `${cap} — Episode ${part}` : cap;
```

Untuk film, `sameInfo` = `{ movie: true, episode: null }` (dari fix v2.2.3), sehingga
`sami.episode` null → fallback `extractPartFromFilename(namaFile)` → `1`. Karena
label dibuat **satu kali** lalu dipakai ulang di tahap `download`, `upload`, dan
`fail`, satu titik constructor sudah menutup semua tahap. Caption video sendiri
sudah benar (`➧ Tipe :- Movie`).

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/handlers/download.js` | Helper baru `epCapLabel(cap, hasTitle, sameInfo, part)`: `movie:true` → `${cap} — Movie`, selain itu `${cap} — Episode ${part}`, tanpa `customTitle` → label polos. Dipakai di 5 titik: gofile direct (81), gofile folder (201), pixeldrain (462), filedon (632), mega (707). Filedon & mega kini membaca `_ctx.samehadakuEpisodeMap.get(url)` (`fdSami`/`mfSami`) supaya flag movie terdeteksi juga di server itu |
| `scraper/tests/test-samehadaku-movie-link.js` | +1 test (13 → 14): helper asli dimuat dari file (anti-drift) — film → "— Movie" tanpa kata "Episode"; anime → "— Episode 1125" (tanpa regresi); tanpa `customTitle` → polos; jumlah pemakaian helper = 5 |

## Detail Teknis

- Hanya label yang berubah; **tidak** menyentuh caption video, parsing samehadaku,
  atau numbering episode anime.
- `partMismatch(expectedEp, gotPart)` sudah aman untuk film (`want > 0` false →
  `null`), jadi validasi "file server keliru" tidak salah触发 untuk film.
- Mega tidak punya `expectedEp`, tetap aman.
- Tidak ada perubahan API/Telegram.

## Verification

- `node --check scraper/handlers/download.js` **CLEAN**.
- `test-samehadaku-movie-link.js`: **14 pass, 0 fail**.
- Regresi 16 suite hijau (html-safety 22, caption-escape 6, movie 14, parse-ep1 14,
  ep1-slug 22, slugtail 28, picker 7, libmenu 14, livechat 4, filename 9,
  anime-router 18, gdriveplayer 3, prescan, batch, kuronime, extract-provider).
- Skenario functional setelah restart: kirim link film samehadaku → pilih server →
  RichProgress menampilkan `… — Movie` pada tahap download & upload (mis.
  `📤 upload | Assassination Classroom the Movie: Our Time Sub Indo — Movie — 869.5 MB`),
  lalu video terkirim dengan caption `➧ Tipe :- Movie`.

## Deploy

- `handlers/download.js` berubah → **restart bot** (bersama perubahan `safeHtml`
  yang juga menunggu restart).
- Commit terpisah dari `safeHtml` sesuai aturan user; 1 tag `v2.3.0` (minor,
  berisi dua perbaikan) — atau 2 tag bila lebih suka; menunggu keputusan.
