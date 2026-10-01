# Audit — Picker episode mengingat halaman asal

**Tanggal:** 2026-09-28
**Tag:** `v3.3.4` (patch — memperbaiki perilaku, tidak ada kontrak yang patah)
**Proposal:** `docs/proposals/2026-09-28-picker-halaman.md`
**Status:** sudah diimplementasikan, **belum di-deploy** (menunggu verifikasi manual)

## 1. Keluhan

> "menu Prev & Next kenapa tidak kembali ke halaman sebelumnya, misal pilih menu lain lalu
> kembali dia balik ke page 1 lagi, padahal sebelumnya ada di page 59 — tekan lagi lemot"

## 2. Root cause (terverifikasi di kode)

Halaman picker tidak pernah dibawa di dalam `callback_data`, kecuali tombol Prev/Next.
Logika pagination sendiri benar — `sam_page:58` → `sam_page:59` jalan normal.

| tombol | callback_data SEBELUM | membawa page? |
|---|---|---|
| Prev | `${prefix}_page:${p-1}:${urlId}` | ya |
| Next | `${prefix}_page:${p+1}:${urlId}` | ya |
| Nomor halaman | `${prefix}_page:${p}:${urlId}` | ya |
| Download Semua | `${prefix}_all:${urlId}` | tidak |
| tombol episode | `sam_ep:${epId}` / `kam_ep:` / `kur_ep:` | tidak |
| Kembali | `kam_page:0:${kmBid}` (hardcode 0), `sam_back:${bid}`, `kur_back:${bid}` | tidak |

Bukti: `scraper/lib/samKeyboard.js:30`, `scraper/bot.js` (`callback_data: kam_page:0:${kmBid}`),
handler `sam_back:` / `kur_back:` (`data.slice(9)`), handler `*_ep:` (`data.slice(7)`).

## 3. Kenapa terasa lambat (terverifikasi)

Setiap render ulang picker mengambil listing **penuh** dari provider:
Samehadaku 1 request ke Worker (respons One Piece **105.685 byte**, 1171 episode);
Kamenime respons Livewire **~271 KB**; Kuronime 1 request. Ditambah query DB
`episodeStatusMap` di setiap render. Tombol "Kembali" juga tidak memakai
`samehadakuEpisodesCache` yang sudah ada — optimasi item terpisah (di luar scope).

## 4. Yang diubah

### `scraper/lib/samKeyboard.js`
- `buildPicker` → `${prefix}_all:${urlId}:${p}` (page disisipkan di akhir)
- `buildPicker` → `mkEp(e, p)` meneruskan halaman ke tombol episode
- Navigasi Prev/Next tidak berubah bentuk

### `scraper/bot.js`
- baru: `splitUrlAndPage(data, prefix)` → `{ urlId, page }`, dan
  `parseBatchPick` kini mengembalikan `page` (urlId tetap bersih, page dipisah)
- 3 `mkEp` menerima `pg` dan menyisipkannya: `kam_ep:${epId}:${pg}`,
  `sam_ep:${epId}:${pg}`, `kur_ep:${epId}:${pg}`
- tombol Kembali: `sam_back:${bid}:0`, `kur_back:${bid}:0`,
  `kam_page:${kmPick.page}:${kmBid}` (meneruskan page dari tombol Download Semua)
- handler `sam_back:` / `kur_back:` membaca `backPage` dan meneruskannya ke picker
- handler `sam_ep:` / `kam_ep:` / `kur_ep:` memakai `splitUrlAndPage` (bukan `slice` fixed)

### Test
- baru: `scraper/tests/test-picker-halaman.js`
- diperbarui agar tidak mengunci format lama:
  `test-picker-prefix.js`, `test-kamenime-provider.js`, `test-vidoy-uploader.js`,
  `test-sam-picker-pagination.js`, `test-preview-judul-resolusi.js`

## 5. Format callback_data

```
${prefix}_all:${urlId}:${page}
${prefix}_allgo:${target}:${urlId}:${page}
${prefix}_fix:${urlId}:${page}
${prefix}_ep:${epId}:${page}
${prefix}_back:${urlId}:${page}
${prefix}_page:${page}:${urlId}     (navigasi, tidak berubah)
```

Format lama **tetap diterima** — keyboard yang sudah terkirim di chat tidak
berubah setelah deploy. Suffix ditambahkan di belakang, bukan memotong, jadi
parser berbasis `startsWith(prefix)` tetap aman (`AGENTS.md` §4).

## 6. Batas 64 byte — RISIKO DIHAPUS (koreksi user, sudah diverifikasi ulang)

Awalnya proposal mengira ini risiko. User mengoreksi: `urlId` bukan hash melainkan
counter integer. Diverifikasi ke `scraper/lib/urlCache.js:30` —
`const id = String(++urlCacheCounter)`. Pengukuran:

