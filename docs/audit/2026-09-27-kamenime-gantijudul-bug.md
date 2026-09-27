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

---

## 6. Judul kustom tidak otomatis terdeteksi (tanya user)

**Pertanyaan user:** "jika aku pernah ganti Judul otomatis kedeteksi kan ya selanjutnya?"

**Jawaban (terverifikasi): TIDAK** — dan itu bug.

**Root cause:** `handleKamenimeUrl` menyimpan `source_pattern` dari
`extractSourcePattern(kmName)`, yaitu dari **nama file**:

```
extractSourcePattern("Naruto Shippuden-episode-1.mp4")   → "Naruto Shippuden-episode-1"
extractSourcePattern("Naruto Shippuden-episode-2.mp4")   → "Naruto Shippuden-episode-2"
```

Nomor episode ikut masuk pola. `findMediaByPattern` cocoknya PERSIS
(`LOWER(source_pattern) = LOWER($1)`), jadi judul yang diketik di episode 1
**hanya berlaku untuk episode 1**. Episode 2–500 akan meminta ganti judul lagi.

Bandingkan samehadaku yang nama filenya ber-kode pendek:
`extractSourcePattern("[samehadaku] NS 720p ep (5).mkv")` → `"ns"` — satu pola
untuk semua episode. Itulah kenapa samehadaku jalan dan kamenime tidak.

`getSetting('libsimpan')` = `on`, jadi judulnya **tersimpan**; yang bermasalah
hanya pola pencocokannya.

**Fix:** helper `kamenimeSourcePattern(url)` — pola dari **URL anime**, tanpa
nomor episode. WAJIB dipakai di DUA tempat yang sama:

| tempat | fungsi | peran |
|---|---|---|
| `handlers/download.js` `handleKamenimeUrl` | simpan | menulis `source_pattern` |
| `bot.js` `resolveProviderTitle` | cari | membaca untuk judul terdeteksi |

Kalau simpan pakai pola A tapi cari pola B, judul kustom tidak akan pernah
terdeteksi.

**Normalisasi (bug kedua yang ketemu saat verifikasi).** Bentuk URL dua macam
menghasilkan pola berbeda:

```
/storage/anime/Naruto%20Shippuden/... → "naruto shippuden"  (spasi)
/anime/naruto-shippuden/episode/1    → "naruto-shippuden"  (strip)
```

Ternyata **tidak sama**. Tanpa normalisasi, pencarian dari satu bentuk tidak
menemukan penyimpanan dari bentuk lain. `norm()` kini: lowercase, spasi/underscore
→ strip, buang karakter lain, rapikan strip berulang dan di tepi.

Hasil — 16 URL (2 bentuk × 8 nomor) → **satu pola**:

```
/storage/ ep 1,5,500  → "naruto-shippuden"
/anime/   ep 2,7     → "naruto-shippuden"
= sanitizeSlug("Naruto Shippuden")  ✓   (kunci library ikut sinkron)
```

## 7. Verifikasi pola

Test (v) & (w) → `test-kamenime-provider.js` **24 pass / 0 fail** (dari 22).
Suite penuh **243 pass / 0 fail**.

| mutasi | hasil |
|---|---|
| hapus normalisasi spasi → strip | 23 pass / **1 fail** (v) — 2 pola berbeda |
| `/storage/` dinormalisasi单独 | 23 pass / **1 fail** (v) — "naruto shippuden" vs "naruto-shippuden" |
| `resolveProviderTitle` kembali ke `extractSourcePattern` | 23 pass / **1 fail** (w) |

## 8. Efek untuk pengguna

Setelah deploy: ganti judul **sekali** di episode mana pun → episode 2, 3, 4
sampai 500 otomatis memakai judul itu, tanpa asks ulang. Tombol "✏️ Ganti Judul"
masnya muncul hanya kalau judul belum pernah disimpan.

---

## 9. Koreksi versi: v4.0.0 → v3.2.0

User Challenged: "kok tinggi banget udah v4".

**Saya salah.** `v4.0.0` melanggar semver: provider kamenime adalah **fitur
baru**, bukan perubahan yang mematahkan kontrak.

Bukti dari repo sendiri — `v3.0.0 → v3.1.0` juga MINOR padahal memuat fitur
baru `!dell` + tombol picker berwarna. Komenime Dummynez kategori yang sama.

Tidak ada kontrak yang patah: kontrak media (caption 4 baris,
`supports_streaming`, topic Anime), format `callback_data`, dan bentuk
`inline_keyboard` tetap sama.

**Tindakan:** `v4.0.0` dihapus (lokal + remote, tidak ada konsumen), diganti
`v3.2.0`.

**Pelajaran:** aturan "tag proporsional" sudah tertulis tapi saya sendiri salah
memakainya. Ironis — aturan itu dibuat karena kesalahan serupa sebelumnya.
Karena itu tabel Versions & tags (§3a) sekarang ditulis di AGENTS.md dengan
**penentu eksplisit** (ada yang rusak atau tidak), bukan sekadar daftar jenis
perubahan.

