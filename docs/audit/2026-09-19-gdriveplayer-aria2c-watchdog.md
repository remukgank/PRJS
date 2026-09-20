# Audit: GDrivePlayer tersangka "terminated" + Watchdog aria2c (stall & speed floor)

- **Tanggal**: 2026-09-19
- **File terdampak**: `scraper/downloader.js`, `scraper/handlers/download.js`, `scraper/bot.js`
- **Test**: `scraper/tests/test-watchdog-aria2c.js` (5 skenario, semua PASS)
- **Status**: implementasi + verifikasi selesai; **belum di-commit** (tunggu E2E live + konfirmasi)

## Root cause (dari bug report 2026-09-18)

`err:"terminated"` pada download ep15 Dragon Ball Heroes **bukan dari downloadWithAria2c** —
itu pesan khas **undici fetch** saat server gdriveplayer menutup koneksi mid-stream.
Timeline membuktikan: download mulai 23:36:30, gagal 23:43:20, bot restart 23:43:41
(selisih 21 detik) → proses yang gagal adalah build fetch-streaming lama di memori PID 167,
yang sudah di-revert. Build aria2c ikut gagal juga untuk ep15 (`exitCode 1`, `avg 21 KiB/s`,
`ERR`) karena server-nya lambat/mati — bukan karena kode.

## Verifikasi nyata (bukan asumsi)

1. **fileSize tidak feasible**: download.php (2.8KB) tanpa info size; `HEAD dl.php` → 200 tanpa
   Content-Length; `Range: bytes=0-0` diabaikan → `Transfer-Encoding: chunked`. Server sengaja
   menyembunyikan ukuran → `calcAria2cTimeout(undefined)` = MAX 20 menit.
2. **Backpressure tidak kill**: `scraper/lib/backpressure.js:252-280` hanya sleep/poll, tanpa
   proc.kill/SIGTERM. Satu-satunya SIGTERM di codepath = timeout `downloader.js`.
3. **statSync(outPath).size TIDAK bisa jadi proxy progres**: probe nyata — 120MB di host
   Range-supporting + `-x4 -s4` → ukuran file **penuh di t=0.5s**, padahal download selesai
   di t=16s (segmen terakhir ditulis duluan). Watchdog berbasis size = salah-positif di CDN.
4. **Kualitas 360p bukan bug**: ep15 samehadaku hanya punya 1 tombol G-Drive → download.php
   hanya 1 dl.php (360p). 720p di tabel = host Zippyshare/Racaty. Token menentukan kualitas.
5. **Readout aria2c format (host chunked)**: `[#gid 12MiB/0B CN:1 DL:12MiB]` — downloaded
   bytes (angka sebelum `/`) monotonik & host-agnostic. Sumber progres yang benar.

## Perubahan

### scraper/downloader.js
- Signature: `downloadWithAria2c(url, outPath, onLog, extraHeaders = {}, fileSizeOrOpts = {})` —
  arg-5 bisa opts `{fileSize, disableSpeedFloor}` atau angka legacy (typeof check).
- Arg baru: `--summary-interval=10` agar baris readout rutin tiba di mode piped.
- **Watchdog** (`ARIA2C_WATCHDOG_MS` 15s), sumber = downloaded bytes parse dari readout
  (`/\[#[0-9a-f]+\s+([\d.]+)\s*([KMGT]?)i?B\//`, prefix/i opsional — `512B/` pun ter-track):
  - **Stall** (selalu aktif, termasuk paid): downloaded tak bertambah > `ARIA2C_STALL_FREEZE_MS`
    (90s) setelah `ARIA2C_STALL_MIN_RUN_MS` (30s) → SIGTERM → `server stuck — nol progres 90 detik`.
  - **Speed floor** (dapat dimatikan `disableSpeedFloor`): rata-rata trailing 90s <
    `ARIA2C_SPEED_FLOOR_BPS` (70 KiB/s) setelah >90s & ≥5 MiB → SIGTERM →
    `server terlalu lambat (rata-rata <70 KiB/s selama 90 detik)`.
  - Heartbeat `masih download, N MB terkumpul` tiap 60s (agar user tidak melihat diam).
- `killReason` guard: timeout & watchdog tidak double-kill; close handler `clearTimeout` +
  `clearInterval(watchdog)`, log `aria2c killed` menyertakan `signal` (tak ada misteri SIGTERM).
- `proc.on('error')` juga `clearInterval(watchdog)`.

### scraper/bot.js:1405 (paidMedia)
- `downloadWithAria2c(..., { fileSize, disableSpeedFloor: true })` — user berbayar tidak kena
  salah-positif speed floor; stall watchdog tetap aktif.

### scraper/handlers/download.js (branch gdriveplayer catch)
- Kirim pesan ke user saat GDrivePlayer gagal: `⚠️ GDrivePlayer gagal: <err>\nServer
  GDrivePlayer lambat/error — ulangi lagi nanti ⏳, atau pilih host lain…`

## Verifikasi

- `node --check` pada 3 file: PASS.
- `scraper/tests/test-watchdog-aria2c.js` (server lokal, `downloadWithAria2c` asli):
  1. Chunked (gdriveplayer-like) 32MB → selesai 6.9s, `DL: 4.9MiB/s` parsed. PASS
  2. Range+paralel (CDN) 24MB → selesai, tanpa false-impact. PASS
  3. Silent host → **killed 91s**, msg `server stuck — nol progres 90 detik`. PASS
  4. Slow 46KiB/s → **killed 120s**, msg `server terlalu lambat (rata-rata 46 KiB/s…)`. PASS
  5. Slow + `disableSpeedFloor` → melewati fase lambat, selesai (tidak di-kill). PASS

## Catatan / batasan

- Kode yang sama (`downloadWithAria2c`) dipakai gofile/pixeldrain/filedon/mega —
  watchdog & speed floor berlaku semua; threshold konservatif (70 KiB/s) → CDN sehat tidak kena
  (kasus bagus gdriveplayer = 1.8 MB/s).
- Tak menyentuh: `remuxToMp4`, gdriveplayer resolve, `lib/backpressure`, provider lain,
  `hokidrama/**`, `start.sh`, `.pm2/**`, `.replit`.
- Belum di-commit: audit doc & test ditulis setelah implementasi sesuai alur
  (proposal → approve → implement → verifikasi → **E2E live → commit setelah konfirmasi**).