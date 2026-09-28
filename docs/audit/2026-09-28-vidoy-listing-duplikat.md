# Audit: Listing file Vidoy sebagai verifikasi sumber (anti duplikat)

Tanggal: 2026-09-28
Versi: v3.3.3 (menunggu deploy — restart ditahan oleh §3a)
Tag: patch (fix bug, tidak ada kontrak yang berubah)

---

## 1. Gejala

Batch Naruto Shippuden menghasilkan **504 file** di folder Vidoy, sementara DB mencatat
**500**. Selisih 4 file adalah duplikat — nama file identik, link berbeda:

| Episode | Yatim (dihapus manual) | Dipakai DB | Telegram |
|---------|------------------------|------------|----------|
| 204 | /d/k7ik5elyo0s2 | /d/6iou9v87qxib | 8048 |
| 205 | /d/si79n6z40see | /d/x5dddokg5m5c | 8049 |
| 494 | /d/muzy68lszeyg | /d/ox5si5ji5ufp | 8392 |
| 495 | /d/zdthwmu3hssu | /d/u6zrvt0hhc6r | 8393 |
| 401 | /d/fnsrt4642oi7 | /d/el0tbwnerrll | 8268 |

Pola: **1 restart = 1 orphan**. Naruto sempat restart 4 kali, orphan ada 4.
Selama batch berjalan tanpa restart, nol duplikat (One Piece 212 file = 209 rows DB,
0 yatim, saat audit ini).

## 2. Akar Masalah

`scraper/services/vidoyService.js` → `uploadSingle()`. Urutan lama:

```
1. existing = listVidoyUploads(...).find(r => r.part === num && r.link)
2. if (existing) return { skipped: true, ... }         <- resume sudah benar
3. resolveFolder(...)
4. ensureMp4(...)                 <- unduh ke lokal
5. uploadFile(...)                <- FILE SUDAH ADA DI VIDOY
6. saveVidoyUpload({ link })      <- baru aman dari sini
```

Jendela duplikat = **langkah 5 ke 6**. Yang terbukti:
- Record di DB tidak pernah terduplikasi (`GROUP BY media_key, part HAVING count(*)>1`
  -> `[]`), jadi bukan overwrite.
- Link yatim (`muzy68lszeyg`, `zdthwmu3hssu`, `fnsrt4642oi7`) **benar-benar absen** dari DB.
- Log PRJS mengonfirmasi 2 dari 5 (ep 494, 495) — upload sukses 23:13/23:14, lalu
  di-*replace* 02:57 setelah restart. Ep 204/205 tidak ada di log karena rotasi log.

### 2b. Mengapa Telegram tidak pernah duplikat

Di `scraper/handlers/vidoy.js`, blok `if (needVidara)` dan `if (needTg)` berada
**setelah** `vidoyService.uploadSingle` (baris ~266). Kalau `saveVidoyUpload` tidak
ter tulis, proses mati sebelum blok Telegram. Jadi:

- Link pertama: Vidoy ya, Telegram tidak, DB tidak = **yatim, tidak tercatat**
- Link kedua: Vidoy ya, Telegram ya, DB ya = yang dipakai

Ini sesuai §6 (Telegram boleh kirim ulang, Vidoy dilarang keras duplikat) — jadi bagian
Telegram **tidak diubah** sama sekali. Yang bermasalah hanya sisi Vidoy.

### 2c. Kenapa tidak bisa ditutup dengan halaman web publik

`vidoy_uploads` tidak menyimpan `folder_id`, dan endpoint yang dipakai kode
(`/`, `/signin`, `/folders`, `/videos`, `/add-folder`, `/move`, `/manual`,
`/manual/upload`, `/view/$id`, `/delete`) **tidak ada** yang mengembalikan daftar file
dalam folder. Vidoy juga tidak punya API publik.

## 3. Koreksi atas Lemma Sendiri

Proposal `2026-09-28-vidoy-pending-record.md` (§3) berisi lemma **"tidak ada endpoint
listing file"**. Lemma itu **salah**. Endpoint-nya ada:

```
GET https://vidoy.asia/folder_ajax/<folderId>?p=<n>&l=<perPage>&q=&f=date&s=DESC
Header: Accept: application/json, X-Requested-With: XMLHttpRequest
Cookie: session login bot (/tmp/vidoy_bot_cookies.txt)
```

Respons JSON:

