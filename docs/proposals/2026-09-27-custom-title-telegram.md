PROPOSAL — judul kustom ("Ganti Judul") diabaikan di jalur Telegram (4 dari 6 cabang)

Konteks: sesi opencode ses_f9e5474c9ffeoRyJV5yyQ1DI7m. File ini = isi proposal.

MASALAH 1 — judul kustom diabaikan di preview (bot.js:4350-4358)
User kirim link → "✏️ Ganti Judul" → ketik judul → preview "📥 Download" TETAP
menampilkan nama file mentah, bukan judul yang diketik.
  4350  const { detectedTitle, fileName } = await resolveProviderTitle(url);
  4355  const titleShown = detectedTitle || fileName || 'file';   ← BUG
  takeCustomTitle(url) baru dipanggil di baris 4380 (blok dl_go:, SESUDAH preview)
  → preview sama sekali tidak tahu judul kustom.
  Bukti dari user: ketik "Naruto Shippuuden" → tampil "Naruto Shippuuden-episode-2.mp4"

MASALAH 2 — label provider salah (bot.js:4354)
  const provider = ... : isKamenimeUrl(url) ? 'hokireceh' : ...
  'hokireceh' adalah domain milik user, TIDAK ada hubungannya dengan kamenime.
  Bot harus men_provider 'kamenime'. Caption dan picker harus konsisten, kalau
  tidak maka caption != provider di sumber lain.
  (Asal: commit 17f3ea4 "Ganti Judul + label provider hokireceh" — labelnya
  masuk ke tempat yang salah.)

MASALAH 3 — judul kustom diabaikan di jalur Telegram (bot.js:4384-4405)
Di blok `dl_go:` (target === 'tg'), judul kustom TIDAK dipakai; hanya
`detectedTitle` (lookup library, null untuk judul baru → nama file mentah).

Bukti kode (baris 4377-4381 — titleForCap sudah benar, tapi tidak tersambung):
  const { detectedTitle, fileName } = await resolveProviderTitle(url);
  const customTitle = takeCustomTitle(url);
  const titleForCap = customTitle || detectedTitle || undefined;   // ada, benar
  ...
  if (target === 'tg') {
    if (isGofileUrl(url))     return handleGofileUrl(chatId, url, detectedTitle || undefined);
    ...                                                                          ^^^^ BUG

Harus: `titleForCap` (kustom || detected).

STATUS PER CABANG (sudah saya cek baris per baris — jangan kerjakan kamenime lagi)
  4385  handleGofileUrl      detectedTitle   ← BUG
  4399  handleGdriveUrl       gdTitle         ← BUG (gdTitle = detectedTitle, tanpa kustom)
  4401  handlePixeldrainUrl   detectedTitle   ← BUG
  4402  handleFiledonUrl      detectedTitle   ← BUG
  4403  handleKamenimeUrl     titleForCap     ← SUDAH BENAR (commit 20ffc4e), jangan diubah
  4404  handleMegaUrl         detectedTitle   ← BUG

Untuk gdrive (4399): gdTitle diturunkan dari detectedTitle lalu dipoles season/part.
Perbaikannya: mulai dari customTitle || detectedTitle, JAGA semua logika season/part
yang sudah ada. Jangan menyederhanakan.

SCOPE — 1 file: scraper/bot.js
Tiga tempat, semuanya di alur link provider langsung:
  a) baris 4350-4358  (preview "📥 Download" + label provider)  → Bug 1 + Bug 2
  b) baris 4384-4405  (blok `if (target === 'tg')`)             → Bug 3
JANGAN sentuh: jalur vyt/vv (sudah benar), takeCustomTitle, resolveProviderTitle,
handlers/, provider, perintah !dell/!vdell, logger.js.

ITEM
1. (Bug 1) Preview: ambil customTitle sebelum menyusun preview, lalu
     const titleShown = customTitle || detectedTitle || fileName || 'file';
   PENTING: takeCustomTitle() adalah KONSUMPTIF (menghapus nilai dari store) —
   pastikan tidak consumption ganda: preview memakainya sekali, lalu blok dl_go:
   memakainya lagi. Periksa implementasinya; kalau memang destruktif, ambil
   sekali di awal dan simpan ke variabel yang dipakai kedua tempat.
2. (Bug 2) Ganti 'hokireceh' → 'kamenime' di baris 4354. Jangan sentuh label lain.
3. (Bug 3) Ganti argumen judul di 5 cabang tg dari detectedTitle menjadi
   titleForCap: gofile, gdrive, pixeldrain, filedon, mega.
   KAMENIME (4403) SUDAH BENAR — jangan diubah.
4. Gdrive: gdTitle = (customTitle || detectedTitle), lalu PERTIHANKAN logika
   season/part yang sudah ada persis. Jangan menyederhanakan.

WAJIB
1. node --check scraper/bot.js
2. Test baru test-custom-title-tg.js, minimal 7 kasus, PRINT hasilnya:
   a) Bug 1: customTitle ada → preview menampilkan judul kustom, bukan nama file
   b) Bug 1 regresi: customTitle null + detectedTitle ada → detectedTitle
   c) Bug 1 regresi: keduanya null → fileName, tidak crash
   d) Bug 2: URL kamenime → label provider = 'kamenime' (bukan 'hokireceh')
   e) Bug 3: customTitle + target tg → handleXxx menerima custom (bukan detected)
   f) Bug 3 regresi: keduanya null → undefined, tidak crash
   g) gdrive + customTitle + season di filename → season/part tetap menempel
   MUTASI wajib (tanpa ini test tidak berarti): kembalikan satu cabang ke
   detectedTitle, dan 'kamenime' ke 'hokireceh' → test HARUS gagal.
3. Test harus membaca kode bot.js asli (bukan menyalin logikanya) — seperti
   test-dell-vdell-logging.js. Dan wajib menguji takeCustomTitle sebagai nyata
   (store ikut), karena Bug 1 + Bug 3 sama-sama memakainya.
4. Suite penuh tetap hijau (379 pass + test baru)
5. LOG di docs/audit/2026-09-27-custom-title-telegram.md — catat asal Bug 2
   (commit 17f3ea4) dan bahwa preview adalah tempat kedua yang butuh customTitle.

DI LUAR SCOPE
handlers/, providers/, logger.js, downloader.js, vidaraService.js, gofile-worker.js,
perintah !dell/!vdell, jangan restart proses.
