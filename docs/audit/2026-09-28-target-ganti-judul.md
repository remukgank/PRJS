# Audit — Target picker untuk "Ganti Judul" (provider langsung)

**Tanggal:** 2026-09-28
**Tag:** `v3.3.4` (patch — memperbaiki perilaku tidak konsisten; kontrak callback & keyboard tidak berubah)
**Proposal:** `docs/proposals/2026-09-28-target-ganti-judul.md`
**Status:** sudah diimplementasikan, **belum di-deploy** (menunggu restart + verifikasi manual)

## 1. Keluhan

Ochi, 28 Sep 22:43:

```
> https://drive.usercontent.google.com/download?id=1APT8QPCKvF9oQ3t92FQLnaK4u8w2qg7r&export=download&authuser=0
> One Piece
> 📥 Download dengan judul: One Piece
> ✅ One Piece — Selesai
> 📊 1 episode · 239 MB · 1✓
> Total: 1 episode · 239 MB · Berhasil 1 · ⏱️ 00:22
```

Link gdrive → "Ganti Judul" → ketik judul → bot **langsung mengunduh dan mengirim
ke Telegram**. Target picker (Telegram / Vidoy+TG / Vidoy) tidak pernah muncul.

Bukti file: `OP-933-FULLHD-SAMEHADAKU.VIP.mp4`, 250.632.859 byte = 239,0 MB —
cocok dengan angka hasil Ochi.

```
isGdriveUrl(url)       : true
resolveGdriveFile(url) : OK 1331ms → name OP-933-FULLHD-SAMEHADAKU.VIP.mp4
                                      size 250632859
```

## 2. Root cause (terverifikasi di kode)

`scraper/bot.js` blok "Pending download: custom title input" (baris 2556-2582):

```
2564  gofile     → handleGofileUrl(...)      LANGSUNG unduh
2565  pixeldrain → handlePixeldrainUrl(...)  LANGSUNG unduh
2566  gdrive     → handleGdriveUrl(...)      LANGSUNG unduh   ← yang dipakai Ochi
2567  filedon    → handleFiledonUrl(...)     LANGSUNG unduh
2568  kamenime   → rememberCustomTitle + animeTargetKeyboard(...)   ← satu-satunya benar
2582  mega       → handleMegaUrl(...)        LANGSUNG unduh
```

Komentar di baris 2569-2570 **sudah menjelaskan niat yang benar** — penerapannya
hanya di kamenime. Lima provider lain tidak. Ini inkonsistensi terhadap komentar
yang sudah ada di kode, bukan keputusan desain.

### 2.1 Konsekuensi §6

Jalur ini tidak pernah menanyakan target, jadi kode PRJS tidak bisa membuat
"hanya Telegram" untuk provider langsung di menu Ganti Judul.

### 2.2 `opts` di `handleGdriveUrl` tidak pernah dipakai

```
scraper/handlers/download.js
  async function handleGdriveUrl(chatId, url, customTitle = null, opts = {})
  opts. → 0 kemunculan di dalam fungsi
```

Bukti tambahan bahwa jalur "pilihan target" belum dirancang untuk handler ini.

## 3. Yang diubah

### `scraper/bot.js`

**a) Blok custom title (baris 2556-2590)** — 6 cabang jadi 1 jalur:

```js
{
  rememberCustomTitle(pending.url, customTitle);
  const urlId = cacheUrl(pending.url);
  const vidoyOk = !isMegaUrl(pending.url);
  const label = PENDING_HANDLER_LABEL[pending.handler] || pending.handler;
  return bot.sendMessage(chatId, `📥 <b>${label}</b>\n\n➧ Judul :- <b>${escHtml(customTitle)}</b>\n\nPilih target:`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: animeTargetKeyboard(
        `dl_go:tg:${urlId}`, `dl_go:vyt:${urlId}`, `dl_go:vv:${urlId}`, { vidoyOk }) } });
}
```

**b) `animeTargetKeyboard`** — TIDAK diubah. Versi pertama fix ini menambahkan
parameter `opts.vidoyOk` untuk menyembunyikan tombol Vidoy di mega; Ochi
memperbaiki bahwa itu asumsi tanpa trace dan meminta semua provider konsisten.
Parameter itu sudah dihapus lagi — fungsi kembali persis seperti semula.

