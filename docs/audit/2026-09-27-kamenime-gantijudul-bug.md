# Kamenime: `logCtx is not defined` + Ganti Judul menghilangkan pilihan target

**Tanggal:** 27 Sep 2026
**File:** `scraper/handlers/download.js`, `scraper/bot.js`, `scraper/tests/test-kamenime-provider.js`
**Status:** kode selesai + terverifikasi. Belum di-deploy.

## 1. Bug yang dilaporkan user

```
⚠️ Kamenime gagal: logCtx is not defined
```

lalu: "setelah aku ganti judul kok gak ada opsi upload ke Telegram + Vidoy,
kok langsung ke telegram".

## 2. Bug 1 — `logCtx is not defined` (mematikan SEMUA download kamenime)

**Root cause:** blok faststart yang saya tambahkan 27 Sep menyisipkan

```js
const fixedPath = await remuxToMp4(outPath, (m) => logger.info({ ...logCtx, m }, '...'));
```

tapi `logCtx` **tidak pernah dideklarasikan** di `handleKamenimeUrl` →
`ReferenceError` setiap kali remux jalan.

**Dampak:** file kamenime **selalu** non-faststart (atom `moov` di belakang
`mdat`, terverifikasi), jadi remux **selalu** jalan → **setiap** download
kamenime gagal. Bukan intermiten.

**Kenapa lolos:** saya menguji `isFaststartMp4()` dan `remuxToMp4()` secara
terpisah, tapi **tidak pernah menjalankan blok itu di dalam
`handleKamenimeUrl`**. Persis pola kesalahan yang sudah thrice tercatat di
AGENTS.md §4 — klaim dari baca kode.

**Fix:** deklarasikan `logCtx` di dalam `handleKamenimeUrl`.

**Bukti fungsional** (file asli 121 MB, blok yang persis sama):

```
faststart sebelum: false
remux faststart (kamenime) {chatId:-100, file:"Naruto Shippuden-episode-1.mp4", ...}
faststart sesudah: true
HASIL: tidak ada ReferenceError
```

## 3. Bug 2 — Ganti Judul menghilangkan pilihan target

**Root cause:** jalur "ketik judul" di `bot.js` memanggil handler provider
**langsung**:

```js
if (pending.handler === 'kamenime') return handleKamenimeUrl(chatId, pending.url, customTitle);
```

Tidak ada pilihan target sama sekali — user tidak bisa memilih Vidoy+TG.

Catatan: pola ini memang ada juga di provider lain (filedon/gdrive/gofile) —
saya **tidak** mengubahnya karena di luar scope, tapi untuk kamenime jelas
merusak karena Vidoy+TG memberi caption + link yang tidak bisa dipilih.

**Fix:**
- `customTitleMap` (URL → judul kustom)
- Custom title kamenime → simpan judul, tampilkan `animeTargetKeyboard`
  (Telegram / Vidoy+TG / Vidoy)
- `dl_go` membaca `customTitleMap` dan memakai `titleForCap =
  customTitle || detectedTitle` — judul kustom diprioritaskan, lalu dihapus
  dari map supaya tidak bocor ke request berikutnya

## 4. Verifikasi

`test-kamenime-provider.js` **22 pass / 0 fail** (dari 20 → 22).

| kasus | yang dibuktikan |
|---|---|
| t) | `logCtx` dideklarasikan di `handleKamenimeUrl` (anti `ReferenceError`) |
| u) | custom title **tidak** langsung unduh; menampilkan 3 target; `customTitleMap` dipakai `dl_go`; `titleForCap` meneruskan |

Test (i) diperbarui: `dl_go` tg kini meneruskan `titleForCap`
(bukan `detectedTitle`) — itu memang bentuk yang benar setelah fix bug 2.

Bukti mutasi:

| mutasi | hasil |
|---|---|
| hapus deklarasi `logCtx` (bug yang user alami) | 21 pass / **1 fail** (t) |
| sisipkan panggilan langsung di custom title | 21 pass / **1 fail** (u) |
| `dl_go` abaikan judul kustom | 21 pass / **1 fail** (u) |

Suite penuh: **241 pass / 0 fail**.

## 5. Catatan

Bug 1 adalah bukti ketiga dalam satu hari bahwa Claim based on reading code is
not a result. Blok faststart saya tulis, `node --check` lulus, test `isFaststartMp4`
dan `remuxToMp4` lulus — tapi tak ada satu pun yang menjalankan **blok itu di
dalam alur unduh sebenarnya**. `node --check` tidak menangkap `ReferenceError`
untuk identifier yang belum dideklarasikan di jalur yang rarely dieksekusi.
