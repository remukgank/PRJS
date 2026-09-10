# Backpressure 2 lapis — UploadBackpressure + DiskGuard (2026-09-09)

## Keputusan
- Adopsi desain 2 lapis dari bot lain, disesuaikan ke PRJS. Config (env):
  `MAX_DOWNLOAD_DISK_GB=45`, `MAX_PENDING_UPLOADS=10`, `DISK_MIN_FREE_GB=5`,
  `DISK_WARN_GB=15`, `BACKPRESSURE_DRY_RUN=0`, `BACKPRESSURE_POLL_MS=30000`.
- Rollout: mulai `BACKPRESSURE_DRY_RUN=1` beberapa jam/hari, pantau
  `[dry-run] would pause`, baru enforce `=0`.

## Audit choke point (pra-approve, temuan kunci)
- Klaim awal "downloadAndSend menutup semua" GUGUR: 8 handler provider di
  `handlers/download.js` kirim masing-masing via `_ctx`, tidak lewat
  `downloadAndSend`.
- Choke point riil (lebih baik): 4 sender `scraper/lib/telegram.js`
  (`sendVideo`/`sendAudio`/`sendDocument`/`sendPhoto`) — seluruh
  `handlers/download.js` (wiring bot.js:226) + `handlers/vidara.js`
  (wiring bot.js:337) + `downloadAndSend` + topic mirrors + poster-sender
  lewat sini. Hook = `track()` di exports, tanpa ubah body.
- Bypass: (a) batch `sendVideoToChannel`/`sendPhotoToChannel` — KEPUTUSAN
  TERKUNCI: `track()` minimal, TANPA re-routing (blast radius kecil di
  jalur paling kritis); (b) poster topic 146/156 di-route ke sender
  (+`message_thread_id` opsional di `sendPhoto`, backward compatible);
  (c) admin shim, (d) kiriman file_id, (e) upload CDN Vidara = gap yang
  diterima dengan alasan tertulis di header modul.

## Verifikasi
- `node --check` 5 file OK; ESLint no-undef 0.
- Functional terisolasi 14/14 (counter, pause/resume dua lapis, notif
  sekali, dry-run, cleanup selektif, kill-switch).
- `require lib/telegram` tetap hanya dari `bot.js` + tests.