---

## 10. Caption target Vidoy salah (judul = nama file, provider = "anime")

**Dilaporkan user:**

```
➧ Judul :- Naruto Shippuden-episode-1.mp4
➧ Episode :- 1
➧ Provider :- anime
➧ Link :- vski.cc/e/wyb5t825ie3z
```

Harapan: `Naruto Shippuden` + `hokireceh`.

**Kedua masalah hanya di jalur `vyt`/`vv`** — jalur `tg` sudah benar karena
memakai `titleForCap` dan `buildCaption`.

### 10.1 Judul = nama file

```js
const animeTitle = detectedTitle || fileName || 'Anime';
```

`detectedTitle` null (belum ada di DB) → jatuh ke `fileName` =
`"Naruto Shippuden-episode-1.mp4"`. Nama file mentah, bukan judul anime.

Selain itu `titleForCap` (judul kustom dari "Ganti Judul") **tidak dipakai**
di jalur ini sama sekali — jadi judul kustom hilang begitu user memilih Vidoy.

**Fix:** helper `kamenimeTitleFromFileName()` membuang sufiks episode + ekstensi:

```
"Naruto Shippuden-episode-1.mp4"   → "Naruto Shippuden"
"Naruto Shippuden-episode-500.mp4" → "Naruto Shippuden"
"Black Torch-ep-12.mp4"            → "Black Torch"
```

Prioritas judul di `vyt`: `titleForCap → detectedTitle → kmTitle → fileName`.

### 10.2 Provider = "anime"

`actionAnimeEpisode` mengambil `sameInfo?.provider || 'anime'`, dan `dl_go`
mengoper `sameInfo: null` → caption generik `"anime"`.

`sameInfo` hanya dipakai untuk season/part (vidoy.js:214) dan provider
(vidoy.js:284) — aman diisi.

**Fix:** `sameInfo = isKamenimeUrl(url) ? { provider: 'hokireceh' } : null`

## 11. Verifikasi

Test (x) → **25 pass / 0 fail** (dari 24). Suite penuh **244 pass / 0 fail**.

| mutasi | hasil |
|---|---|
| judul `vyt` kembali ke `fileName` mentah | 24 pass / **1 fail** (x) |
| `sameInfo` kembali `null` (provider "anime") | 24 pass / **1 fail** (x) |

---

## 12. Cross-check yang saya lakukan setelahnya (permintaan user)

User: "_provider juga udah di bahas kok nguawur banget ya lo bisa lebih teliti
selalu cross cek".

Saya vérifier ulang **secara fungsional**, bukan membaca kode:

1. **Scope `titleForCap`** — deklarasi baris 4362, blok `vyt` baris 4398 → satu
   scope, aman.
2. **Round-trip urlCache** — disimulasikan nyata:
   `cacheUrl(url)` → `resolveUrl(id)` → string **identik** untuk kedua bentuk
   URL; `customTitleMap.get()` mengembalikan judul kustom. ✓
3. **Caption akhir jalur vyt** — disimulasikan dengan 4 kasus:

| kasus | Judul | Provider | Link |
|---|---|---|---|
| A. judul kustom (kasus user) | `Judul Kustom User` | `hokireceh` | ✓ |
| B. tanpa judul kustom | `Naruto Shippuden` (dari file) | `hokireceh` | ✓ |
| C. judul dari DB | `Naruto Shippuden` | `hokireceh` | ✓ |
| D. **regresi** (provider tak dipatch) | `Judul Kustom User` | `anime` | ✓ |

Kasus D sengaja dimasukkan: membuktikan test benar-benar menguji, bukan sekadar
lolos.

4. **Bug tambahan yang ketemu:** `customTitleMap` tidak pernah dibersihkan kalau
   user batal → bocor. Diganti `rememberCustomTitle()` (TTL 1 jam + batas 500
   entri, mengikuti `urlCache`) dan `takeCustomTitle()` (sekali pakai).

## 13. Test yangernah lolos tanpa menangkap mutasi

Ini masalah penting. Test (x) versi pertama **hanya menghitung caption memakai
fungsi replikasi saya sendiri**, bukan kode `bot.js` sungguhan. Hasilnya: saat
`bot.js` dimutasi (judul kustom dihapus, provider dikosongkan), test **tetap
hijau** — 26 pass / 0 fail.

Test yang menguji replikasinya sendiri tidak berguna. Test (x) sekarang
memverifikasi dua lapis:

- **fungsional**: caption yang dihasilkan benar 4 baris, judul benar, provider
  benar, tidak ada `undefined`
- **wiring**: `bot.js` benar-benar memakai `titleForCap → detectedTitle →
  kmTitle`, `sameInfo.provider = 'hokireceh'`, dan meneruskan `sameInfo`

Setelah itu ketiga mutasi tertangkap:

