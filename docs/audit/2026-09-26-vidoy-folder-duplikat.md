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

---

## G. BUG: gofile & pixeldrain selalu gagal di jalur Vidoy (26 Sep 2026, 16:00 UTC)

### Gejala
Batch "Black Torch" (`sam_allgo:vyt`): 12 episode, **episode 1–4 gagal**, 5–12 sukses.

### Trace
1. Log bot **hilang**: stdout diarahkan ke `/dev/pts/2`, tidak ada file log.
   Setelah instance restart, bot juga **tidak di bawah pm2** (proses telanjang).
   Jejak `/tmp/vidoy-*` juga ikut terhapus.
2. Sumber normal: samehadaku punya 12 episode (`black-torch-episode-N/`),
   halaman ep 1 dan ep 5 identik secara struktur.
3. `resolveSamehadakuFullhd()` untuk ep 1 & 2 mengembalikan server
   `gofile, pixeldrain` (ep 1 punya tambahan `krakenfiles` yang tak didukung).
   Jadi **bukan** "no supported server" — ep 5 sukses karena punya `filedon`.
4. `resolveDirectUrl()` → `null` untuk gofile & pixeldrain, `OK` untuk filedon.

### Root cause — ketidakcocokan nama field
`scraper/handlers/download.js:resolveDirectUrl()`

| Provider | Yang dikembalikan | Yang dibaca dispatcher | Hasil |
|---|---|---|---|
| gofile | `{ url, name, size }` | `file?.link` | **null → gagal** |
| pixeldrain | `{ id, name, size, mimeType, directUrl }` | `info?.url` | **null → gagal** |
| filedon | `{ url, name, size }` | `f?.url` | benar → jalan |

Dampak: di jalur `target != 'tg'` (upload Vidoy), **hanya `filedon` dan
`gdriveplayer` yang bisa dipakai**. Episode yang hanya punya gofile/pixeldrain
selalu `fail`. Jalur `target === 'tg'` tidak terpengaruh karena memanggil
`downloadSamehadakuFile()` yang memanggil provider secara langsung.

### Perbaikan
`resolveDirectUrl()` kini menerima kedua nama field:
- gofile → `file.url || file.link`
- pixeldrain → `info.directUrl || info.url`

### Verifikasi
| Uji | Sebelum | Sesudah |
|---|---|---|
| ep 1 gofile | `null (gagal resolve)` | `OK → BlackTorch-01-FULLHD-SAMEHADAKU.CARE.mp4` |
| ep 1 pixeldrain | `null (gagal resolve)` | `OK → BlackTorch-01-FULLHD-SAMEHADAKU.CARE.mp4` |
| ep 2 gofile | — | `OK → BlackTorch-02-FULLHD-SAMEHADAKU.CARE.mp4` |
| ep 2 pixeldrain | — | `OK → BlackTorch-02-FULLHD-SAMEHADAKU.CARE.mp4` |

`test-vidoy-uploader` **130 pass** (+3 tes, termasuk tes anti-drift yang
memastikan nama field di dispatcher sama dengan yang ditulis provider).
Suite lain 0 fail. Tidak ada kode produksi lain yang diubah.

## H. Kenapa episode Black Torch 1–4 gagal (26 Sep 2026, 16:05 UTC)

Setelah log pm2 aktif, error aslinya terlihat:
```
ERROR: Anime episode upload gagal  ep:1  target:"vyt"
  err: "Vidoy CDN status invalid: <br /><b>Deprecated</b>:
       explode(): Passing null to parameter #2 ($string) of type string"
```

### Rantai penyebab
1. `resolveDirectUrl()` sudah benar (fix di `f4dd597`) → flowQH jalan sampai upload.
2. Link gofile yang di-resolve **tidak melayani video**: fetching
   `store9.gofile.io/download/web/…` memberi **3358 byte HTML**
   (`"Gofile needs JavaScript to run"`), bukan MP4 — tetap HTML walau
   memakai `Cookie: accountToken`.
3. Bot mengunduh HTML itu, lalu mengirimkannya ke CDN Vidoy sebagai video →
   Vidoy menolak, dan pesannya muncul sebagai PHP deprecation (menyesatkan).

### Status tiap mirror (dicek langsung ke provider)
| Episode | pixeldrain | gofile | filedon |
|---|---|---|---|
| ep 1 | **BLOKIR** `unavailable_for_legal_reasons` (copyright) | HTML, bukan video | tidak ada |
| ep 2 | **DATA (MP4)** | — | tidak ada |
| ep 3 | **BLOKIR** (copyright) | — | tidak ada |
| ep 4 | **DATA (MP4)** | — | tidak ada |
| ep 5 | **BLOKIR** (copyright) | — | OK (batch sukses) |

