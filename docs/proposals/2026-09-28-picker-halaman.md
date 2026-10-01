# Proposal — Picker episode mengingat halaman asal

**Tanggal:** 2026-09-28
**Status:** menunggu approve
**Keluhan user:** "menu Prev & Next kenapa tidak kembali ke halaman sebelumnya, misal pilih menu lain
lalu kembali dia balik ke page 1 lagi, padahal sebelumnya ada di page 59 — tekan lagi lemot"

## 1. Root cause (terverifikasi di kode)

Halaman picker **tidak pernah disimpan di dalam `callback_data`**, kecuali tombol Prev/Next.
Logika pagination-nya sendiri benar — `sam_page:58` → `sam_page:59` jalan normal.
Yang hilang adalah state halaman saat keluar dari picker lewat tombol lain.

`scraper/lib/samKeyboard.js` (dipakai 3 provider lewat parameter `prefix`):

| tombol | callback_data sekarang | membawa page? |
|---|---|---|
| Prev | `${prefix}_page:${p - 1}:${urlId}` | ya |
| Next | `${prefix}_page:${p + 1}:${urlId}` | ya |
| Nomor halaman | `${prefix}_page:${p}:${urlId}` | ya |
| Download Semua | `${prefix}_all:${urlId}` | **tidak** |
| tombol episode | `mkEp(e)` ditentukan di bot.js | **tidak** |
| Kembali | `sam_back:${bid}` / `kur_back:${bid}` / `kam_page:0:${kmBid}` | **tidak** |

Bukti langsung dari kode:

- `scraper/lib/samKeyboard.js:30` — `${prefix}_all:${urlId}` tanpa page
- `scraper/bot.js` — `callback_data: kam_page:0:${kmBid}` (**hardcode 0**)
- handler `sam_back:` / `kur_back:` — `const rawUrl = data.slice(9)`, tidak ada page sama sekali
- handler `sam_ep:` / `kam_ep:` / `kur_ep:` — `data.slice(7)`, tidak ada page

## 2. Kenapa terasa lambat (terverifikasi)

Setiap render ulang picker mengambil listing **penuh** dari provider:

- Samehadaku: 1 request ke Worker, respons One Piece **105.685 byte** (1171 episode)
- Kamenime: respons Livewire **~271 KB** (dicatat di komentar kode)
- Kuronime: 1 request
- Ditambah `episodeStatusMap` yang query DB tiap render

Jadi "Kembali" dari halaman 59 = 1 request provider + query DB, lalu user harus menekan
Next 58 kali untuk balik. Steelman kalalah yang user laporkan.

## 3. Rencana (opsi B — semua tombol ingat halaman)

Tambah **suffix** page pada callback_data. Menambah suffix, **bukan memotong**, jadi
parser yang berbasis `startsWith(prefix)` tetap aman (aturan `AGENTS.md` §4 soal
`slice(<angka>)`).

Format baru (page 0-based, boleh tidak ada → default 0):

```
${prefix}_all:${urlId}:${page}
${prefix}_allgo:${target}:${urlId}:${page}
${prefix}_fix:${urlId}:${page}
${prefix}_ep:${epId}:${page}
sam_back:${urlId}:${page}
kur_back:${urlId}:${page}
kam_page:0:${kmBid}  →  kam_page:${page}:${kmBid}
```

### Backward compatibility (wajib)

Format lama **harus tetap jalan**, karena keyboard lama masih ada di chat
(pesan yang sudah dikirim sebelum deploy tidak berubah).

- `sam_back:${urlId}` tanpa suffix → page 0
- `sam_ep:${epId}` tanpa suffix → epId dibaca penuh, page default 0
- `parseBatchPick` sudah memecah di `indexOf(':')` pertama, jadi `urlId:page` aman
  selama page ditambahkan **di belakang**

### Cara baca page (fungsi tunggal, bukan inline di tiap handler)

```js
// page opsional di akhir callback_data; default 0
function pickPageFromData(data) {
  const i = String(data).lastIndexOf(':');
  if (i < 0) return 0;
  const n = Number(String(data).slice(i + 1));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
```

`lastIndexOf` dipilih karena `urlId` bisa mengandung `:` (hasil `cacheUrl`),
sedangkan page selalu angka di posisi terakhir.

