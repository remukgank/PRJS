# 2026-09-27 — Log query & hasil untuk `!dell` & `!vdell`

## Masalah

Kedua perintah admin tidak punya jejak query di log:

- **`!dell` gagal tanpa penjelasan.** Respons `❌ Tidak ditemukan: "<b>…</b>"`
  muncul, tapi tidak ada satu pun baris log yang mencatat **apa yang dicari**,
  **episode berapa**, dan **slug apa saja yang ditemukan**. Dari log saja mustahil
  memastikan apakah masalahnya ejaan, slug, atau memang tidak ada.
- **`!vdell` "berhasil" tanpa bukti.** Pesan ke user melaporkan
  `📁 File terhapus: N/M` dan `🗃️ Record DB dihapus: N`, tapi log tidak mencatat
  record DB mana yang dihapus. "Berhasil" ≠ "tercatat": kalau `deleteVidoyRecord`
  diam-diam mengembalikan 0, user tetap melihat pesan sukses.

Kedua blok sama sekali **nol** `logger.*` — diverifikasi langsung pada
`scraper/bot.js` (blok `!dell` 2835–2866, `!vdell` 2873–2910).

## Scope

Satu file behaviour: `scraper/bot.js`. **Read-only** — tidak ada perubahan
perilaku, hanya penambahan `logger.info`. Timeout, pesan user, dan urutan
operasi tidak disentuh.

## Perubahan

Lima titik log, sesuai proposal:

| # | Lokasi | Yang dicatat |
|---|---|---|
| 1 | `!dell`, sebelum early return "Tidak ditemukan" | `{ q, part, hasil, slugs }` |
| 2 | `dell_confirm`, sebelum `deleteMedia` | `{ slug, part, name, semuaPart }` |
| 3 | `!vdell`, sebelum cek `!rows.length` | `{ q, ep, rows, keys }` |
| 4 | `vdel_confirm`, di dalam `if (okDel)` sebelum delete | `{ media_key, kind, part, link, tg_chat_id, tg_message_id }` |
| 5 | `vdel_confirm`, **setelah** loop | `{ terhapus, sisa, dari, fileTerhapus, gagal }` |

### Penyimpangan dari proposal: tidak ada kolom `id`

Proposal meminta `id` di item 4. **Tabel `vidoy_uploads` tidak punya kolom
`id`** — primary key-nya `(media_key, kind, part)`:

```
scraper/db.js:85  CREATE TABLE IF NOT EXISTS vidoy_uploads (
                   media_key TEXT NOT NULL, kind TEXT NOT NULL, part INTEGER …
                   PRIMARY KEY (media_key, kind, part)
                 )
```

Menambahkannya berarti mengubah `scraper/db.js` (SELECT di
`findVidoyRecords`), yang di luar scope. Diganti `tg_chat_id` +
`tg_message_id` — satu-satunya identitas lain yang tersedia, dan justru lebih
berguna untuk trace: bisa dicari balik ke pesan Telegram yang menunjuk file
Vidoy tersebut.

### Item 5: kenapa `sisa` penting

`terhapus` hanya menghitung `rowCount` yang dikembalikan `DELETE`. Ia tidak
membuktikan record benar-benar tidak ada lagi. `sisa` obtained dari **query ulang
setelah delete** dengan `findVidoyRecords(pend.titleQ, pend.ep)`:

- `sisa = 0` → record hilang, pesan "berhasil" memang benar.
- `sisa > 0` → ada record yang menunjuk file yang sudah tidak ada (atau
  kebalikan: file ada, record sudah hilang). Kondisi ini **tidak terlihat
  sebelumnya** dan sekarang punya angka.

## Test: `scraper/tests/test-dell-vdell-logging.js` (baru, 11 pass)

Test ini **tidak menyalin logika**. Ia meng-ekstrak blok kode nyata dari
`bot.js` lalu menjalankannya dengan stub `logger`/`bot`/DB. Menyalin logika ke
test hanya membuktikan salinannya benar — jebakan yang sudah menipu di
`c7572ff`.

Ada test penjaga bahwa blok yang diuji benar-benar berasal dari `bot.js`
(bukan salinan), sehingga test ini gagal kalau `bot.js` berubah.

Kasus yang diuji, untuk **sukses dan gagal**:

- `!dell query` — 0 hasil, 1 hasil, dan `part` berupa angka (bukan `null`).
  Plus: pesan user tetap `Tidak ditemukan` (perilaku tidak berubah).
