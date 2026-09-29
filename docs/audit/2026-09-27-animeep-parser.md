# 2026-09-27 — Nomor episode jalur direct provider ditebak dari nama file

## Masalah

Di blok `dl_go` jalur vyt/vv untuk direct provider (`bot.js`, sekitar 4705),
nomor episode ditebak dari nama file:

```js
const animeEp = extractPartFromFilename(fileName || '') || 1;
```

`extractPartFromFilename` (`lib/parser.js`) memakai `/(\d{1,3})\s*$/` — angka
4 digit terpotong jadi 3 digit terakhir. Eksekusi nyata:

```
naruto-episode-1234.mp4              → 234    (benar 1234)
one-piece-1180.mp4                   → 180    (benar 1180)
[Horizon] One Piece - 1050 [1080p]    → 1      (ambil "1080" dari "1080p")
OP-933-FULLHD-SAMEHADAKU.VIP.mp4     → 1      (benar 933)
TsSDKMGnoKh-FULLHD-SAMEHADAKU.CARE.mp4 → 1    (benar, tidak ada episode)
```

## Verifikasi cakupan jalur

Enam pemanggilan `actionAnimeEpisode` di `bot.js`, lima di antaranya dapat ep
dari sumber yang sudah tahu nomornya:

| Baris | Sumber ep | Status |
|---|---|---|
| 3741 | `e.ep` (listing kamenime) | ✓ |
| 3988 | `e.ep` (listing samehadaku) | ✓ |
| 4497 | `e.ep` (listing kuronime) | ✓ |
| 4191 | `sameInfoG.episode` (parser URL) | ✓ |
| 4317 | `kurInfoG.episode` (parser URL) | ✓ |
| 4705 | `extractPartFromFilename(fileName)` | ✗ satu-satunya yang menebak |

Dampak di data: **nol**. Part 150–200 semuanya masuk lewat picker
(07:30–08:01 UTC 27 Sep), bukan lewat tebakan ini. Jadi tidak ada record salah
yang perlu dibetulkan — Ep 1 yang bermasalah sebelumnya sudah diperbaiki
terpisah.

## Perbaikan (2 baris + 1 destructure)

`resolveProviderTitle()` sudah memanggil `parseSamehadakuFilename(fileName)`
dan hasilnya (`gds`) dipakai untuk cari judul di DB — lalu dibuang. Sekarang
dikembalikan:

```js
// resolveProviderTitle
return { detectedTitle, fileName, gds };

// blok direct provider (hanya 4657, bukan 4625 — scope minimal)
const { detectedTitle, fileName, gds } = await resolveProviderTitle(url);
const animeEp = (gds && gds.episode) || extractPartFromFilename(fileName || '') || 1;
```

Menambah `gds` ke return tidak merusak 4625: destructure mengabaikan field
tambahan, dan 4625 memang tidak diubah.

Diverifikasi: `parseSamehadakuFilename('OP-933-FULLHD-SAMEHADAKU.VIP.mp4')`
→ `episode=933`. Untuk `one-piece-1180.mp4` dan `naruto-episode-1234.mp4` ia
mengembalikan `episode=null` — jadi fix ini **parsial**: kasus Samehadaku
FULLHD benar, kasus 4-digit generik masih jatuh ke tebakan lama.

## Yang TIDAK diubah (out of scope, perlu approval terpisah)

Regex `/(\d{1,3})\s*$/` di `lib/parser.js:63`. Memperbaikinya menyentuh 3 jalur
lain yang sekarang benar, dan bisa menggeser episode. Ditunda sesuai proposal
user.

## Test: `scraper/tests/test-animeep-parser.js` (baru, 7 pass)

Baris `const animeEp` dibaca dari `bot.js` **asli setiap test berjalan (lazy)**,
lalu dijalankan dengan `gds` + `fileName` yang disuntik — tidak menyalin logika.

