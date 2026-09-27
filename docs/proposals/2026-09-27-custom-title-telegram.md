PROPOSAL FINAL — judul di preview: pakai edit kalau ada, kalau tidak pakai judul asli dari nama file
Konteks: sesi opencode ses_f9e5474c9ffeoRyJV5yyQ1DI7m. File ini = isi proposal.
Saya (Hermes) sudah trace sendiri seluruh jalur. Agent: baca, implement, WAJIB laporkan
hasil run — bukan klaim dari baca kode (AGENTS.md §4).

═══════════════════════════════════════════════════
CATATAN PENTING — JANGAN UBAH LABEL 'hokireceh'
═══════════════════════════════════════════════════
Proposal versi sebelumnya saya menyebut 'hokireceh' sebagai bug. Itu SALAH —
saya tarik kembali. 'hokireceh' adalah keputusan user (commit 17f3ea4), dipakai
sengaja sebagai label tampilan provider, dan ada test yang menguncinya
(test-kamenime-provider.js:358-373, 502-520). JANGAN diubah ke 'kamenime'.
Key internal dispatch TETAP 'kamenime' (pendingDownloads, kamenimeEpisodeMap).
Untuk kasus ini label tidak perlu disentuh sama sekali.

═══════════════════════════════════════════════════
MASALAH 1 — judul di preview tidak pernah memakai judul hasil ketikan
═══════════════════════════════════════════════════
customTitleMap di-key by URL LENGKAP (bot.js:46):
  customTitleMap.set(url, { title, ts: Date.now() });
takeCustomTitle(url) (bot.js:48-51) menghapus entri — destruktif, sekali pakai.

Tiga prompt judul + satu preview, empat perlakuan berbeda:

[1] bot.js:3243-3265 — entry URL kamenime /storage/...mp4 langsung
      const km = await resolveKamenimeFile(text.trim());
      const kmName = km.fileName;
      const detectedTitle = await findMediaByPattern(extractSourcePattern(kmName));
      const titleShown = detectedTitle ? detectedTitle.nama : null;
      Kalau tidak ada di library → titleShown = null
      → prompt: "📥 Kamenime Download\nFile: …\nPilih judul untuk caption:"
      Tombol label = titlePromptKeyboard(kmName, url, null) → pakai fileName mentah
      BUKAN: kamenimeTitleFromFileName(kmName) yang sudah ada dan benar.

[2] bot.js:3505-3525 — kam_ep:<id> picker episode (500 episode)
      const { detectedTitle, fileName } = await resolveProviderTitle(episodeUrl);
      const dTitle = detectedTitle ? detectedTitle.nama : null;
      editMessageText: "📥 Kamenime\nFile: …\nPilih judul untuk caption:"
      titlePromptKeyboard(fileName || 'video.mp4', episodeUrl, dTitle)
      BUKAN: kamenimeTitleFromFileName(fileName)
      → inilah yang user lihat untuk episode 2. Judul episode 1 TIDAK bisa
        dipakai di sini: key-nya URL episode 1, sedangkan ini URL episode 2.
        Itu perilaku yang benar, bukan bug — jangan mencoba menyinkronkan.

[3] bot.js:4350-4358 — preview "📥 Download" setelah judul dipilih
      const titleShown = detectedTitle || fileName || 'file';
      takeCustomTitle(url) dipanggil baris 4380 — SESUDAH preview ini.
      → judul kustom yang sudah diketik TIDAK muncul di preview.

[4] bot.js:4384-4405 — blok target === 'tg'
      handleGofileUrl / handleGdriveUrl / handlePixeldrainUrl / handleFiledonUrl /
      handleMegaUrl semua mengirim `detectedTitle`, bukan titleForCap.
      handleKamenimeUrl (4406) SUDAH BENAR pakai titleForCap — jangan diubah.

STATUS PER CABANG (sudah saya cek baris per baris — jangan kerjakan kamenime lagi)
  4385  handleGofileUrl      detectedTitle   ← BUG
  4390  gdTitle = detectedTitle (tanpa kustom) ← BUG
  4399  handleGdriveUrl       gdTitle         ← BUG
  4401  handlePixeldrainUrl   detectedTitle   ← BUG
  4402  handleFiledonUrl      detectedTitle   ← BUG
  4406  handleKamenimeUrl     titleForCap     ← SUDAH BENAR (commit 20ffc4e)

═══════════════════════════════════════════════════
ATURAN YANG DIINGINKAN USER (sederhana, ini inti)
═══════════════════════════════════════════════════
"kalau ada edit (judul hasil ketikan) maka pakai edit, kalau tidak ada edit
 maka pakai judul asli" — judul asli diambil dari nama file dengan suffix
episode dibuang. kamenimeTitleFromFileName sudah melakukan itu:
  "Naruto Shippuden-episode-2.mp4" → "Naruto Shippuden"