- `!dell hapus library` — urutan dibuktikan lewat stub yang mencatat urutan:
  `libPtrs → vidPtrs → delMsg → clear → log:!dell hapus library → deleteMedia`.
- `!vdell query` — 0 row dan 2 row (`keys` = array `media_key`).
- `!vdell hapus record` — record tercatat, dan **tidak** tercatat kalau file
  fisik gagal dihapus (`deleteItem` → `{ok:false}`).
- `!vdell selesai` — `sisa:0` (benar hilang) dan `sisa:1` dengan
  `fileTerhapus:1, terhapus:0` (kondisi bermasalah jadi terlihat).

### Mutasi (test dibuktikan menangkap)

| Yang dicabut | Hasil |
|---|---|
| `'!dell query'` | 7 pass / **4 fail** |
| `'!vdell query'` | 8 pass / **3 fail** |
| `'!dell hapus library'` | 10 pass / **1 fail** |
| `'!vdell hapus record'` | 8 pass / **3 fail** |
| `'!vdell selesai'` | extract gagal → **exit 1** |

### Dua cacat pada test yang sempat muncul

1. **Harness `t()` sinkron.** Versi pertama menjalankan `fn()` dalam
   `try/catch`; test yang balik `Promise` selalu "PASS" walau assertion di
   dalam `.then()`-nya gagal — 7 kegagalan tidak pernah terlihat. Diperbaiki
   jadi antrean + `await`.
2. **`VidoyUploader` tidak ikut terekstrak.** Blok `vdel_confirm` dimulai dari
   `const rows = …`, sedangkan `VidoyUploader` berasal dari baris
   `require('./vidoy-uploader')` **di atasnya**. Akibatnya `ReferenceError`
   tertangkap `catch` di dalam loop → `okDel` selalu `false` → titik log 4 dan
   5 tidak pernah tercapai, dan test terlihat hijau. Baris `require` sekarang
   jadi penanda awal.

## Test existing yang perlu dilonggarkan

`tests/test-vidoy-uploader.js` gagal setelah perubahan ini — **bukan** karena
perilaku berubah, tapi karena ia mengunci **teks sumber persis**:

```js
/if \(okDel\) delDb \+= await deleteVidoyRecord/     // ← gagal begitu satu baris log ditambahkan
```

 persis jebakan "test yang mengunci asumsi salah lebih berbahaya dari tidak ada
test". Assertion dilonggarkan jadi
`/if \(okDel\)[\s\S]{0,400}?delDb \+= await deleteVidoyRecord/` — tetap
menuntut guard `if (okDel)` ada, tapi tidak lagi menuntut format.

Diverifikasi dua arah:

- kondisi sekarang → **157 PASS, 0 FAIL**;
- mutasi `if (okDel)` → `if (true)` (guard dilepas) → **FAIL**.

Jaminan perilaku dipindah ke test baru: `deleteItem` gagal → `terhapus=0`
dan `!vdell hapus record` tidak terpanggil.

## Suite

```
TOTAL 371 pass / 0 fail   (semua file exit 0)
test-dell-vdell-logging      11 pass / 0 fail
test-kamenime-provider       26 pass / 0 fail
test-vidoy-uploader         157 pass / 0 fail
```

Dicualikan (sudah tidak related, butuh network/aria2c):
`test-rich.js`, `test-rich-direct.js`, `test-all-subdomains.js`,
`test-watchdog-aria2c.js`.

## Temuan di luar scope (dilaporkan, belum diperbaiki)

`tests/test-vidoy-uploader.js:479` mencetak `RESULT: 46 pass, 0 fail` **di
tengah file** — sebelum ~80 test berikutnya jalan. Ringkasan itu selalu terlihat
hijau padahal ada `FAIL` sesudahnya. Anyone yang menghitung dari baris itu
akan salah. Tidak saya sentuh karena di luar scope; cukup dipindah ke akhir file.

## Catatan konsistensi logger

`scraper/logger.js` (terminal) hanya menampilkan field tertentu lewat
whitelist `terminalKeys`. Field baru ini (`q`, `hasil`, `slugs`, `rows`,
`keys`, `media_key`, `slug`, `part`, `name`, `link`, `terhapus`, `sisa`) belum
masuk whitelist, jadi di `pm2 logs` yang tampil hanya `msg` + `chatId`.
JSON lengkap tetap ada di `logs/app.log`. Butuh tambahan whitelist bila
ingin terlihat penuh di terminal — belum dikerjakan (di luar scope).