| callback_data | byte |
|---|---|
| `sam_allgo:vyt:1:59` | 15 |
| `sam_allgo:vyt:999999:59` | 23 |

Semua 6 format aman. Test mengunci angka ini (`Buffer.byteLength <= 64`) supaya
keputusan ini tidak diam-diam berubah. Fallback "kalau tidak muat" dihapus dari
proposal karena membuat dua format untuk satu tombol.

## 7. Hasil test

```
test-picker-halaman            167 / 0    (baru)
test-picker-prefix              12 / 0
test-media-key-konsisten        15 / 0
test-kamenime-batch             11 / 0
test-kamenime-provider          26 / 0
test-speed-floor-batas          15 / 0
test-folder-vidoy-kunci         12 / 0
test-vidoy-uploader            157 / 0
test-media-contract             10 / 0
test-preview-judul-resolusi     11 / 0
test-sam-picker-pagination    7 lulus
test-sam-prescan              lulus
test-dell-vdell-logging         11 / 0
------------------------------------------------------------------
TOTAL                         458 pass / 9 fail
```

**9 fail itu `test-vidoy-listing`, dan itu PRE-EXISTING** — terbukti dengan
`git stash`: di kode tanpa perubahan ini, test itu sudah `11 pass / 9 fail`.
Tidak terkait dengan fix picker halaman. Sudah dilaporkan, belum dikerjakan
(§1 AGENTS.md: isu di luar scope → laporkan dulu).

## 8. Mutasi — 9 dari 9 tertangkap

```
MUTASI TERTANGKAP : 9 / 9
LOLOS (test buta) : 0
```

Script: `.hermes/cache/scratch/mutasi_picker.sh`

| # | mutasi | hasil |
|---|---|---|
| M1 | `buildPicker` lepas page di `_all:` | TANGKAP |
| M2 | `buildPicker` tidak kirim page ke `mkEp` | TANGKAP |
| M3 | `mkEp` selalu page 0 | TANGKAP |
| M4 | `splitUrlAndPage` selalu page 0 | TANGKAP |
| M5 | `parseBatchPick` membuang page | TANGKAP |
| M6 | tombol Kembali hardcode page 0 | TANGKAP |
| M7 | handler `_back:` mengabaikan page | TANGKAP |
| M8 | `pickPageFromData` jadi dead code | TANGKAP |
| M9 | handler balik ke `slice` fixed | TANGKAP |

### Temuan penting dari mutasi

**Versi pertama test hanya 2 dari 9 tertangkap.** Test itu menyalin definisi
`parseBatchPick` / `splitUrlAndPage` / `mkEp` secara manual, sehingga mutasi di
`bot.js` sama sekali tidak berpengaruh. Test yang terlihat hijau (149 pass)
tidak menguji kode produksi sama sekali.

Perbaikan: parser di-ekstrak dari `bot.js` dengan `new Function`, dan `mkEp`
diperiksa dari source. Setelah itu 8 dari 9 tertangkap.

**Sisa 1 mutasi (M8) uncovering dead code:** `pickPageFromData` ternyata tidak
dipanggil siapa pun — `splitUrlAndPage`_logloss logikanya sendiri. Fungsi
dihapus, dan test baru mengunci bahwa helper halaman tidak boleh jadi dead code.

**Bug nyata yang ditemukan mutasi M7:** `kur_back` mendefinisikan `backPage`
tapi tidak pernah memakainya, dan memanggil `buildKuronimeEpisodePicker(eps,
animeUrl)` tanpa page. Diperbaiki.

## 9. Verifikasi manual (WAJIB — belum dilakukan)

1. Buka picker One Piece, navigasi ke halaman terakhir, tekan **Kembali** →
   harus kembali ke halaman yang sama, bukan 1.
2. Tekan satu tombol episode → **Kembali** lagi → halaman yang sama.
3. Setelah pindah file, buka picker lagi, cek **Kembali** dari halaman mana pun
   (sekaligus regresi fix `folderKey()`).

Bot **belum di-restart** — kode belum aktif di proses yang sedang jalan.

## 10. Di luar scope (dilaporkan, tidak dikerjakan)

- Cache listing untuk `sam_back:` — `urlCache` TTL 30 menit, `SAM_CACHE_MS` 10
  menit; `sam_back:` tidak memakai cache episode → 105 KB per tekan Kembali.
- `createFolderVerified` (`scraper/vidoy-uploader.js`) masih pencocokan tidak
  ternormalisasi di cabang pemulihan orphan. User sudah whitelist, perlu
  approval terpisah karena menyangkut upload.
- `test-vidoy-listing` 9 fail pre-existing.
- Label Naruto 1-398 (`vidoy_uploads` ada, `media_parts` kosong) — backfill
  `media_parts` agar label jadi `✅ library` bukan `📨 Telegram saja`.
