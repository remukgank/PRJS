# Proposal: catat pending SEBELUM upload Vidoy

Tanggal: 2026-09-28
Status: **DIGANTIKAN** oleh `2026-09-28-vidoy-listing-duplikat.md`
Simpul: issue #2 di lapangan — 4 file yatim di Vidoy (duplikat), 1 restart = 1 orphan

> **Catatan (28 Sep 2026, setelah approval):** Section 3 ("Yang TIDAK bisa diperbaiki")
> berisi assertion yang **salah** — endpoint listing file Vidoy ternyata ADA
> (`/folder_ajax/<folderId>?p=N&l=100`). Sudah diuji langsung, biayanya 5 request untuk
> 500 file. Karena itu pending-record **tidak lagi diperlukan** dan tidak dikerjakan.
> Lihat proposal penggantinya. Jangan kerjakan dari dokumen ini.

---

## 1. Gejala yang Diamati

Batch Naruto Shippuden menghasilkan 504 file di folder Vidoy, sementara DB mencatat 500.
Selisih 4 file = 4 yatim. Semua出现在 episode yang sedang diproses saat bot restart.

| Episode | Yatim (hapus) | Dipakai DB | Telegram |
|---------|---------------|------------|----------|
| 204 | /d/k7ik5elyo0s2 | /d/6iou9v87qxib | 8048 |
| 205 | /d/si79n6z40see | /d/x5dddokg5m5c | 8049 |
| 494 | /d/muzy68lszeyg | /d/ox5si5ji5ufp | 8392 |
| 495 | /d/zdthwmu3hssu | /d/u6zrvt0hhc6r | 8393 |
| 401 | /d/fnsrt4642oi7 | /d/el0tbwnerrll | 8268 |

(semua /d/ sudah dihapus manual oleh user pada 2026-09-28)

## 2. Akar Masalah — Terverifikasi di Kode

`scraper/services/vidoyService.js` → `uploadSingle()`. Urutan sekarang:

```
 1. existing = listVidoyUploads(...)  .find(r => r.part === num && r.link)
 2. if (existing) return { skipped: true, ... }        ← resume sudah BENAR
 3. resolveFolder(...)
 4. ensureMp4(...)                    ← unduh ke lokal
 5. uploadFile(...)                   ← FILE SUDAH ADA DI VIDOY
 6. saveVidoyUpload({ link })         ← baru aman dari sini
```

Jendela duplikat = langkah 5 → 6. Ada 3 titik bisa terputus di antaranya:
- `uploadFile` selesai, proses mati sebelum `saveVidoyUpload`
- `uploadFile` gagal sebagian,_folder tidak ter-move
- Replit restart / sleep di tengah

Bukti DB (2026-09-28): `SELECT media_key, part, count(*) FROM vidoy_uploads GROUP BY 1,2 HAVING count(*)>1` → `[]`.
Jadi tidak ada overwrite; setiap yatim benar-benar tidak tercatat.

Bukti orphan tidak terkirim ke Telegram: di `handlers/vidoy.js`, blok `if (needTg)` berada
SETELAH `vidoyService.uploadSingle` (baris ~266) dan setelah `saveVidoyUpload`. Jadi kalau
record tidak tertulis, proses mati sebelum blok Telegram. Pointer Telegram tidak pernah dibuat.

## 3. Yang Edo TIDAK Bisa Diperbaiki

Terverifikasi: tidak ada endpoint listing file di Vidoy.
Endpoint yang dipakai kode: `/`, `/signin`, `/folders` (folder saja), `/videos` (hanya header
`Referer`), `/add-folder`, `/move`, `/manual`, `/manual/upload`, `/view/$id`, `/delete`.
Tidak ada API publik (vidoy.asia tidak punya dokumentasi developer).

Konsekuensi: **fix ini tidak bisa mencegah duplikat 100%.** Yang bisa dilakukan:
- membuat yatim punya jejak di DB (tidak "buta")
- memberi tahu pemeriksa saat rekap
- mengurangi frekuensi (upload yang gagal dihapus, tidak tertinggal)

Claim "pending akan mencegah duplikat" adalah LEBIH. Saya tidak menulisnya.

## 4. Fix yang DIUSULKAN

Satu INSERT sebelum `uploadFile`, dengan `link` NULL sebagai penanda "sedang dikerjakan".

