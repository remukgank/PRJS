# Lengkapi branch movie di semua caption samehadaku (fix "Episode :- null")

**Date**: 2026-09-24
**Author**: opencode
**Proposal**: disetujui user
**Bug report user**: video film terkirim dengan caption `➧ Episode :- null`

## Root Cause

Fix film di `v2.2.3` menambahkan cabang `sami.movie` **hanya pada caption gofile
direct** (`handlers/download.js:114-136`). Empat blok caption lain masih jatuh ke
cabang `else` yang menulis `➧ Episode :- ${sami.episode}`; untuk film
`episode: null` → **"Episode :- null"**.

Percobaan user memakai link **gofile folder**, yang_caption-nya berada di blok
yang belum disentuh — sehingga judul film benar (dari fix worker) tetapi baris
episode salah.

Blok caption samehadaku yang ada (hasil audit `grep '➧ Provider :- samehadaku'`):

| Blok | Handler | Sebelum | Sesudah |
|---|---|---|---|
| 114-136 | gofile direct | ✅ sudah ada (v2.2.3) | ✅ |
| 234-248 | gofile **folder** | ❌ `Episode :- null` | ✅ branch Movie |
| 511-526 | pixeldrain | ❌ `Episode :- null` | ✅ branch Movie |
| 820-828 | gdrive (`gdSame`) | ❌ | ✅ (`gdSami?.movie`) |
| 845-855 | gdrive generic (`gdProv`) | ❌ | ✅ (`gdSami?.movie`) |
| 902-912 | gdriveplayer (`gpSame`) | ❌ | ✅ (`sameInfo?.movie`) |

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/handlers/download.js` | Branch `movie` ( Judul + `➧ Tipe :- Movie` + `➧ Provider :- samehadaku`) ditambahkan di gofile-folder & pixeldrain (pakai `sami.movie` yang sudah di scope); `handleGdriveUrl` kini membaca `gdSami = _ctx.samehadakuEpisodeMap.get(url)` lalu memakai `gdSami?.movie` untuk 2 blok caption-nya dan untuk label `seasonEpLabel` (label film jadi `Movie`, bukan `Episode N`); gdriveplayer memakai `sameInfo?.movie` |
| `scraper/tests/test-samehadaku-movie-link.js` | +1 test (14 → 15) dengan guard terukur: 6 blok caption punya `Tipe :- Movie`; `sami.movie` = 3; `sameInfo?.movie` = 1; `gdSami?.movie` = 3; tak ada caption `Episode :- null`. Guard ini mencegah blok caption baruadded tanpa cabang movie terlewat lagi |

## Detail Teknis

- Sumber flag film tetap satu: `samehadakuEpisodeMap` diisi `sam_go` (v2.2.3) dengan
  `{ movie: true, episode: null, … }`; handler gdrive/gdriveplayer/filedon/mega
  membaca map yang sama — konsisten dengan fix label progress.
- Blok gdrive generic (yang comentarnya menyebut "Movie, tanpa -S/-P") justru jalur
  yang dipakai file film via gdrive → sebelumnya ditulis `Episode :- ${extractPartFromFilename(fileName)}`
  yang bisa `null`; kini pakai `Tipe :- Movie`.
- Tidak ada perubahan API/Telegram, tidak ada perubahan perilaku episode anime
  (branch `season`/`episode` tetap jalan).
- Kesalahan cakupan ini dicatat sebagai pelajaran: audit awal hanya glimps caption
  pertama per handler; test guard jumlah-situs sekarang menutup kelas bug ini.

## Verification

- `node --check scraper/handlers/download.js` & test **CLEAN**.
- `test-samehadaku-movie-link.js`: **15 pass, 0 fail**.
- Regresi 16 suite hijau: html-safety 22, caption-escape 6, movie 15, parse-ep1 14,
  ep1-slug 22, slugtail 28, picker 7, libmenu 14, livechat 4, filename 9,
  anime-router 18, gdriveplayer 3, prescan, batch, kuronime, extract-provider.
- Skenario functional setelah restart: unduh film via **gofile folder** (dan
  pixeldrain/gdrive/gdriveplayer) → caption
  `➧ Judul :- …` / `➧ Tipe :- Movie` / `➧ Provider :- samehadaku`; tidak ada lagi
  `Episode :- null`. Label progress & `seasonEpLabel` juga `Movie`.

## Deploy

- `handlers/download.js` berubah → **restart bot** (bersama `safeHtml` & label progress).
- Commit **terpisah** dari `safeHtml` (v2.3.0) & label progress (v2.2.5).