Pesan takedown: *"This file cannot be downloaded because it has received a
takedown report"*, `extra.type = "copyright"`.

### Kesimpulan
- **ep 2 & 4**: gagalnya karena bug `resolveDirectUrl` → **sudah terperbaiki**, harusnya tembus.
- **ep 1 & 3**: file-nya **di-takedown di semua mirror yang tersedia**.
  - pixeldrain: diblokir copyright
  - gofile: tidak bisa diunduh (halaman JS)
  - krakenfiles: ada di listing tapi di balik Cloudflare Turnstile → tidak praktis
  - filedon: tidak tersedia untuk episode ini

  Tidak ada perbaikan kode yang bisa mengunduh 2 episode ini dari mirror yang ada.
  Butuh sumber lain (mis. menunggu samehadakucelluloseganti file, atau provider baru).

### Saran perbaikan (belum dikerjakan)
Validasi file setelah unduh (magic bytes `ftyp` untuk MP4 + ukuran minimum)
sebelum upload, supaya error-nya *"file hasil unduh bukan video (3.4 KB HTML)"*
alih-alih pesan PHP dari sisi Vidoy.

## I. KOREKSI: gofile BISA diunduh — header Authorization yang hilang (26 Sep 2026)

### Kesalahan saya sebelumnya
Saya menyimpulkan "gofile tidak bisa diunduh" karena fetch tanpa header tertentu
menghasilkan 3358 byte HTML. **Kesimpulan itu salah** — saya tidak menguji dengan
header `Authorization: Bearer $GOFILE_TOKEN`, padahal `GOFILE_TOKEN` **ada**
(32 char) dan justru dikirim oleh jalur Telegram.

### Bukti empiris (`store9.gofile.io/.../BlackTorch-01-FULLHD-SAMEHADAKU.CARE.mp4`)
| Header | Hasil |
|---|---|
| `Referer` saja | 3358 byte, HTML `Gofile needs JavaScript to run` |
| `Referer` + `Authorization: Bearer $GOFILE_TOKEN` | **MP4 asli, magic bytes `ftypisom`** |

### Akar masalah sebenarnya
Dua jalur mengunduh file gofile dengan cara berbeda:

| Jalur | Fungsi | Header gofile | Hasil |
|---|---|---|---|
| Telegram (`target=tg`) | `handleGofileUrl` → `downloadWithAria2c(..., extraHeaders, ...)` | `Referer` + `Authorization: Bearer` ✅ | MP4 |
| Vidoy (`target!=tg`) | `actionAnimeEpisode` → `ensureMp4` → `downloadTo` (`services/vidaraService.js:17`) | **hanya `User-Agent`** ❌ | HTML 3 KB → ditolak Vidoy |

Jadi pesan `Vidoy CDN status invalid ... explode(): Passing null` adalah gejala
file HTML, bukan masalah server Vidoy.

### Perbaikan
`downloadTo()` mendeteksi host toko gofile
(`^((cold|store|file)[\w-]*)\.gofile\.io$`) lalu menambah
`Referer: https://gofile.io/` + `Authorization: Bearer $GOFILE_TOKEN`.

### Verifikasi end-to-end
`ensureMp4()` ke link gofile Black Torch Ep 1 → file tumbuh normal, magic bytes
`"....ftypisom...."`, MP4 valid. `test-vidoy-uploader` **133 pass** (+3 tes),
suite lain 0 fail.

### Catatan
Episode 1 & 3 tetap perlu mirror lain: file-nya **di-takedown copyright** di
pixeldrain. gofile bisa dibaca setelah header di atas, tapi ketersediaannya
bergantung pada mirror.

## J. TRACE LENGKAP SEMUA JALUR UNDUH (26 Sep 2026)

Dipetakan semua titik unduh di kode, lalu diverifikasi fungsional dengan server
lokal yang membalas HTTP 200 (MP4 asli vs HTML error).

### Titik unduh yang ada
| Fungsi | Dipakai jalur | Header | Validasi |
|---|---|---|---|
| `downloadWithAria2c` (`downloader.js:306`) | Telegram semua leaf handler | `extraHeaders` dari pemanggil ✅ | **baru ditambahkan** |
| `downloadTo` (`vidaraService.js:17`) | Vidoy (`actionAnimeEpisode`) & Vidara (`downloadChunk`) | gofile auth ✅ (commit `320bbfd`) | `assertLooksLikeVideo` ✅ |
| `ensureMp4` ffmpeg (HLS) | Vidoy/Vidara | — | (via ffmpeg) |

