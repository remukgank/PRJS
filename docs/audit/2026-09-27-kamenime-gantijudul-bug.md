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