**c) `PENDING_HANDLER_LABEL`** (baru) — label provider untuk pesan "Pilih target".
Sengaja tidak disatukan dengan label di `dl_title_use:` (baris ~4653) karena nilai
kamenime di sana `hokireceh` dan itu bagian dari kontrak caption §5 AGENTS.md.

### Test

- baru: `scraper/tests/test-target-ganti-judul.js` (20 test)
- diperbarui: `scraper/tests/test-kamenime-provider.js` (test q & u mengunci
  struktur cabang lama yang sengaja dihapus; intensi keduanya tetap dijaga)

## 4. Mega: asumsi saya salah, sudah dikoreksi Ochi

Versi pertama fix ini menyembunyikan tombol Vidoy untuk mega. **Ochi menolak:
"harusnya semuanya wajib ada Telegram | Vidoy + TG | Vidoy ... trace jalurnya
jangan asumsi."**

Trace yang benar (`scraper/handlers/vidoy.js` `actionAnimeEpisode`):

```js
const { target, title, ep, sameInfo, directUrl, episodeUrl, silent } = opts || {};
const ok = await ensureMp4(directUrl, destPath, { resolveFresh: ... });
```

Jalur Vidoy butuh `directUrl` (URL HTTP) untuk `ensureMp4`. Mega memang tidak
punya URL HTTP — `resolveMegaFile()` mengembalikan `{ name, size, file }` dengan
`file` = objek `mega.File` untuk streaming. Terbukti:

```
gdrive → OK url=https://... (1310ms)
mega   → NULL (tidak support Vidoy) (1ms)
```

**Tapi itu KETERBATASAN JALUR `vyt`/`vv`, bukan alasan menyembunyikan tombol.**
`handleMegaUrl` sudah download ke `outPath` (file lokal) — jadi file-nya ada,
yang tidak ada hanya URL-nya. Menyembunyikan tombol membuat user tidak punya
pilihan dan errornya tidak terlihat; lebih baik tombolnya ada dan kalau gagal,
errornya muncul.

Koreksi yang diterapkan: `opts.vidoyOk` dan parameter `opts` di
`animeTargetKeyboard` **dihapus lagi**. Semua provider dapat 3 tombol yang sama.
Yang tersisa hanya komentar yang mencatat keterbatasannya.

## 5. Bukti run — keyboard produksi benar-benar dijalankan

Fungsi `animeTargetKeyboard` diekstrak dari `bot.js` dan **dijalankan** dengan
`BTN` tiruan, bukan hanya dibaca:

```
=== gdrive (vidoyOk default) ===
  row: 📥 Telegram
  row: 📥 Vidoy + TG   |   📥 Vidoy
  callback : dl_go:tg:1, dl_go:vyt:1, dl_go:vv:1

=== keenam provider ===
gofile/pixeldrain/gdrive/filedon/mega/kamenime: 3 tombol, semua aktif
  callback : dl_go:tg:<id>, dl_go:vyt:<id>, dl_go:vv:<id>
  tidak ada tombol disabled untuk provider mana pun

semua: rows=2 primary=1(max1) shapeOK=true styleOK=true VidoyNonaktif=false
callback_data max byte: 11 (batas Telegram 64)
```

Dua hal yang dipelajari saat run:

1. `animeTargetKeyboard` memanggil `require('./vidoy-uploader')` **di dalam
   fungsi** → `new Function` gagal dengan `require is not defined`. Harus
   disuntikkan lewat `Module.createRequire`.
2. `Vidoy.isConfigured()` mengembalikan **false** di shell biasa dan **true**
   dengan env bot (`set -a; . /run/replit/env/latest; set +a`). Verified:
   `false` → kosong, `true` → dengan env. Test wajib dijalankan dengan env bot,
   kalau tidak semua tombol Vidoy terlihat nonaktif dan testnya salah).

Empat test (17-20) mengunci hasil run ini, termasuk shape §4 AGENTS.md:
`inline_keyboard` = array of row, maks 1 `primary`, `style` hanya
`primary/success/danger`.

## 6. Hasil test

```
test-target-ganti-judul    19 / 0   (baru, 4 di antaranya menjalankan fungsi produksi)
test-picker-halaman       167 / 0
test-picker-prefix         12 / 0
test-media-key-konsisten   15 / 0
test-kamenime-batch        11 / 0
test-kamenime-provider     26 / 0
test-speed-floor-batas     15 / 0
test-folder-vidoy-kunci    12 / 0
test-vidoy-uploader       157 / 0
test-media-contract        10 / 0
test-preview-judul-resolusi 11 / 0
test-sam-picker-pagination 7 lulus
test-sam-prescan           lulus
test-dell-vdell-logging    11 / 0
-----------------------------------------------------------------
TOTAL                    466 pass / 0 fail
```

