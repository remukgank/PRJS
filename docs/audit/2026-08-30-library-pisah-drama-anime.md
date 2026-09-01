# Fitur: Pemisahan Drama vs Anime di Library

**Date**: 2026-08-30
**Author**: opencode

## Root Cause / Motivasi

Daftar library (`📚 Katalog`, `📋 Semua Library`, hasil `/cari`) menampilkan drama dan anime
campur jadi satu daftar datar. Padahal perbedaan jenismya SUDAH ada di prefix `media.slug`:

- `anime:<judul>` → anime (semua save dari gofile/pixeldrain, ditulis di `bot.js`),
- `<subdomain>:<id>` / `reelfren_<provider>:<id>` → drama (dramafren/reelfren).

Jadi TIDAK perlu migrasi skema DB — cukup dipakai untuk filter & label.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` | helper baru `buildLibraryKeyboard(kat, page, all)` — filter `all`/`drama`/`anime`, pagination per-filter, row filter `🎬 Drama \| 👍 Semua \| 🎌 Anime` (aktif diberi ✅), header count `Drama: X · Anime: Y`, badge `🎬`/`🎌` per baris |
| `scraper/bot.js` | handler `act:lib_list` — support callback baru `act:lib_list_c:<kat>:<page>`; `act:lib_list_p:<page>` & `act:lib_list` tetap jalan (alias `all`) |
| `scraper/bot.js` | reply-keyboard `📚 Katalog` — pakai `buildLibraryKeyboard` (hapus duplikat render) |
| `scraper/bot.js` | `/cari` & `librarySearchResultKeyboard` — tiap baris ditandai `🎬 Drama` / `🎌 Anime` |
| `scraper/bot.js` | `lib_menu:` (header detail) — tambah `— 🎌 Anime` / `— 🎬 Drama` di samping judul |
| `scraper/bot.js` | `mainMenuKeyboard` — ikuti pola fomo-drama: tombol `📋 Semua Library` diganti baris **2 menu** `🎬 Drama` (`act:lib_list_c:drama:1`) \| `🎌 Anime` (`act:lib_list_c:anime:1`); `📚 Cari Drama/Anime` tetap |
| `scraper/bot.js` | `buildLibraryKeyboard` header per kategori (mirip `KATALOG ANIME`/`KATALOG DRAMA` fomo-drama): `all` → `📚 Daftar Library — 🎬 Drama: X · 🎌 Anime: Y`; `drama` → `🎬 Daftar Drama — X judul (🎌 Anime: Y)`; `anime` → `🎌 Daftar Anime — X judul (🎬 Drama: Y)` |

## Referensi Pola 2-Menu (fomo-drama)

- `git pull origin main` fomo-drama sukses (branch main, clean). Pola: deretan pertama main menu inline & reply-bar =
  `🎬 Anime` + `🎭 Drama`, masing-masing buka katalog filter kategori (`handlers/contentHandler.js` `handleListCommand`,
  callback `list_kat_anime`/`list_kat_drama` di `utils/menuBuilder.js:20-23` & `contentHandler.js:2343-2353`);
  di dalam katalog ada tombol switch kategori & header `KATALOG ANIME`/`KATALOG DRAMA` (`contentHandler.js:2191-2195`).
  fomo-drama simpan `kategori` di kolom DB; PRJS setara via prefix slug `anime:` (tanpa migrasi).
- Catatan: `replyMainKeyboard` di PRJS tidak pernah dipanggil (dead), jadi 2-menu diterapkan di inline `mainMenuKeyboard`.

## Detail Teknis

- Filter berbasis `slug.startsWith('anime:')`; `kat='all'` → semua, `'drama'` → bukan `anime:`,
  `'anime'` → `anime:`.
- `perPage = 20`, sama dengan sebelumnya. Nav membawa filter: `act:lib_list_c:drama:2` dst.
- `buildLibraryKeyboard` menerima argumen `all` (hasil `listAllLibrary`) supaya handler &
  Katalog tidak query 2x.
- Row filter selalu di baris paling atas; nav (`Prev | 1/N | Next`) di bawah konten.
- Kategori kosong → tombol `📭 Tidak ada anime/drama` (noop), header tetap menampilkan count.

## Verification

- `node --check scraper/bot.js` lulus.
- Functional test `buildLibraryKeyboard` (stub 23 drama + 7 anime, eval snippet dari file asli):
  - `all` page1 = 20 item + filter + nav; filter `Semua` aktif (✅); header `Drama: 23 · Anime: 7`.
  - `drama` page1 → hanya baris `🎬`; `anime` page1 → hanya baris `🎌` + satuan `episode`.
  - nav pagination membawa filter (`act:lib_list_c:drama:1`, dst); empty kategori → row `noop`.
  - Semua assert lulus: `LIB FILTER OK`.
- Skenario tes di server (setelah restart bot): buka menu utama → ada baris `🎬 Drama` / `🎌 Anime`
  (2 menu, pola fomo-drama); klik masing-masing → masuk daftar tersaring dengan header
  `🎬 Daftar Drama`/`🎌 Daftar Anime` + row filter (bisa kembali ke `👍 Semua`);
  `/cari sesuatu` → tiap hasil berlabel `🎬 Drama` / `🎌 Anime`; buka detail `lib_menu:` →
  judul tampil dengan badge kategori.