Prioritas di SETIAP prompt/preview:
  1. customTitle        (dari takeCustomTitle / rememberCustomTitle)
  2. detectedTitle      (dari library, kalau ada)
  3. kamenimeTitleFromFileName(fileName)   ← judul asli, KAMENIME SAJA
  4. fileName           (fallback terakhir)

Langkah 3 hanya untuk kamenime. Provider lain (gofile/gdrive/pixeldrain/
filedon/mega) TIDAK boleh berubah — nama file mereka sudah berbentuk metadata.

SCOPE — 1 file: scraper/bot.js
Empat blok, semuanya alur link provider langsung:
  a) 3243-3265  prompt judul (entry URL kamenime)
  b) 3505-3525  prompt judul (kam_ep picker)
  c) 4350-4358  preview "📥 Download"
  d) 4384-4405  blok target === 'tg' (ganti detectedTitle → titleForCap,
                KECUALI kamenime di 4406 yang sudah benar)
JANGAN sentuh: handlers/download.js, providers/, logger.js, downloader.js,
vidaraService.js, gofile-worker.js, titlePromptKeyboard (hanya pemanggilnya),
takeCustomTitle/rememberCustomTitle (implementasinya), perintah !dell/!vdell.

ITEM
1. Di (a), (b), (c): pakai urutan 4 prioritas di atas. Untuk (a) dan (b) custom
   title belum ada (user belum mengetik) → yang dipakai langkah 2-4.
   Untuk (c) customTitle SUDAH ada → harus dipakai.
2. Di (d): ganti argumen judul dari `detectedTitle` ke `titleForCap` pada
   gofile, gdrive, pixeldrain, filedon, mega. KAMENIME (4406) jangan diubah.
3. Gdrive (4387-4402): gdTitle = (customTitle || detectedTitle) lalu
   PERTIHANKAN seluruh logika season/part yang sudah ada. Jangan menyederhanakan.
4. takeCustomTitle() destruktif — pastikan tidak consumption ganda antara (c)
   dan (d). Kalau perlu, ambil sekali dan simpan di variabel bersama.
5. Jangan ubah perilaku download/upload/caption. Ini soal judul yang tampil.

WAJIB — dan ini yang paling penting
AGENTS.md §4: "Klaim dari baca kode BUKAN hasil run."

1. node --check scraper/bot.js
2. Test baru test-preview-judul-resolusi.js, minimal 8 kasus, PRINT output nyata:
   a) entry URL kamenime, judul tidak ada di library
      → prompt memuat "Naruto Shippuden" (dari kamenimeTitleFromFileName),
        BUKAN hanya "Pilih judul untuk caption" tanpa judul
   b) entry URL kamenime, judul ADA di library → judul library yang tampil
   c) kam_ep picker, judul tidak ada di library → judul asli tampil
   d) kam_ep picker, judul ADA di library → judul library yang tampil
   e) preview setelah Ganti Judul → judul kustom yang tampil, bukan nama file
   f) preview tanpa Ganti Judul, library kosong → judul asli (langkah 3)
   g) provider lain (gofile) → PERILAKU TIDAK BERUBAH (regresi wajib)
   h) tidak ada judul sama sekali → fallback ke fileName, tidak crash
   MUTASI wajib (tanpa ini test tidak berarti):
     - kembalikan titleShown ke `detectedTitle || fileName` → test HARUS gagal
     - kembalikan satu cabang tg ke `detectedTitle` → test HARUS gagal
     - HAPUS langkah 3 (kamenimeTitleFromFileName) → test HARUS gagal
3. Test WAJIB membaca bot.js asli (bukan menyalin logikanya) — seperti
   test-dell-vdell-logging.js. Dan WAJIB menjalankan takeCustomTitle/
   rememberCustomTitle dengan store sungguhan, karena itu destruktif.
4. BUKTI RUN (bukan klaim): jalankan kamenimeTitleFromFileName untuk minimal
   3 nama file nyata, print hasilnya:
     "Naruto Shippuden-episode-2.mp4" → harus "Naruto Shippuden"
     "One Piece-episode-1050.mp4"      → harus "One Piece"
     "Bleach-episode-1.mp4"           → harus "Bleach"
   Kalau tidak bisa dijalankan, katakan begitu — jangan menyatakan sebagai fakta.
5. Suite penuh tetap hijau (379 pass + test baru). Test (q) dan (x) yang
   mengunci 'hokireceh' TIDAK boleh diubah atau dihapus.
6. LOG di docs/audit/2026-09-27-custom-title-telegram.md — catat bahwa label
   'hokireceh' disengaja, dan bahwa judul kustom memang tidak bisa lintas
   episode (key = URL) sehingga itu bukan bug.

DI LUAR SCOPE
handlers/, providers/, logger.js, downloader.js, vidaraService.js,
gofile-worker.js, titlePromptKeyboard, takeCustomTitle, !dell/!vdell,
label 'hokireceh', jangan restart proses.
