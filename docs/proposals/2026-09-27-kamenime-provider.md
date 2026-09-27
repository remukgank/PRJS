PROPOSAL — Provider kamenime: direct .mp4, 22 MB/s ( Emergency: gdriveplayer 40 KB/s)

Konteks: sesi opencode ses_f9e5474c9ffeoRyJV5yyQ1DI7m. File ini = isi proposal, baca langsung.

MASALAH
Host gdriveplayer (server anime dari samehadaku) sedang sekarat: 40 KB/s lalu 0,
18 menit untuk 43,7 MB, 3× retry sia-sia, 65 MB terbuang. Sudah-CEKLAM commit
e632358 + ca1f013 (speed floor + fail-fast) tapi itu hanya MEMBATAS, tidak
menyelamatkan. User butuh sumber yang benar-benar cepat.

Kamenime = sumber alternatif. Probe 26 Sep 2026 (verified):
  https://www.kamenime.com/anime/naruto-shippuden/episode/1
  -> HTTP 200, 155.751 bytes HTML
  -> <source src="/storage/anime/Naruto Shippuden/Naruto Shippuden-episode-1.mp4">
  -> file: 121.331.884 bytes (115,7 MB) dalam 5,4 detik = 22,4 MB/s
  -> signature ftyp isom (MP4 valid)
  -> Range diabaikan (200, bukan 206) — sama seperti gdriveplayer
  -> TIDAK ada Content-Length, TIDAK ada Accept-Ranges
22,4 MB/s = ±550× lebih cepat dari gdriveplayer. Tidak perlu remux (sudah MP4).

SCOPE — 4 file
1. scraper/providers/kamenime.js  (BARU)
2. scraper/bot.js
3. scraper/handlers/download.js
4. scraper/tests/test-kamenime-provider.js (BARU)
Plus docs/audit/2026-09-27-kamenime-provider.md

TRACE SUDAH DILAKUKAN — titik yang harus disentuh, Don't rediscover
Provider files: gofile, pixeldrain, filedon, mega, gdrive, gdriveplayer,
                kuronime, ucdrive, samehadaku, reelfren, dramafren
Cek: tidak ada isXUrl() yang cocok kamenime.com → BOT SEKARANG MENOLAK link
     dengan "Link tidak dikenali" (bot.js:3190). Tidak ada tabrakan provider.

Entry point di scraper/bot.js (6 titik):
  2906  blok isKuronimeUrl(text)  → butuh isKamenimeUrl untuk 2 bentuk URL
  3190  pesan "Link tidak dikenali" → tambah kamenime ke teks
  4168  pendingDownloads handler  (dl_title_custom)
  4178  provider label            (label "Provider :-")
  4205-4223  dl_go:tg dispatch     (5 cabang if, tambah 1)
  4227  resolveDirectUrl(url)      (dipakai target vyt/vv)

Di scraper/handlers/download.js (1 titik wajib):
  1095  resolveDirectUrl()  → cabang kamenime
  TIDAK perlu sentuh downloadSamehadakuFile (942) — kamenime bukan server
  dari picker samehadaku, ini URL mandiri.

ITEM
1. providers/kamenime.js — dua fungsi,WAJIB dua bentuk URL:
   isKamenimeUrl(url)  -> true untuk:
     - https://www.kamenime.com/storage/...mp4     (URL final, TANPA request)
     - https://www.kamenime.com/anime/<slug>/episode/<N>
   resolveKamenimeFile(url) -> { fileUrl, fileName, size? }
     - bentuk /storage/ : return { fileUrl: url, fileName: basename } TANPA
       request tambahan. PENTING: ini harus instan.
     - bentuk /anime/<slug>/episode/<N> : 1 GET ke halaman episode, parse
       <source src="...">, resolve jadi URL absolut (encode spasi).
     - decode HTML entity di src (&amp; dll)
2. handlers/download.js resolveDirectUrl(): tambah 1 cabang, return { url, name }
   (pola sama gofile/pixeldrain — vidaraService sudah punya jalur ini).
3. bot.js: 6 titik di atas. Telegram butuh handler kecil; ikuti pola
   handleFiledonUrl (paling sederhana di download.js). Caption HARUS 4 baris
   persis sesuai kontrak media.
4. Urutan guard: isKamenimeUrl WAJIB dicek SEBELUM isGdrivePlayerUrl di semua
   dispatcher. JEBAKAN: download.js:968 memaksa ekstensi .ts —
     const gpName = /\.ts$/i.test(gpBase) ? gpBase : `${gpBase}.ts`;
   Kalau kamenime salah masuk ke jalur gdriveplayer, file MP4 akan dinamai .ts
   dan remuxToMp4 dipanggil. Ini bug, bukan sekadar gagal.

WAJIB
1. node --check semua file yang berubah
2. test suite penuh tetap hijau (saat ini 219 pass). Termasuk:
   - test-media-contract.js (kontrak caption 4 baris)
   - test-downloadto-speed-floor.js
   - test-ensure-mp4-path.js
3. Test baru test-kamenime-provider.js, minimal 5 kasus, PRINT output:
   a) /anime/naruto-shippuden/episode/1 → resolve ke URL .mp4 yang benar
   b) /storage/...-episode-1.mp4 → fileUrl === input, TANPA request network
   c) URL bukan kamenime → isKamenimeUrl() false (anti-tabrakan, test semua
      provider lain: gofile, pixeldrain, filedon, mega, gdrive, gdriveplayer,
      kuronime)
   d) halaman tanpa <source> → error jelas, bukan diam
   e) MUTASI: ubah sementara guard supaya kamenime masuk jalur gdriveplayer,
      test HARUS gagal (buktikan urutan guard benar-benar dipaksakan)
4. Bukti: print episodes/resolve untuk 3 URL nyata (episode/1, episode/500,
   bentuk /storage/) — jangan hanya claims "masih jalan".
5. LOG di docs/audit/2026-09-27-kamenime-provider.md, termasuk tabel kecepatan
   kamenime vs gdriveplayer dengan angka probe.

DI LUAR SCOPE — jangan sentuh
scraper/downloader.js, scraper/services/vidaraService.js, gofile-worker.js,
provider lain (gofile/pixeldrain/filedon/mega/gdrive/gdriveplayer/kuronime/
samehadaku/ucdrive/reelfren/dramafren), jangan restart proses (user yang restart).

TIDAK DI SCOPE sekarang — listing 500 episode
Halaman /anime/naruto-shippuden cuma 37 KB dan tidak berisi daftar episode.
Episode list diambil via Livewire AJAX (wire:click="toggleVideo"), butuh
calling endpoint Livewire — pekerjaan terpisah dan lebih besar. JANGAN
kerjakan sekarang; cukup per-episode.