### Kode

`scraper/db.js` — tambah 2 fungsi:

```js
async function markVidoyPending(rec) {
  const { mediaKey, kind = 'drama', part = 0, title = null, filePath = null } = rec || {};
  // INSERT ... ON CONFLICT DO NOTHING untuk tidak menimpa record yang sudah punya link
}

async function clearVidoyPending(mediaKey, kind = 'drama', part = 0) {
  // DELETE HANYA jika link IS NULL (record pending). Kalau sudah ada link, jangan sentuh.
}
```

`scraper/services/vidoyService.js` → `uploadSingle()`:

```js
  // SEBELUM uploadFile
  if (db && db.markVidoyPending) {
    await db.markVidoyPending({ mediaKey, kind, part: num, title, filePath });
  }
  const up = await uploadFile(filePath, onProgress, folder);
  if (!up.ok) {
    if (db && db.clearVidoyPending) {
      await db.clearVidoyPending(mediaKey, kind, num);   // gagal → biar retry
    }
    return up;
  }
  // saveVidoyUpload yang sudah ada tetap Jalan (memperbarui pending → punya link)
```

`clearVidoyPending` memakai `DELETE ... WHERE link IS NULL` agar tidak pernah menghapus
record yang sudah punya link (bila `uploadFile` sukses tapi `saveVidoyUpload` gagal).

### Test yang akan ditulis

`scraper/tests/test-vidoy-pending.js`:
1. record pending dibuat SEBELUM uploadFile dipanggil (urutan diverifikasi lewat urutan call)
2. `clearVidoyPending` TIDAK menghapus record yang punya link
3. `clearVidoyPending` menghapus record pending (link NULL)
4. `markVidoyPending` tidak menimpa record yang sudah punya link
5. `listVidoyUploads` masih mengembalikan record pending (link NULL) → resume skip
6. Mutation test: hapus `markVidoyPending` → test 1 harus gagal

## 5. Trade-off yang Harus Diketahui

**Risiko baru:** kalau proses mati setelah `uploadFile` sukses tapi sebelum `saveVidoyUpload`,
record tertinggal `link = NULL` secara permanen. Episode itu akan **selalu** di-skip
(pointer `&& r.link` masih false, jadi tidak skip — baca catatan di §6).

Catatan penting: `uploadSingle` mencari dengan `.find(r => r.part === num && r.link)`.
Record `link = NULL` **tidak** menyebabkan skip. artinya episode pending akan di-upload ulang
persis seperti sekarang. Itu tidak menutup duplikat — hanya memberi jejak.

**Perbaikan ini TIDAK menutup duplikat.** Yang menutup butuh listing file Vidoy yang tidak ada.

Kalau Ochi ingin yang benar-benar menutup duplikat, opsinya:
- (A) Menambah kolom `vidoy_state` + `file_hash` dan cek nama file via folder listing HTML
  dashboard (fragil, ~1 request per folder bukan per episode)
- (B) Menerima duplikat, tapi menambah audit di rekap: 1 request listing per folder,
  bandingkan vs DB, lapor yatim (deteksi, bukan cegah)

Keduanya perlu approve terpisah. Proposal ini sengaja hanya mencakup bagian yang jelas aman.

## 6. Catatan soal `listVidoyUploads`

Harus diubah: fungsi resume searching `.find(r => r.part === num && r.link)` **tidak diubah**.
Kalau diubah agar record pending ikut di-skip, episode dengan `link NULL` akan hilang permanen
dan tidak bisa di-retry. Itu lebih buruk daripada duplikat. Resume tetap seperti sekarang.

## 7. Scope File

- `scraper/db.js` — 2 fungsi baru
- `scraper/services/vidoyService.js` — 2 blok di `uploadSingle`
- `scraper/tests/test-vidoy-pending.js` — baru

Tidak menyentuh: DB data, Vidoy, `handlers/vidoy.js`, `bot.js`, folder.

## 8. Verifikasi Rencana

- `node --check` untuk 2 file
- test baru: 6 test + mutation
- regresi: `test-vidoy-uploader.js` (157), `test-media-key-konsisten.js` (15),
  `test-kamenime-batch.js` (11), `test-media-contract.js` (10)
- tidak ada restart selama batch Naruto/One Piece jalan
