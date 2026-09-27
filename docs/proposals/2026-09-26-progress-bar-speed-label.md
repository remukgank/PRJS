PROPOSAL — Progress bar: tampilkan ukuran terkumpul + kecepatan agar user tahu host lambat, bukan bot macet
Konteks: sesi opencode ses_f9e5474c9ffeoRyJV5yyQ1DI7m. File ini = isi proposal, baca langsung.

MASALAH (verified dari logs/app.log, JSON, msg="download progres")
Samehadaku Naruto ep 5, 26 Sep 2026 23:33-23:47 UTC:
  23:42:48  mb 29.6  kbps 93    totalMb null  etaSec null
  23:43:18  mb 31.7  kbps 63
  23:44:18  mb 36.1  kbps 41
  23:45:28  mb 39.6  kbps 29
  23:46:38  mb 43.7  kbps 36
  23:46:48  mb 43.7  kbps  0
  23:46:55  err "download macet - 0 byte selama 20 dtk"  (watchdog kill, working as designed)
  23:46:57  ensureMp4 gagal - retry dengan URL fresh
Progress naik monotonik 29.6 -> 43.7 MB, tidak nol progres. Tapi bar di Telegram diam
karena tidak ada total (gdriveplayer dl.php tidak kirim Content-Length, Range diabaikan).

AKAR MASALAH
scraper/lib/progress.js - RichProgress.updateLabel() hanya render persen + durasi.
Kalau totalMb/etaSec null, tidak ada yang ditampilkan selain waktu berjalan, sehingga
user melihat "6:48" dan menyimpulkan macet.

FAKTA TAMBAHAN (probe 26 Sep 2026, tidak perlu diimplementasikan - untuk konteks)
- Episode 5 server: reupload.org/83k61ncpo0f7 (200 tapi cuma 3.331 byte HTML, bukan video)
  + gdriveplayer (yang lambat/mati). Tidak ada host cepat lain.
- Watchdog di scraper/downloader.js sudah bekerja benar (kill 23:46:55). Jangan diubah.
- Jalur tg dan vyt sama-sama pakai ensureMp4(directUrl) - baris 256. Ganti target tidak
  membantu kecepatan; hanya ganti server.

SCOPE - 1 file
scraper/lib/progress.js, fungsi RichProgress.updateLabel() (dan pemanggilnya hanya
sebagai readonly untuk memastikan sumber mb/kbps sudah tersedia).

ITEM
1. Total/ETA tidak diketahui -> tampilkan byte terkumpul + kecepatan:
   "37.6 MB - 60 KB/s" di samping durasi. Sumber: field mb & kbps yang sudah ada di
   baris log download progres. Teruskan dari pemanggil; jangan hitung ulang.
2. kbps di bawah ambang speed floor -> pakai konstanta yang sudah ada (jangan tulis
   angka 70 magic di file lain), tambahkan label "host lambat" -
   contoh "43.7 MB - host lambat 36 KB/s".
3. Total diketahui -> PERTAHANKAN persen + ETA persis seperti sekarang (additive).
4. kbps null/0 -> jangan render bagian speed, tidak crash.

WAJIB
1. node --check scraper/lib/progress.js
2. scraper/tests/test-media-contract.js tetap hijau (RichProgress bukan caption, kontrak
   4 baris caption tidak boleh tersentuh)
3. Test baru minimal 3 kondisi, print output-nya sebagai bukti:
   - totalMb null + kbps normal -> "MB - KB/s" tanpa percent
   - totalMb known -> percent + ETA identik dengan sebelum
   - kbps null atau 0 -> tidak ada speed, tidak crash
4. LOG di docs/audit/2026-09-26-progress-bar-speed-label.md

DI LUAR SCOPE - jangan sentuh
scraper/downloader.js, scraper/handlers/download.js, scraper/bot.js, gofile-worker.js,
provider apa pun, jangan restart pm2/proses (user yang restart).