Kasus: `gds.episode` dipakai (933); fallback saat `gds` null (45); fallback
saat `gds.episode` null (7); fallback ke 1 (tidak crash); `gds` 1180
mengalahkan tebakan 180; penjaga baris asli; penjaga `return gds`.

### Mutasi wajib

Baris dikembalikan ke `extractPartFromFilename(fileName || '') || 1`:
**6 FAIL jelas, 1 pass**. Satu-satunya yang pass adalah test
`return gds` — benar, karena mutasi tidak menyentuh return.

### Kesalahan test yang diperbaiki

Versi pertama mengekstrak baris saat **load file** (di luar queue). Saat mutasi,
marker tidak ditemukan → `assert` throw saat load → **crash tanpa jejak FAIL**.
Output mutasi kosong. Diperbaiki jadi lazy per-test, sehingga mutasi
menghasilkan FAIL berpesan, bukan crash.

---

## Insiden: `ReferenceError: gds is not defined` (19:17 UTC, produksi crash)

### Yang terjadi

Setelah fix di atas di-deploy (working tree, belum commit), **semua callback
yang lewat `resolveProviderTitle` crash**:

```
19:17:39 ERROR Unhandled error in callback handler
  ReferenceError: gds is not defined
    at resolveProviderTitle (bot.js:1328:37)
```

### Akar cause — dua lapis

**Lapis 1 (saya):** saya mengubah `return { detectedTitle, fileName }` jadi
`return { detectedTitle, fileName, gds }`, padahal `gds` dideklarasikan sebagai
`const gds` **di dalam** blok `if (!detectedTitle) { … }`. Di luar blok itu,
nama tersebut tidak ada → `ReferenceError`.

**Lapis 2 (saya juga):** saat memperbaiki, `oldString` saya (`if
(!detectedTitle) {` + `const gds = …`) ternyata cocok di **dua** tempat —
`resolveProviderTitle` (~1318) dan message handler (~3322). Tool edit tidak
menolak, dan hasilnya:

- 1319 tetap `const gds` → menutupi `let gds`, return selalu `null`
- 3359 berubah dari `const gds` menjadi bare `gds =` → assignment ke global
  (atau throw kalau strict)

Keduanya salah dan saling menutupi. Diperbaiki dengan konteks yang membedakan
(`const pat =` vs `const pattern =` di baris sekitarnya).

### Kenapa test tidak menangkap

- `test-animeep-parser.js` hanya mengekstrak **baris `const animeEp`** dan
  menjalankannya terisolasi — tidak pernah memanggil `resolveProviderTitle`
  yang asli.
- Test "return gds" hanya memeriksa **teks sumber** mengandung return itu,
  bukan bahwa `gds` terdefinisi di scope tersebut.
- `node --check` lolos (syntactic). `test-internal-imports.js` lolos (itu
  modul import, bukan variabel blok).

Tiga lapis verifikasi, semuanya buta terhadap bug ini.

### Test baru yang menutupnya

`gds dideklarasikan di scope fungsi, bukan hanya di dalam blok`:

- `let gds = null;` harus ada di scope fungsi
- tidak boleh ada `const gds = parseSamehadakuFilename` di dalam (shadowing)

Mutasi (kembalikan `const` di dalam): **7 pass / 1 fail**. Pulih: 8 pass.

### Pelajaran proses

1. **`edit` dengan `oldString` pendek di file 5000+ baris berbahaya.**
   Selalu sertakan konteks pembeda, atau verifikasi jumlah kemunculan
   (`rg -c`) SEBELUM dan SESUDAH edit.
2. **Restart pm2 tidak berarti apa-apa kalau bot jalan di luar pm2.**
   `pm2 list` kosong sementara `ps` menunjukkan `node scraper/bot.js`
   (pid 26849, sejak 19:14:29). Restart pm2 saya "berhasil" tapi tidak
   menyentuh proses yang sebenarnya. Solusinya: kill pid itu, start ulang
   lewat pm2 (`prjs-bot`, pid 27579, online).
3. Suite sekarang **516 pass / 0 fail**.
