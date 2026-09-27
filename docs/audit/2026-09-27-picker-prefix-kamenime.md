# Fix Prefix Callback Picker Kamenime (Tombol "Download Semua" Menjalankan Samehadaku)

**Date**: 2026-09-27
**Author**: Hermes (trace + implementasi), review user

## Gejala

User mengetuk **"⬇️ Download Semua"** di picker episode Kamenime, dan mendapat:

```
ERROR  Unhandled error in callback handler  !  [object Object]
err  : no FULLHD/4K servers found
        at scraper/providers/samehadaku.js:23:23
```

**Gejala ini menipu**: user mengira episode-nya bermasalah, padahal tidak ada
episode yang diproses. Tombol tersebut tidak menjalankan unduhan sama sekali.

## Akar Masalah

`lib/samKeyboard.js` — `buildPicker()` punya parameter `prefix` dengan default
`'sam'`, yang dipakai untuk membuat `callback_data` tombol **Download Semua** dan
navigasi **Prev/Next**:

```js
keyboard.push([BTN.btn(`⬇️ Download Semua (${missing})`, `${prefix}_all:${urlId}`, 'primary')]);
nav.push({ text: `📄 ${p+1}/${totalPages}`, callback_data: `${prefix}_page:${p}:${urlId}` });
```

Tiga pemanggil di `bot.js`:

| Picker | Baris | prefix | Tombol batch |
|---|---|---|---|
| Samehadaku | 2046 | *(default)* → `sam` | `sam_all:` ✅ memang mau |
| Kuronime | 2104 | `prefix: 'kur'` | `kur_all:` ✅ |
| **Kamenime** | 1992 | *(tidak ada)* → **`sam`** | **`sam_all:` ❌** |

Picker Kamenime tidak mengirim `prefix`, jadi diam-diam memakai default `sam`.
Selectors `sam_all:` / `sam_page:` Recognized sebagai perintah **Samehadaku**, dan
parser Samehadaku dipanggil dengan URL anime Kamenime → `no FULLHD/4K servers found`.

**Kenapa tidak ketahuan saat tes**: tombol per-episode (`kam_ep:`) memang benar,
dan `mkEp` di picker kamenime memakai `kam_ep:` secara eksplisit. Hanya tombol
batch + navigasi yang salah, jadi test manual per-episode selalu hijau.

**Kena magnified 500 episode** — pesan error menyebut seluruh daftar, sehingga
terbaca seolah semua episode rusak.

## Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` | `prefix: 'kam'` di picker kamenime (baris 1992) |
| `scraper/bot.js` | Handler `kam_page:` baru (baris ~3558) — navigasi Prev/Next |
| `scraper/bot.js` | `kamenimeEpisodesCache` — cache listing, dipakai `kam_page:` |
| `scraper/bot.js` | `sam_all:` Guard: tolak URL non-Samehadaku dengan pesan jelas |
| `scraper/tests/test-picker-prefix.js` | BARU — 10 test |

### `prefix: 'kam'`

Akar masalah. Mirip kuronime (`prefix: 'kur'`).

### Handler `kam_page:`

Tanpa ini, `kam_page:` tidak ada handler dan callback jatuh ke cabang Samehadaku
lagi. Ditiru persis dari `kur_page:` (bot.js:4303) — parse `page` dari `parts[1]`,
URL dari `parts.slice(2).join(':')` (bukan `slice(angka)` — lihat `AGENTS.md §4`).

### `kamenimeEpisodesCache`

`kuronimeEpisodesCache` sudah ada; Kamenime tidak punya. Tanpa cache, tiap tap
Prev/Next memanggil `listKamenimeEpisodes()` lagi, yang mem-fetch respons Livewire
**~271 KB** (grid 500 episode) tiap kali. Sekarang di-cache `SAM_CACHE_MS` (10 menit),
sama seperti kuronime.

### Guard `sam_all:`

Pertahanan lapis kedua. Kalau karena alasan apa pun callback `sam_all:` membawa URL
non-Samehadaku, bot menolak dengan pesan yang menyebut provider sebenarnya,
bukan melempar error mentah yang tampil sebagai `Unhandled error`.

> Catatan: tombol `⬇️ Download Semua` di picker Kamenime **belum punya handler
> `kam_all:`** — sengaja. Menjalankan 500 episode sekaligus adalah operasi
> besar; itu keputusan terpisah, bukan perbaikan diam-diam.rael untuk
> sekarang: tombol tersebut akan menerima callback yang tidak dikenali, dan
> `sam_all:` guard mencegah salah-parsing.

## Verification

**Bukti run** (`buildPicker` dengan 500 episode, prefix `kam`):

```
tombol utama : ⬇️ Download Semua (500) → kam_all:u      (sebelumnya: sam_all:u)
navigasi     : kam_page:0:u  kam_page:1:u              (sebelumnya: sam_page:*)
totalPages   : 25
tombol/halaman: 1 batch + 20 ep + 1 nav = 22 < 100 (limit Telegram)
```

**Test**: `test-picker-prefix.js` 10 pass / 0 fail

Setiap picker diverifikasi punya prefix yang benar, setiap prefix punya handler,
dan handler `kam_page:` terbukti memakai `listKamenimeEpisodes` +
`buildKamenimeEpisodePicker` (bukan parser Samehadaku).

**Mutasi wajib** (semua tertangkap):

| Mutasi | Hasil |
|--------|-------|
| Hapus `prefix: 'kam'` | 8 pass / 2 fail |
| `prefix: 'sam'` | 8 pass / 2 fail |
| Hapus handler `kam_page:` | 7 pass / 3 fail |
| Hapus guard domain Samehadaku | 9 pass / 1 fail |
| Hapus `kamenimeEpisodesCache` | 9 pass / 1 fail |
| (dikembalikan) | 10 pass / 0 fail |

**Suite**: picker-prefix 10 · kamenime-provider 26 · preview-judul 11 ·
media-contract 10 — semua 0 fail.

Test `test-preview-judul-resolusi.js` ikut diperbaiki: ia meng-hardcode nomor
baris (3249-3268) yang bergeser karena perubahan ini. Sekarang mencari lewat
pola (`lineOf(/const km = await resolveKamenimeFile/)`).

**Deploy**: `pm2 restart prjs-bot` → PID 24567, `Bot running` 11:31:43.