| mutasi | sebelum | sesudah |
|---|---|---|
| judul kustom dihapus dari vyt | 26 pass / **0 fail** ✗ | 25 pass / **1 fail** ✓ |
| provider `hokireceh` dihapus | 26 pass / **0 fail** ✗ | 25 pass / **1 fail** ✓ |
| `takeCustomTitle` tidak hapus (bocor) | 25 pass / **1 fail** ✓ | 25 pass / **1 fail** ✓ |

Pelajaran tambahan: **test atas kode yang tidak dijalankan ke jalur aslinya
hanya membuktikan replikasinya benar**, bukan aplikasi-nya. Kalau yang diuji
adalah hasil yang dilihat user (caption), testnya harus lewat kode yang
dipakai bot sungguhan.

---

## 14. ReferenceError: kamenimeTitleFromFileName is not defined

**Waktu**: 27 Sep 2026, setelah commit `c7572ff` (cross-check caption vyt).

### Gejala

User tes ulang di Telegram. Bot crash sebelum selesai:

```
09:10:52  Callback received  · data=dl_go:vyt:3
09:10:54  ERROR Unhandled error in callback handler  · chatId=-1004431872926
          ReferenceError: kamenimeTitleFromFileName is not defined
            at scraper/bot.js:4414:23
```

### Akar cause

`c7572ff` memakai `kamenimeTitleFromFileName(...)` di `dl_go` (blok vyt), tapi
**nama itu tidak pernah di-import**. Import-nya saya coba tambahkan lewat
script Python yang menyisipkan beberapa blok sekaligus; script itu **gagal di
tengah** pada assertion, jadi blok pertamanya pun tidak pernah tersimpan:

```python
s2 = s.replace(IMPORT_LAMA, IMPORT_BARU)   # <-apply di memori
s3 = s2.replace(BLOK_VYT_LAMA, BLOK_VYT_BARU)
assert s3 != s2, 'blok vyt tidak berubah'   # <- GAGAL di sini
open(path,'w').write(s3)                     # <- tidak pernah dijalankan
```

Jadi perbaikannya setengah jadi: pemanggilan terpasang, import tidak.

### Kenapa tidak ketahuan lebih awal

- `node --check` **LOLOS**. Syntax check hanya memastikan token valid, bukan
  bahwa identifier-nya terdefinisi.
- Test caption (x) yang saya buat sebelumnya hanya memeriksa *call site*
  (`titleForCap` dipakai atau tidak), **tidak** memeriksa apakah nama itu
  benar-benar ter-import.
- Suite tetap hijau: 245 pass / 0 fail.

### Perbaikan

`scraper/bot.js:21` — tambahkan `kamenimeTitleFromFileName` ke import
`providers/kamenime`.

### Test baru: `scraper/tests/test-internal-imports.js`

Menutup kelas bug ini untuk **semua** modul internal, bukan hanya kamenime:

1. Semua modul internal berhasil dipetakan (38 modul, 123 nama ter-import).
2. Fungsi `providers/kamenime` yang dipakai bot.js ter-import dari modul itu.
3. Nama yang dipanggil di bot.js yang bentrok dengan export modul internal
   **harus** deklarsi lokal (wrapper) atau ter-import — kalau tidak,
   `ReferenceError` saat runtime.
4. Nama yang di-import dari modul internal memang ada di `module.exports`-nya.

Butuh 4 lapis parser supaya tidak ada false positive. Yang sempat keliru saat
menulis test:

- Sweep `^\s{2}(\w+)[,:]` menyapu object literal → `target` dsb. ikut dianggap
  export. → kini hanya blok `module.exports = {…}`.
- `key: value` (`{ logger: appLogger }`) nama publiknya **key**, bukan nama
  variabel.
- Komentar berisi `(` tak berpasangan ("// … (lihat") merusak penghitung
  depth → nama export palsu `tak`. → komentar dibuang sebelum analisis.
- `(?<!:)//` agar `'https://…'` tidak ikut terpotong.
- Teks di dalam string/template literal ikut terpindai (`upload` dari
  `` `Ep ${ep} — upload (…)` ``) → string literal dibuang.
- Nama yang bentrok dengan export modul tapi dipakai sebagai method
  (`_vidoyHandlers.actionAnimeEpisode(`) harus diabaikan; nama yang punya
  wrapper lokal (`handleKamenimeUrl` di `bot.js:1504`) juga sah.

### Bukti test benar (mutasi)

Cabut `kamenimeTitleFromFileName` dari import → 2 test FAIL dengan pesan
`dipakai tapi TIDAK di-import`. Pulihkan → 4 pass / 0 fail.

Sesuai aturan repo: test yang mengunci asumsi salah lebih berbahaya dari tidak
ada test, jadi mutasi wajib dijalankan, bukan diasumsikan.

### Catatan soal urutan kerja

Commit `c7572ff` sudah di-push sebelum bug ini ketahuan.