## 4. Scope file

| file | perubahan |
|---|---|
| `scraper/lib/samKeyboard.js` | `buildPicker` menerima `mkEp(ep, page)`; `${prefix}_all:${urlId}:${p}`; nav tetap |
| `scraper/bot.js` | tombol Kembali 3 provider membawa page; `mkEp` meneruskan page; 3 handler `*_back:` membaca page; tombol `*_all:`/`*_fix:`/`*_allgo:` membawa page; helper `pickPageFromData` |
| `scraper/tests/test-picker-halaman.js` | baru — regression test |

Tidak diubah: `db.js`, provider, `services/`, kontrak media §5, format tombol episode
yang sudah jadi (hanya ditambah suffix angka).

## 5. Risiko

- **`callback_data` memanjang.** Batas Telegram 64 byte. `urlId` = `cacheUrl(url)`.
  Perlu diukur dulu: untuk `sam_allgo:vyt:<urlId>:<page>`.
  Kalaufest, page tidak ditambahkan ke `*_allgo:` (tombol ini sudah tidak butuh
  kembali ke picker) — cukup di `*_all:`, `*_back:`, `*_fix:`, `*_ep:`.
- **Keyboard lama.** `msgId` yang sudah ada tidak berubah; handler harus menerima
  format lama.
- **Efek samping yang diinginkan:** `sam_all:` / `sam_fix:` sekarang juga membuka
  kembali ke halaman asal, bukan halaman 0.

## 6. Rencana verifikasi

1. `node --check` untuk `samKeyboard.js`, `bot.js`, dan test.
2. Test baru `test-picker-halaman.js`:
   - page tersimpan di `_all:`, `_back:`, `_ep:`
   - format lama tanpa page → page 0 (backward compatible)
   - `urlId` berisi `:` tidak merusak pembacaan page
   - handler `sam_back:` dengan 1 argumen dan 2 argumen sama-sama jalan
3. Regresi test picker yang sudah ada: `test-picker-prefix.js`,
   `test-sam-picker-pagination.js`, `test-media-contract.js`.
4. **Batas 64 byte diuji sungguhan** (bukan diasumsikan): `assert` bahwa
   `Buffer.byteLength(callback_data) <= 64` untuk keenam format, dengan `urlId`
   realistis termasuk counter panjang (6 digit). Ini mengunci keputusan "suffix aman".
5. **Kompatibilitas dua arah**, bukan satu arah:
   - format lama tanpa page -> page 0 (keyboard lama masih hidup)
   - keyboard **baru** diklik, lalu tombol Kembali dari sana membawa page yang benar.
     Tanpa uji arah kedua, bug "Kembali selalu ke page 1" bisa lolos.
6. **Manual (wajib, tidak bisa dipalsukan):**
   - buka picker One Piece, navigasi ke halaman terakhir, tekan **Kembali** → harus
     kembali ke halaman yang sama, bukan 1
   - tekan satu tombol episode → **Kembali** lagi → halaman yang sama
   - setelah pindah file, buka picker lagi dan cek **Kembali** dari halaman mana pun.
     Ini sekaligus regresi untuk fix `folderKey()` (28 Sep) — dua-duanya terverifikasi
     sekali jalan.
5. LOG di `docs/audit/2026-09-28-picker-halaman.md`.
6. Deploy → verifikasi manual di atas → baru commit + tag. Tag: **patch** (perbaikan
   perilaku, tidak ada kontrak yang patah — format lama tetap diterima).

## 7. Di luar scope (dilaporkan, tidak dikerjakan)

- Cache listing antar-render (perf item sendiri, disetujui user sebagai terpisah).
  Fakta tambahan dari user: `urlCache` TTL **30 menit** (`urlCache.js:11,27`) sedangkan
  `samehadakuEpisodesCache` TTL **10 menit** (`SAM_CACHE_MS`). `sam_back:` tidak memakai
  cache episode → 105 KB per tekan Kembali. Butuh trace terpisah sebelum diputuskan.
- `createFolderVerified` di `scraper/vidoy-uploader.js` masih pencocokan tidak
  ternormalisasi di cabang pemulihan orphan.
