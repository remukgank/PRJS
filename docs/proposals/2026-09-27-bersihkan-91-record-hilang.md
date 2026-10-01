# Proposal — Bersihkan 91 record `vidoy_uploads` yang menunjuk file tidak ada

**Tanggal:** 2026-09-27
**Status:** disetujui user
**Risiko:** penghapusan data produksi — tetapi hanya record, bukan file

## 1. Masalah

`vidoy_uploads` menyatakan One Piece punya 733 episode di folder `fx9wycxor3h`.
Isi **nyata** folder itu, dibaca lewat API resmi bot (`folder_ajax`, read-only):

```
Vidoy  : 642 file
DB     : 732 record  (+1 record part 290 dengan folder_id NULL di luar query)
Selisih: 91 record menunjuk file yang tidak ada
```

## 2. Bukti

### 2.1 Side Vidoy (bukan DB)

```
Vidoy session login OK
listFolderFiles('fx9wycxor3h') → 642 file
  id unik: 642   judul unik: 642
  contoh: "One Piece — Ep 734.mp4", "One Piece — Ep 728.mp4"
```

Pencocokan dilakukan dengan mencocokkan **filecode** dari `dashboard` DB
(`https://vidoy.asia/view/<code>`) dengan `id` dari `folder_ajax`:
**642 dari 732 cocok** → 90 tidak cocok.

### 2.2 Bukan salah folder

Seluruh 12 folder di akun discan:

```
/bbwmuslimdalia                             29 file
/VVIP AKSES, /DATABASE, /ANIME, /DRAMA      0
/Black Torch                                12
/Naruto Kecil                              220
/Naruto Shippuden                          500
/One Piece                                 642
/Re:Zero kara Hajimeru Isekai Seikatsu      25   ← lengkap setelah fix folderKey
/Re:Zero kara Hajimeru Isekai Seikatsu S2   25
/Terobsesi Padanya Siang dan Malam           7

filecode yang dicari: 91   ditemukan di folder lain: 0
→ file benar-benar tidak ada di akun, bukan salah folder
```

### 2.3 Rentang yang hilang

```
278-289   (12)   HILANG
290       ( 1)   HILANG  ← ikut, bukan cuma kosmetik; folder_id NULL + file tidak ada
291-292   ( 2)   ADA
293-302   (10)   HILANG
303       ( 1)   ADA
304-370   (67)   HILANG
371-384   (14)   ADA
385       ( 1)   HILANG
                  ────
total 108        HILANG 91 · ADA 17
```

Semua hilang dalam satu blok waktu: **08:48:11 → 09:57:24 UTC**.

Part 290 Awalnya saya kira hanya masalah kosmetik (§A6 di audit
`2026-09-26-vidoy-folder-duplikat.md`: `folder_id` NULL karena
`ON CONFLICT … DO UPDATE SET folder_id = $6` tanpa `COALESCE`). Setelah
discanning, **file-nya juga tidak ada** — jadi bukan kosmetik.

## 3. Kenapa harus dihapus (bukan dibiarkan)

`uploadSingle` menentukan duplikat dari `link`:

```js
// services/vidoyService.js:236-237
const existing = (await db.listVidoyUploads(mediaKey, kind).catch(() => []))
  .find((r) => Number(r.part) === num && r.link);
if (existing) return { ok: true, skipped: true, link: existing.link, ... };
```

Semua 91 record **punya `link`**, jadi `find()` akan kena dan mengembalikan
`skipped: true`. Akibatnya:

- `kam_all` One Piece berikutnya akan melaporkan 91 episode "sudah ada"
- file-nya nol → tidak pernah terupload ulang
- Aturan AGENTS.md §6: "satu episode = satu file di Vidoy" — record yang
  menunjuk file tidak ada **melanggar** aturan itu, dan memblokir perbaikannya

Tidak ada opsi "biarkan": record itu actively merusak. Dan tidak ada opsi
"pindahkan file" karena file-nya tidak ada di mana pun.

## 4. Scope

**Tidak ada perubahan kode.** Hanya penghapusan 91 baris di `vidoy_uploads`.

Backup penuh (17 kolom) tersimpan sebelum penghapusan:

```
/tmp/opencode/hilang-91.json   (JSON utuh)
/tmp/opencode/hilang-91.csv    (CSV, bisa diimpor)
/tmp/opencode/hilang-91-parts.txt
```

Kalau ternyata penghapusan keliru, restore = insert balik dari JSON itu.

## 5. Verifikasi

Sebelum & sesudah, ukur ulang **dari sisi Vidoy**:

1. `listFolderFiles('fx9wycxor3h')` → harus tetap **642** (kita tidak
   menyentuh file, hanya record DB)
2. Cocokkan ulang filecode DB ↔ `folder_ajax` → selisih harus **0**
3. `vidoy_uploads` untuk One Piece → semua record-nya harus punya file

## 6. Konsekuensi yang harus diterima

Semua 91 record punya `tg_chat_id`/`tg_message_id`. Setelah dihapus:

- **91 pesan Telegram** akan punya link `vski.cc` yang mati
- 91 episode harus diupload ulang dari provider (One Piece kamenime tersedia
  sampai ~1180, jadi tidak ada masalah sumber)
- `media_parts` tidak terpengaruh (kolom `media_key` untuk anime memakai
  judul, bukan pointer file Vidoy)

## 7. Di luar scope (dilaporkan, belum dikerjakan)

- **Akar masalah upload yang mencatatkan 91 record palsu belum ditemukan.**
  Kemungkinan: upload jatuh ke root, upload ke folder lain lalu terpindah,
  atau record ditulis sebelum upload komit. `app.log` sudah terpotong ke 500
  baris sehingga bukti 08:48–09:57 tidak bisa dibaca lagi — perlu full log.
- **`folder_id` NULL tanpa `COALESCE`** (§A6) — bug terpisah, perlu fix di
  `db.js` `saveVidoyUpload`.
- **Bot jalan di luar pm2** — `pm2 list` kosong padahal bot masih menerima
  pesan. Restart lewat pm2 tidak akan berlaku untuk instance yang sekarang.