`test-vidoy-listing` tidak dijalankan di suite ini — 9 fail-nya **pre-existing**
(dibuktikan `git stash`, sudah tercatat di audit picker halaman).

## 7. Mutasi — 8 dari 8 tertangkap

```
MUTASI TERTANGKAP : 8 / 8
LOLOS (test buta) : 0
```

Script: `.hermes/cache/scratch/mutasi_target.sh`

| # | mutasi | hasil |
|---|---|---|
| M1 | blok custom title langsung unduh gdrive | TANGKAP (18/2) |
| M2 | judul kustom tidak disimpan | TANGKAP (19/1) |
| M3 | tombol Vidoy dihapus dari keyboard | TANGKAP (19/1) |
| M4 | mega dikecualikan (tombol Vidoy dimatikan) | TANGKAP (18/1) |
| M5 | tombol Vidoy hilang dari keyboard | TANGKAP (17/2) |
| M6 | keyboard salah bentuk (bukan array of row) | TANGKAP (`node --check`) |
| M7 | `PENDING_HANDLER_LABEL` jadi dead code | TANGKAP (18/2) |
| M8 | `takeCustomTitle` tidak menghapus judul | TANGKAP (`node --check`) |

### Dua bug di script mutasi (bukan di test) — keduanya ditemukan karena angka "LOLOS" illogical

**Run pertama melaporkan 4 dari 8 lolos.** Setelah diperiksa, keempatnya **tidak
pernah ter-apply**: `assert s.count(old) == 1` gagal (`pattern 0x`) karena indentasi
salah di pola, tapi script tetap melanjutkan dan mencatat `LOLOS`. Jadi angka itu
palsu — test-nya sendiri sebenarnya baik.

Perbaikan: `cek()` sekarang membandingkan `bot.js` dengan backup (`cmp -s`).
Kalau file identik, mutasi tidak ter-apply dan script **berhenti** dengan pesan
"script salah" — bukan dianggap sebagai "test buta".

**Koreksi Ochi atas asumsi saya** (versi pertama fix): saya menyembunyikan
tombol Vidoy untuk mega berdasarkan `resolveDirectUrl` yang null. Itu asumsi
tanpa trace jalur. Mutasi M4 sekarang mengunci kebalikannya — kalau ada
pengecualian per provider, test gagal.

Pelajaran: hasil mutasi yang berbeda dengan "LOLOS" harus selalu diverifikasi bahwa
mutasinya benar-benar mengubah kode. Ini masalah yang sama seperti test yang
menyalin definisi — pengukuran yang terlihat benar tapi tidak mengukur apa pun.

## 8. Verifikasi manual (WAJIB — belum dilakukan)

1. Kirim link gdrive → **Ganti Judul** → ketik judul → **harus muncul 3 tombol**
   target. Tidak langsung unduh.
2. Pilih **Telegram** → file terkirim ke Telegram, **tidak** masuk Vidoy.
3. Ulangi, pilih **Vidoy** → file masuk Vidoy, tidak terkirim Telegram.
4. Ulangi untuk link **mega** → harus dapat 3 tombol sama seperti provider lain
   (koreksi Ochi — tidak ada tombol yang disembunyikan per provider).
5. Pastikan tidak ada `✅ ... Selesai` sebelum tombol ditekan.

Bot **belum di-restart** — kode belum aktif di proses yang sedang jalan.

## 9. Di luar scope (dilaporkan, tidak dikerjakan)

- `handleGdriveUrl` punya parameter `opts` yang tidak dipakai — tempatnya kalau
  nanti perlu "hanya Vidoy tanpa Telegram". Tidak ada kebutuhannya sekarang.
- `test-vidoy-listing` 9 fail pre-existing.
- `sam_all` (samehadaku) hanya cek `media_parts`, tidak pernah `vidoy_uploads`,
  jadi tidak konsisten dengan `kam_allgo` yang menggabungkan keduanya.
- Label Naruto 1-398 (`vidoy_uploads` ada, `media_parts` kosong) — backfill
  `media_parts` agar label jadi `✅ library` bukan `📨 Telegram saja`.