```json
{
  "page": { "current": 1, "next": 2, "number": [1,2,3], "max": 9 },
  "contents": {
    "folder": { "id": "fx9wycxor3h", "name": "One Piece", "parent": "0kemjvcuq8e" },
    "videos": [ { "id": "20msvw48nicx", "title": "One Piece — Ep 208.mp4",
                   "size": "100.5 MB", "duration": "00:24:00", "date": "28-09-2026" } ],
    "totalResults": 500
  }
}
```

`videos[].id` = filecode = bagian terakhir link `/d/<id>`.
`videos[].title` = nama file **persis seperti di-upload**.

Karena itu proposal pending-record ditandai **DIGANTIKAN** dan tidak dikerjakan.

## 4. Biaya Terukur

`l=100` dihormati server (`page.max` = 5 untuk 500 file).

| Anime | file | request | waktu |
|-------|-----:|--------:|------:|
| Naruto Shippuden | 500 | 5 | 0,72 dtk |
| Naruto Kecil | 220 | 3 | — |
| One Piece | 225 | 3 | — |
| Re:Zero S1 / S2 | 25 / 25 | 1 / 1 | — |

Rata-rata **143 ms per request**. Listing satu folder penuh = beberapa ratus milidetik.
Untuk 500 episode hanya **5 request** — bukan per episode.

## 5. Yang Diubah

### `scraper/vidoy-uploader.js` (+3 fungsi, +cache, +3 export)

- `listFolderFiles(folderId)` — pagination lewat `page.next`, `l=100`. Guard:
  `folderId` kosong -> `[]` tanpa request; `res.code !== 200` -> throw; body bukan
  JSON -> throw; `videos` kosong -> stop; `next` null/sama dengan `page` -> stop;
  `seenPages` mencegah loop kalau server mengulang halaman.
- `folderFileIndex(folderId, { force })` — Map dua arah `byTitle` / `byId`, di-cache
  per `folderId` (satu network call per anime per batch).
- `invalidateFolderFileCache(folderId)` — dipanggil setelah upload sukses supaya
  file yang baru masuk tidak tertinggal di cache.
- `resetSession()` ikut membersihkan cache file.

### `scraper/services/vidoyService.js` — `uploadSingle()`

Setelah `resolveFolder` (dapat `folder.id`), **sebelum** `ensureMp4`:

```js
const index = await Vidoy.folderFileIndex(folder.id);
const hit = index.byTitle.get(fileName);
if (hit) {
  // self-healing: catat ke DB supaya tidak buta selamanya
  await db.saveVidoyUpload({ ... link, folderId, folderUrl });
  return { ok: true, skipped: true, fromListing: true, ... };
}
```

Kalau listing **gagal** -> `catch` + warn, lalu jatuh ke perilaku lama (cek DB).
Listing tidak boleh jadi titik gagal baru.

### `scraper/services/vidoyService.js` — test hooks

`__testHooks = { uploadFile, ensureMp4, resolveFolder }` +
`__setTestHooks(h)`, dipakai di 3 titik pemanggilan
(`(__testHooks.X || X)(...)`). Defaults `null` -> perilaku produksi tidak berubah.

### `scraper/tests/test-vidoy-listing.js` (baru, 20 test)

Pagination 3 halaman, halaman kosong, `next: null`, halaman berulang, HTTP != 200,
body bukan JSON, `folderId` kosong, cache hit, invalidate, Map dua arah, listing-hit
skip tanpa upload, self-healing save, upload normal, fallback saat listing gagal,
resume dari DB tidak perlu listing, pad 2 digit, dan 4 test pengunci kode.

## 6. Verifikasi

**Test baru: 20 pass / 0 fail.**

**Mutasi: 9 dari 9 tertangkap.**

| Mutasi | Hasil |
|--------|-------|
| M1 cache dimatikan | TANGKAP (19/1) |
| M2 pagination dimatikan | TANGKAP (19/1) |
| M3 guard HTTP dihapus | TANGKAP (19/1) |
| M4 parse-JSON throw dihapus | TANGKAP (19/1) |
| M5 byTitle tidak diisi | TANGKAP (19/1) |
| M6 guard "sudah ada" dihapus | TANGKAP (17/3) |
| M7 fallback catch dihapus | TANGKAP (18/2) |
| M8 invalidate cache dihapus | TANGKAP (19/1) |
| M9 self-healing save dihapus | TANGKAP (19/1) |

