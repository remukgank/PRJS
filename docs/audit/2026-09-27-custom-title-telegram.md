# 2026-09-27 — Judul kustom ("Ganti Judul") diabaikan di jalur Telegram

Proposal: `docs/proposals/2026-09-27-custom-title-telegram.md`

## Masalah

Alur: user kirim link → "✏️ Ganti Judul" → ketik judul → "📥 Download" → pilih
target. Di blok `if (target === 'tg')` (`bot.js:4384-4405`), judul yang diketik
user **tidak pernah** diteruskan. Yang dipakai `detectedTitle` — hasil lookup ke
library. Untuk judul baru itu `null`, sehingga caption jatuh ke nama file mentah.

`titleForCap` sudah benar ada di baris 4381:

```js
const customTitle = takeCustomTitle(url);
const titleForCap = customTitle || detectedTitle || undefined;
```

…tetapi tidak tersambung ke cabang mana pun.

## Klaim awal yang dikoreksi user

User mengoreksi klaimnya sendiri dari "4 dari 6 cabang" menjadi **5**, dan
benar: `gdrive` punya `gdTitle` turunan, jadi hitungannya berbeda. Verifikasi
per-cabang di `bot.js` cocok **persis** dengan nomor baris yang diberikan user:

| Baris | Cabang | Sebelum | Sesudah |
|---|---|---|---|
| 4385 | `handleGofileUrl` | `detectedTitle \|\| undefined` | `titleForCap` |
| 4386–4399 | `handleGdriveUrl` | `let gdTitle = detectedTitle` | `customTitle \|\| detectedTitle` |
| 4401 | `handlePixeldrainUrl` | `detectedTitle \|\| undefined` | `titleForCap` |
| 4402 | `handleFiledonUrl` | `detectedTitle \|\| undefined` | `titleForCap` |
| 4403 | `handleKamenimeUrl` | `titleForCap` | **tidak disentuh** (20ffc4e) |
| 4404 | `handleMegaUrl` | `detectedTitle \|\| undefined` | `titleForCap` |

## Perubahan (1 file: `scraper/bot.js`, hanya blok `target === 'tg'`)

Lima cabang. Logika season/part pada `gdrive` **dipertahankan persis** — hanya
sumber nilai awal `gdTitle` yang berubah. Jalur `vyt`/`vv` tidak disentuh.

## Test: `scraper/tests/test-custom-title-tg.js` (baru, 24 pass)

Membaca `bot.js` **asli** dan mengekstrak blok `target === 'tg'` dengan
penghitung kurung, lalu menjalankannya dengan stub — tidak menyalin logika.

- (a) `customTitle` ada → keenam cabang memakai judul kustom (6 provider)
- (b) tanpa `customTitle` → tetap `detectedTitle` (regresi, 6 provider)
- (c) keduanya `null` → `undefined`, tidak crash (regresi, 6 provider)
- (d) gdrive + judul kustom + season/part dari filename → `S2 P3` menempel
- (d2) judul kustom yang sudah punya `S2` → tidak diduplikasi
- (d3) season tanpa part → season dibuang (quirk pre-existing, lihat bawah)
- penjaga: blok yang diekstrak memang blok `dl_go` (6 handler, tanpa `break`)
- penjaga: cabang kamenime tetap `titleForCap`
- penjaga: tidak ada cabang yang masih meneruskan `detectedTitle` langsung

### Mutasi wajib

| Cabang dimundurkan ke `detectedTitle` | Hasil |
|---|---|
| gofile | 22 pass / **2 fail** |
| pixeldrain | 22 pass / **2 fail** |
| filedon | 22 pass / **2 fail** |
| mega | 22 pass / **2 fail** |
| gdrive | 21 pass / **3 fail** |
| kamenime (tidak seharusnya diubah) | 21 pass / **3 fail** |

## Test existing yang perlu diperbaiki

`tests/test-kamenime-provider.js` gagal — bukan karena perilaku berubah, tapi
karena penanda awal-nya mengunci **teks literal**:

```js
src.indexOf("if (isPixeldrainUrl(url)) return handlePixeldrainUrl(chatId, url, detectedTitle || undefined);")
```

Begitu argumen judul di cabang itu berubah, test gagal padahal guard aslinya
(branch kamenime ada + `resolveDirectUrl` tidak mendahului handler) masih
berlaku. Diperbaiki dengan menganchor ke penanda yang tidak disentuh fix mana
pun: `if (target === 'tg') {` **terakhir**, dibatasi penanda akhir yang sama.

Dua-duanya kelas bug yang sama seperti `test-vidoy-uploader.js`: test yang
mengunci format, bukan perilaku.

Diverifikasi dua arah: kondisi sekarang 26 pass; mutasi menghapus cabang
kamenime → 2 test FAIL.

## Dua kesalahan yang saya buat di test ini

1. **`indexOf` mengambil blok yang salah.** Ada **tiga** blok
   `if (target === 'tg')` di `bot.js` — 3704 dan 4212 ada di dalam loop batch
   Samehadaku/Kuronime (mengandung `break`/`continue`), sedangkan yang
   diperlukan yang ketiga di `dl_go`. Gejala: `Illegal break statement`.
   Sekarang `lastIndexOf` + test penjaga yang menolak blok berisi `break`.
2. **Saya mengunci asumsi yang salah di (d3).** Test awal saya menuntut season
   ditambahkan saat `part` null. Kenyataannya tidak — lihat quirk di bawah.
   Test ditulis ulang untuk mendokumentasikan perilaku yang **sebenarnya**.

## Quirk yang ditemukan dan sengaja TIDAK diperbaiki (di luar scope)

`bot.js:4393`:

```js
const hasP = gdsCb.part ? new RegExp(`\\bP${gdsCb.part}\\b`).test(gdTitle) : true;
if (!hasS && !hasP) gdTitle = `${gdTitle} S${gdsCb.season}${gdsCb.part ? ` P${gdsCb.part}` : ''}`;
else if (hasS && !hasP) gdTitle = `${gdTitle} P${gdsCb.part}`;
```

Kalau `gdsCb.part` null → `hasP = true` → kedua cabang `!hasP` bernilai false
→ **season dibuang diam-diam**. File `…S4.1080p.mp4` (tanpa part) akan punya
judul tanpa `S4`.

Ini **pre-existing** dan proposal ini eksplisit melarang menyederhanakan logika
season/part, jadi tidak saya ubah. Test (d3) mengunci perilaku yang ada dan
memastikan ia tidak berubah diam-diam. Perbaikan perlu proposal terpisah.

## Suite

```
TOTAL 403 pass / 0 fail   (semua file exit 0)
test-custom-title-tg       24 pass / 0 fail   (baru)
test-kamenime-provider     26 pass / 0 fail
test-dell-vdell-logging    11 pass / 0 fail
test-logger-terminal-keys   8 pass / 0 fail
test-vidoy-uploader       157 pass / 0 fail
```

Naik dari 379 → 403. Tidak ada test lama yang jadi gagal.

Dicualikan (butuh network/aria2c): `test-rich.js`, `test-rich-direct.js`,
`test-all-subdomains.js`, `test-watchdog-aria2c.js`.