### Temuan trace
1. **Celah terakhir**: jalur Telegram tidak memvalidasi hasil unduh — persis
   bug yang baru diperbaiki di jalur Vidoy. `downloadWithAria2c` hanya punya
   pengecekan `sizeBytes < 1024`, jadi HTML 4 KB lolos. Sudah ditutup dengan
   `assertLooksLikeVideo` di `downloader.js`.
2. **Tidak ada jalur unduh lain yang terlewat.** Semua pemanggil
   `downloadWithAria2c` (baris 120/245/357/530/680/851/998) mengirim
   `extraHeaders` yang benar; hanya ada 2 definisi `extraHeaders` dan keduanya
   berisi `Referer` + `Authorization: Bearer $GOFILE_TOKEN`.
3. `uploadSingle` (Vidoy) dan `uploadToVidara` **tidak mengunduh** — hanya
   menerima file yang sudah ada, jadi tidak perlu validasi di sana.

### Verifikasi fungsional (server lokal, HTTP 200)
| Jalur | MP4 asli | HTML error |
|---|---|---|
| Vidoy (`ensureMp4`) | LOLOS ✓ | TERTOLAK ✓ |
| Vidara (`downloadChunk`) | OK ✓ | TERTOLAK ✓ |
| Telegram (`downloadWithAria2c`) | LOLOS ✓ | TERTOLAK ✓ |

`test-vidoy-uploader` **138 pass** (+2), suite lain 0 fail.
Aturan baru di AGENTS.md: satu sumber validasi untuk semua jalur.

## K. TAMPILAN SETELAH SINGLE-EPISODE DISESUAIKAN (26 Sep 2026)

### Masalah
User melaporkan: di single-episode Telegram, setelah episode selesai tampilannya
"standar banget" dan tidak konsisten.

### Ketidaksesuaian yang ditemukan
| Jalur | Tampilan setelah selesai |
|---|---|
| Telegram (`target=tg`) | pesan terpisah polos `⬅️ Kembali ke list episode?` + 1 tombol |
| Vidoy (`target!=tg`) | **tidak ada sama sekali** (langsung `return`) |

Padahal `buildSamehadakuEpisodePicker()` sudah ada dan dipakai `sam_back` —
tampilan kaya: daftar episode, status 📨/🗄/Ep, progress bar, paginasi, dan tombol
untuk langsung pilih episode lain.

### Perbaikan
Helper baru `showEpisodePickerAfterDownload(chatId, msgId, animeUrl)` di `bot.js`:
- memanggil `resolveSamehadakuFullhd` + `buildSamehadakuEpisodePicker`
- hasilnya di-`editMessageText` ke pesan yang sama (bukan pesan baru)
- dipanggil di **kedua** jalur (tg dan vidoy) sehingga konsisten

### Verifikasi
- `node --check` CLEAN
- `test-vidoy-uploader` **139 pass** (+1 tes yang mengunci: kedua jalur wajib
  memanggil helper yang sama, dan pesan polos tidak boleh tersisa di handler
  `sam_go`)
- suite lain 0 fail (test-sam-picker-pagination 7, test-media-contract 10,
  test-btn-style 10, test-caption-html-escape 6)

## L. OPSI TARGET UNTUK PROVIDER LANGSUNG + HAPUS VIDARA (26 Sep 2026)

### Permintaan user
Link provider langsung (gofile/pixeldrain/filedon/mega/gdrive) harus punya opsi
target seperti alur Samehadaku. Vidara tidak perlu — cukup Vidoy.

### Kondisi sebelumnya
Provider langsung: kirim link → prompt judul → **langsung ke Telegram** (tanpa
pilihan target). Opsi target (tg/vt/vyt/vv) cuma ada di alur Samehadaku.

### Perubahan
1. `animeTargetKeyboard` & `mainActionKeyboard`: 3 target — Telegram,
   Vidoy+Telegram, Vidoy. Vidara dihapus dari opsi.
2. `vv` diubah artinya: dari "Vidara+Vidoy" → **Vidoy saja**.
   `vt` (Vidara+Telegram) dihapus dari semua validasi & keyboard.
3. `handlers/vidoy.js`: `needVidara = false`, `needTg = tg || vyt`.
4. Alur provider langsung: helper `resolveProviderTitle()` + preview dengan
   `animeTargetKeyboard` setelah judul dipilih, lalu handler `dl_go:<target>`
   menangani tg (provider handler langsung) dan vyt/vv (actionAnimeEpisode).
5. `batchTargetLabel` & `targetLabel`: map 3 target.

### Verifikasi
- `node --check` CLEAN (bot.js, vidoy.js)
- `test-vidoy-uploader` **142 pass** (+3), suite lain 0 fail
- semua pemanggil `animeTargetKeyboard` 3 argumen, tidak ada sisa `vt`
