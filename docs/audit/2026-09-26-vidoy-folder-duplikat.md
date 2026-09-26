# D suspected: duplikat folder Vidoy — yang TERBUKTI vs yang HIPOTESIS

Tanggal: 26 Sep 2026
Status: **BELUM SELESAI** — jangan simpulkan tanpa verifikasi baru.

Tujuan file ini: mencegah sesi berikutnya mengulang spekulasi pada hal yang
sama dan menganggap hipotesis sebagai fakta.

---

## A. TERBUKTI (sudah diverifikasi, bisa diulang)

### A1. Path folder yang diensURE kode
```js
animeFolderPath(title) → ["VVIP AKSES", "DATABASE", "ANIME", title]   (vidoy-uploader.js:420)
dramaFolderPath(title) → ["VVIP AKSES", "DATABASE", "DRAMA", title]   (vidoy-uploader.js:416)
```
Dipakai oleh `resolveFolder()` → `Vidoy.getOrCreateFolderPath(segments)`
(`scraper/services/vidoyService.js:71-75`).

### A2. Folder yang benar-benar dipakai 113 file anime
`root/Naruto Kecil` = id `7pgok84sn88` — **satu level di atas** path yang
dijamin di A1.
Bukti: kolom `folder_id` pada baris `vidoy_uploads` episode 85-113 menunjuk
id tersebut, dan `fetchFolders()` (listing root) memunculkan `Naruto Kecil`
sebagai anak langsung root.

### A3. Isi root Vidoy (7 item)
```
bbwmuslimdalia
VVIP AKSES        ← parent yang seharusnya dipakai
DATABASE          ← ada juga di root (residue)
ANIME             ← ada juga di root (residue)
Naruto Kecil      ← 113 file anime KITA, salah tempat
DRAMA             ← ada juga di root (residue)
Terobsesi Padanya Siang dan Malam  ← 7 file drama KITA, salah tempat
```
Kesimpulan: path bersarang `VVIP AKSES/DATABASE/ANIME/…` **tidak dipakai**;
`ANIME`/`DATABASE`/`DRAMA` yang muncul di root adalah sisa percobaan path.

### A4. DB Naruto Kecil BERSIH — tidak ada duplikat di sisi kita
- 113 baris, 113 `part` unik, 113 `link` unik
- 1 `media_key` saja (`"Naruto Kecil"`)
- PK: `vidoy_uploads_pkey (media_key, kind, part)`
- Tidak ada `link` yang dipakai >1 baris

### A5. Drama 7 file = BENAR sesuai desain, BUKAN bug
Baris drama: `part=1 → ep 1-10`, `part=2 → ep 11-20`, … `part=7 → ep 61-68`.
Caption kontrak resminya:
```
➧ Judul :- <b>Terobsesi Padanya Siang dan Malam</b>
➧ Part/Episode :- 1 (Ep 1–10)
➧ Provider :- dramawave
➧ Link :- <a href="https://vski.cc/e/ru9a4av12kd9">…</a>
```
Jadi 7 file untuk 68 episode memang yang benar. Jangan dilaporkan sebagai duplikat.

### A6. `folder_id` di-NULL-kan setiap episode yang di-SKIP
Mekanisme:
1. `uploadSingle()` saat record sudah ada return object **tanpa** `folderId`
   (`services/vidoyService.js:238-239`).
2. `vidoy.js:284` meneruskan `folderId: out.vidoy.folderId` (undefined).
3. `saveVidoyUpload()` memakai
   `ON CONFLICT … DO UPDATE SET folder_id = $6` **tanpa syarat COALESCE**
   → NULL menimpa nilai lama.

**Dampak: KOSMETIK.** Tidak ada kode yang membaca kolom ini; dedup hanya pakai
`link` + `part` (`vidoyService.js:237`). Episode baru (114+) akan menyimpan
`folder_id` lagi karena `resolveFolder()` dipanggil tiap upload baru.
→ **Tidak perlu menghentikan proses.**

### A7. Batch `vyt` sedang berjalan
Pada 26 Sep 2026 ~10:20 UTC batch masih aktif (sudah melewati part 84/113).
Setiap episode yang dilewati akan tercatat `folder_id` NULL (lihat A6).

---

## B. HIPOTESIS — BELUM terbukti. Jangan jadikan fakta.

**H1 — Dua lokasi, bukan dua kali upload.**
File yang sama ada di `VVIP AKSES/DATABASE/ANIME/Naruto Kecil` **dan**
`root/Naruto Kecil`. Itu sebab duplikat.
Status: **belum bisa dibuktikan** — tidak ada API untuk melihat isi folder
(lihat C1).

**H2 — Upload ulang yang tidak tercatat.**
Kalau episode ter-upload 2×, `ON CONFLICT` menimpa `link` sehingga file lama
menjadi orphan yang tidak dirujuk DB. Mechanism yang mungkin:
- (a) 2 instance bot berjalan bersamaan (ada riwayat `409 Conflict` di repo ini)
- (b) dedup buta saat DB error: `listVidoyUploads(...).catch(() => [])`
  di `vidoyService.js:236` → `existing` undefined → upload ulang

Status: **belum ada bukti** bahwa H2 terjadi.

---

## C. Batasan yang diketahui

- **C1.** Tidak bisa list isi folder Vidoy. `fetchFolders()` tanpa argumen
  hanya listing root; `/folder/<id>` membalas HTML; `/folders/<id>`,
  `/folder/files/<id>`, `/files?folder=<id>` → 404.
  `getOrCreateFolderPath()` **bisa** dipanggil, tapi berk efek samping
  membuat folder baru → jangan dipakai hanya untuk probing.
- **C2.** Tidak boleh mengakses `fomo-drama/` tanpa perintah eksplisit user.
- **C3.** `vidoy-uploads.folder_id` tidak bisa dipetakan ke file spesifik,
  karena tabel tidak menyimpan id file Vidoy (hanya `link`).

---

## D. Langkah verifikasi — WAJIB sebelum menghapus file di Vidoy

1. **Hitung file di `VVIP AKSES / DATABASE / ANIME / Naruto Kecil`.**
   Expectasi: 113 file `Naruto Kecil — Ep 01.mp4` … `Ep 113.mp4`.

2. **Hitung file di root `Naruto Kecil`.**
   Expectasi: 113 file dengan nama yang sama.

3. **Keduaanya 113 → H1 terkonfirmasi**, dan itu yang menyebabkan duplikat.
   Kalau hanya salah satu yang berisi → bukan H1, kembali ke H2.

4. **Cross-check dengan DB fomo-drama SEBELUM menghapus apa pun.**
   Daftar link: `docs/audit/2026-09-26-vidoy-link-naruto-kecil.csv`
   (113 link; 87 episode punya pesan Telegram, 26 tidak).
   ⚠️ Peringatan: `!dell` pernah menghapus **69 pesan Telegram** yang isinya
   link. fomo-drama bisa sudah menyimpan link itu sebelum pesannya dihapus.
   "Tidak ada pointer Telegram" **bukan** bukti aman dihapus.

---

## E. Urutan pekerjaan yang disepakati

1. Commit catatan ini (dokumentasi saja, tanpa mengubah kode).
2. Telusuri kenapa segmen path diabaikan (`_pathCache` / fallback saat
   segmen tidak ketemu) — read-only dulu.
3. Fix `saveVidoyUpload`: jangan timpa `folder_id`/`folder_url` dengan NULL
   (kosmetik, boleh dibundel).
4. Fix path folder + migrasi file — **hanya setelah** H1 terkonfirmasi dan
   setelah fomo-drama dinyatakan aman oleh user.
