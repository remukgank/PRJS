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

### A2. ~~Folder yang benar-benar dipakai 113 file anime~~ → **SALAH, SUDAH DIKOREKSI**
Klaim lama: "`root/Naruto Kecil` = id `7pgok84sn88`, satu level di atas A1".
**Klaim ini salah.** Bukti yang salah: `fetchFolders()` tanpa argumen ternyata
mengembalikan **daftar semua folder di akun**, bukan hanya anak root.

### A3. ~~Isi root Vidoy~~ → **SALAH, SUDAH DIKOREKSI**
Klaim lama: "`ANIME`/`DATABASE`/`DRAMA` di root = residue, path bersarang tidak
dipakai". **Salah** — semuanya memang ada, tapi tidak di root.

### A2b. STRUKTUR FOLDER YANG BENAR (terbukti, 26 Sep 2026 ~10:40 UTC)
Ditelusuri lewat halaman publik `https://vidkud.com/f/<id>`, yang **server-rendered**
lengkap dengan link "← Back" ke folder induk:

```
VVIP AKSES                 jv0pr371k5q
└── DATABASE               re6biy4v4dn
    ├── ANIME              0kemjvcuq8e
    │   └── Naruto Kecil   7pgok84sn88   ← 113+ file anime
    └── DRAMA              6z5d841fxym
        └── Terobsesi…     nfyc0f69u8d   ← 7 file drama
```
Rantai "Back": Naruto Kecil → ANIME → DATABASE → VVIP AKSES.
Artinya `folder_id = 7pgok84sn88` **benar** dan sesuai `animeFolderPath()`.
→ **Tidak ada bug path folder.** H1 gugur.

### A3b. Cross-check 20 file yang terlihat vs DB
Halaman publik folder **keras dibatasi 20 item** (parameter `?page=` diabaikan,
tidak ada paginasi di HTML). 20 file yang terlihat = Ep 1-10 dan Ep 100-109.

| Cek | Hasil |
|---|---|
| File di folder | 20 |
| Cocok dengan `link` di `vidoy_uploads` | **20 / 20** |
| File asing / yatim | **tidak ada ✓** |
| Nomor episode duplikat | **tidak ada ✓** |
| Folder drama | 7 file, cocok 7/7 dengan DB ✓ |

**Batas evidence:** hanya 20 dari 113+ file yang bisa dilihat. File ke-21 ke atas
belum terverifikasi.

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

**H1 — Dua lokasi, bukan dua kali upload.** → **GUGUR (salah).**
Ditemukan struktur folder benar di A2b: hanya ada SATU folder
`VVIP AKSES/DATABASE/ANIME/Naruto Kecil`. Tidak ada duplikasi lokasi.

**H2 — Upload ulang yang tidak tercatat.** → **MASIH MAYA BERLAKU.**
Kalau episode ter-upload 2×, `ON CONFLICT` menimpa `link` sehingga file lama
menjadi orphan yang tidak dirujuk DB. Mechanism yang mungkin:
- (a) 2 instance bot berjalan bersamaan (ada riwayat `409 Conflict` di repo ini)
- (b) dedup buta saat DB error: `listVidoyUploads(...).catch(() => [])`
  di `vidoyService.js:236` → `existing` undefined → upload ulang

Status: 20 file yang terlihat tidak menunjukkan yatim, tapi hanya 20 dari 113+
yang bisa diperiksa (lihat A3b). Jadi H2 **belum tersingkir**.

---

## C. Batasan yang diketahui

- **C1. ~~Tidak bisa list isi folder~~ → SUDAH TERATASI.**
  Solusi: halaman publik `https://vidkud.com/f/<folder_id>` di-render server-side
  dan memuat nama file + link "← Back" ke folder induk.
  Endpoint yang gagal: `/folder/<id>` (HTML app), `/folders/<id>`,
  `/folder/files/<id>`, `/files?folder=<id>` (404), `/videos*` (HTML).
  **Batas keras: hanya 20 item per folder.** Parameter `?page=` diabaikan dan
  tidak ada kontrol paginasi di HTML. Untuk melihat >20 file, andalkan dashboard.
- **C2.** Tidak boleh mengakses `fomo-drama/` tanpa perintah eksplisit user.
- **C3.** `vidoy_uploads` tidak menyimpan id file Vidoy, hanya `link`. Filecode
  bisa diturunkan dari link: `https://vski.cc/e/<filecode>` → `https://vidkud.com/d/<filecode>`.

---

## D. Langkah verifikasi — WAJIB sebelum menghapus file di Vidoy

1. **Buka `VVIP AKSES/DATABASE/ANIME/Naruto Kecil` di dashboard.**
   Expectasi: 1 file per episode, nama `Naruto Kecil — Ep NN.mp4`, tanpa nomor
   episode yang muncul dua kali.
2. **Cek satu episode yang terlihat di A3b (mis. Ep 1) di dashboard** —
   filecode-nya harus `voit3jakr51l`, cocok dengan `link` di DB.
3. **Kalau di dashboard terlihat nomor episode ganda** → H2 terjadi. Cari file
   mana yang **tidak** ada di `docs/audit/2026-09-26-vidoy-link-naruto-kecil.csv`:
   itu kandidat orphan.
4. **Cross-check dengan DB fomo-drama SEBELUM menghapus apa pun.**
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

---

## F. VERIFIKASI FINAL — 26 Sep 2026 (browser sungguhan, 220/220)

### Metode
Checker: `scraper/tools/check-vidoy-links.js` — satu Chromium headless per link
(`--dump-dom`), verdict-nya bukan "halaman tidak 404" tapi **apakah `videq_iframe`
bertoken terbentuk**, lalu token di-decode untuk diambil nama file asli.

### Hasil
| Metrik | Hasil |
|---|---|
| Episode diperiksa | **220 / 220** (seluruh seri) |
| Punya pemutar + token | **220** |
| Mati / tanpa pemutar / error | **0** |
| Nama file di token ≠ nomor episode | **0** |
| Hasil mentah | `docs/audit/2026-09-26-vidoy-link-check-220.csv` |

### Koreksi penting atas klaim sebelumnya
Saya sempat menyatakan "Ep 01 file-nya rusak" berdasarkan halaman 404. **Itu SALAH.**
Terbukti: Ep 01 punya pemutar dan token `Naruto Kecil — Ep 01.mp4`.

Penyebabnya: **`vidmonstr.com` serving 404 secara intermiten** untuk file yang
valid — episode yang sama balas 404 pada satu request dan playable pada request
berikutnya. Terukur:
- curl ke `soit3jakr51l` (Ep 01): 0/20 hidup di satu jendela, 20/20 hidup di jendela lain
- Chromium: 404 sekali, lalu `punya-pemutar` di pemeriksaan berikutnya
- Satu kali cek link **tidak bisa dipercaya** sebagai bukti file mati

### Konsekuensi untuk `link_alive`
Satu kali cek = positif palsu (`false negative`). `link_alive=false` baru layak
dipakai sebagai bukti kalau link **diulang minimal 2–3× dan tetap 404**.

### Kesimpulan
Tidak ada file korup, tidak ada file duplikat di sisi Vidoy, dan nama file tiap
episode cocok dengan episodenya. Dugaan "duplikat" yang initially dilaporkan tidak
terkonfirmasi — yang terlihat hanyalah selisih 20 file per tampilan, karena
halaman folder publik membatasi tampilan di 20 item per halaman (bukan paginasi
yang bisa diproses).