M10 (loop guard dihapus) sengaja di-skip: hasilnya timeout, bukan PASS — timeout
tidak bisa dibedakan dari "test lambat" secara otomatis.

**Regresi 12 file, 0 fail:** test-vidoy-uploader 157 · test-media-key-konsisten 15 ·
test-kamenime-batch 11 · test-media-contract 10 · test-picker-prefix 12 ·
test-folder-vidoy-kunci 12 · test-kamenime-provider 26 · test-preview-judul-resolusi 11 ·
test-dell-vdell-logging 11 · test-speed-floor-batas 15 · test-downloadto-speed-floor 10 ·
test-ensure-mp4-path 7 · test-download-stall 7.

**Smoke test NYATA** (read-only ke Vidoy sungguhan, `.hermes/cache/scratch/smoke_listing.js`):

```
Naruto Shippuden  500 file  byTitle=500 byId=500  dup title=0 dup ep=0  ep 1..500
One Piece         225 file  byTitle=225 byId=225  dup title=0 dup ep=0  ep 1..226
Naruto Kecil      220 file  byTitle=220 byId=220  dup title=0 dup ep=0  ep 1..220
cek nama file "Ep 01" / "Ep 05" / "Ep 42" / "Ep 100": ADA (semua)
CROSS-CHECK: DB 725 rows / 725 link unik | Vidoy 725 file
             YATIM 0 | HILANG 0
```

**Penting — pad 2 digit.** Data Vidoy nyata memakai `Ep 01` (bukan `Ep 1`) untuk
ep 1-99 dan `Ep 100` untuk ep 100+. Kode `pad(n) = String(n).padStart(2,'0')` sudah
cocok. Test awal saya menulis `"Demo — Ep 5.mp4"` dan **gagal** — itu bug test, bukan
bug kode. Kalau nama yang dicari tidak sama persis, listing tidak akan pernah menemukan
yatim. Test sekarang mengunci `Ep 05` -> `pad5` dan `Ep 100` -> `pad100`.

## 7. Kesalahan yang Saya Akui

- Test `test-vidoy-listing.js` versi pertama gagal 5 test: stub `V` tidak punya
  `animeFolderPath`/`dramaFolderPath` (resolveFolder jadi error), test mengira
  `.find(r => r.link)` ada di `db.js` (ternyata di service), dan 2 regex tidak cocok.
- Test versi kedua masih 3 fail — versi ketiga dengan nama file `Ep 05` benar lulus 20/20.
- M1-M5 pada mutasi `mutasi_key.sh` (sesi sebelumnya) LOLOS karena pattern tidak cocok.
  Risiko yang sama berulang di sini; aksinya sama: cocokkan dengan teks literal.
- Saya sempat menyatakan "listing tidak ada" tanpa mencoba endpoint `folder_ajax`.
  Itu asumsi, bukan verifikasi.

## 8. Yang Tidak Berubah (penting)

- `listVidoyUploads` di `db.js` — SELECT `tg_chat_id`/`tg_message_id` tetap ikut,
  resume tetap `.find(r => r.part === num && r.link)`.
- `handlers/vidoy.js` — blok Telegram, caption, `needVidara` tidak disentuh.
- Tidak ada record `pending`. Tidak ada kolom baru. Tidak ada migrasi.
- Tidak ada data DB atau file Vidoy yang diubah oleh fix ini.

## 9. Deploy — Tertahan

§3a: restart **tidak boleh** saat ada download/upload berjalan. Saat audit ini ditulis,
`logs/app.log` menunjukkan `08:16:34 Vidoy upload sukses — One Piece — Ep 228.mp4`
(umur 0,3 menit). Batch One Piece masih aktif -> **restart ditahan**.

Kode yang berjalan di bot masih **sebelum** fix ini. Setelah One Piece selesai:

```
1. cek logs/app.log — pastikan tidak ada upload/download < 2 menit
2. set -a; . /run/replit/env/latest; set +a
   pm2 start scraper/bot.js --name prjs-bot --cwd /home/runner/workspace --max-memory-restart 700M
   pm2 save
3. verifikasi bot online, cek log
4. commit + push + tag v3.3.3
```

Catatan: `pm2 list` sedang kosong (bot dijalankan sebagai proses biasa, PID 563).
Menurut AGENTS.md §3a, konfirmasi dulu ke user sebelum menyalakan.
