# Audit Cross-Check & Refactor Plan PRJS

**Date**: 2026-09-06
**Author**: hermes (read-only audit, atas permintaan user untuk dicek agent)

## Root Cause / Konteks

Audit struktur kode PRJS (`scraper/`: download konten → kirim ke Telegram & Vidara). Tujuan: cari inkonsistensi, potensi bug, bagian butuh refactor. Output rencana saja, bukan eksekusi. Nol file kode diubah pada tahap ini.

Stack real: Node.js 24, `node-telegram-bot-api`, `pg` (Neon), `pino`, `axios`, `ecc-universal` + `megajs` + `qrcode` (root). Entry point produksi = `scraper/bot.js` (±3794 baris), jalan sebagai proses node langsung. `scraper/index.js` bukan entry — itu library public API dramafren. Infra: FlareSolverr :8191, Local Telegram Bot API :9091 (upload 2GB), CF Worker `gofile-worker.js`. DB: `file_cache` (MD5 URL), `media`, `media_parts` (UNIQUE tanpa `season`), `vidara_uploads`, `bot_settings`.

Scope: PRJS full-akses baca. `fomo-drama/` read-only (cuma cross-check kontrak data, tidak ditulis/diubah). `VDL/` tidak dipakai acuan.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `docs/audit/2026-09-06-audit-crosscheck-refactor-plan.md` | file baru: laporan audit ini (proposal saja, belum implementasi) |
| `scraper/**` | TIDAK DIUBAH (read-only) |
| `fomo-drama/**` | TIDAK DIUBAH (read-only) |

## Temuan

### HIGH

**H1 — `scraper/vidara-uploader.js:96` — kutip literal di curl upload**
- Deskripsi: `uploadFileViaCurl` kirim `-F file=@"${filePath}"` via `execFile` (tanpa shell) → tanda kutip jadi literal di nama file.
- Kenapa masalah: hampir semua judul ada spasi → upload batch Vidara gagal/inkonsisten.
- Severity: high (fix 1 baris, dampak besar).

**H2 — `scraper/bot.js:1338/1346/1353` + `lib/telegram.js:98-` — `file://<file_id>` invalid**
- Deskripsi: `downloadAndSendPaidMedia` pass `cached.file_id` ke `sendVideo/sendAudio/sendDocument`, tapi jalur Local API selalu bungkus `video: file://<input>` → jadi `file://<file_id>` = invalid. Terverifikasi: `bot.js:78` import sender dari `lib/telegram.js`; `bot.js:1323-1355` pass `cached.file_id`.
- Kenapa masalah: cache-hit resend di jalur paid-media (via tombol) rusak saat `TELEGRAM_API_PORT` aktif. Perlu cabang: file_id → kirim mentah, path → `file://`.
- Koreksi scope: klaim awal "semua cache-hit resend rusak" terlalu luas — yang terbukti hanya jalur paid-media via tombol. Jalur teks langsung belum diverifikasi pakai file_id atau path.
- Severity: high.

**H3 — `scraper/vidara.js` (98 baris) — dead code**
- Deskripsi: tidak di-require file manapun (terverifikasi via search: 4 require vidara semuanya ke uploader/handlers, nol ke `vidara.js`). Duplikat `waitForEncoding` vs `vidara-uploader.js:116`. `API_BASE` hardcoded vs readEnv di uploader.
- Kenapa masalah: perbaikan bisa salah sasaran / API drift diam-diam.
- Severity: high.

**H4 — `scraper/bot.js:3772` — `pre_checkout_query` tanpa safeHandler**
- Deskripsi: `message` dan `callback_query` dibungkus `safeHandler` (bot.js:1817), tapi `pre_checkout_query` memanggil handler telanjang.
- Kenapa masalah: throw = unhandled rejection → pembayaran Stars gagal diam-diam.
- Severity: high.

**H5 — `scraper/downloader.js:57` — `downloadStream` tanpa timeout**
- Deskripsi: `execFile(ffmpeg)` tanpa opsi `timeout` dan tanpa `proc.kill`; ffmpeg HLS macet = promise tidak pernah settle, slot concurrency bocor. Kontras `downloadWithAria2c` yang punya `calcAria2cTimeout` + kill, dan `services/vidaraService.js` yang pasang timeout 1–2 jam.
- Severity: high.

**H6 — `scraper/bot.js:3248` — `answerCallbackQuery` tanpa `.catch` (cabang `dell_confirm`)**
- Deskripsi: `return bot.answerCallbackQuery(query.id, ...)` telanjang; semua titik lain sudah `.catch(()=>{})`.
- Kenapa masalah: query kedaluwarsa → throw ke safeHandler → user dapat pesan "Error" generik padahal sudah ter-handle.
- Severity: high.

**H7 — `scraper/bot.js:2228,3613` — `execFileSync('df')` sinkron di jalur request**
- Deskripsi: block event loop tiap cek status; path `/home/runner/workspace` hardcoded.
- Kenapa masalah: pindah host = crash; latency request naik.
- Severity: high.

**H8 — Duplikat merge/concat ffmpeg: `mergeVideos` vs `ffmpegConcat`**
- Lokasi: `downloader.js:154` (dipakai bot.js:1626,1719 untuk merge Telegram) vs `services/vidaraService.js:79` (dipakai handlers/vidara.js:199, vidaraService.js:173 untuk jalur Vidara).
- Kenapa masalah: bug fix di satu sisi tidak menular.
- Severity: high.

### MEDIUM

**M1 — Duplikat `parseDramaUrl` identik (`bot.js:874` vs `batch-download.js:52`)**
- Drift sudah terlihat (normalisasi subdomain cuma di satu sisi). Severity: medium.

**M2 — Tiga jalur kirim video paralel**
- `lib/telegram.js:98 sendVideo` (cached, dipakai bot) vs `batch-download.js:150 sendVideoToChannel` (implementasi sendiri + `tgApi` local-API) vs `bot.sendVideo` mentah di bot.js:2346,3387. Perilaku batas ukuran/cloud vs local API tidak konsisten. Severity: medium.

**M3 — `downloader.js:163` — concat list tanpa escape kutip-satu**
- `file '${p}'` tanpa escape (versi `vidaraService.js:81` sudah escape) → path ber-apostrof merusak merge. Severity: medium.

**M4 — Silent `.catch(()=>{})` di titik simpan state**
- Lokasi: `saveVidaraUpload(...).catch(()=>{})` (handlers/vidara.js:86,131,209), `renameVideo/moveToFolder/waitForEncoding` (vidaraService.js:179-180,253-256), `vidaraCall move/rename` (vidara-uploader.js:56,60).
- Kenapa masalah: upload sukses tapi DB/record gagal = episode dianggap belum upload selamanya, tanpa log. Severity: medium.

**M5 — `handlers/vidara.js:44` — `buildResolveVideoUrl` lempar error mentah**
- `.then(r => r.videoUrl)` tanpa cek `r` null → `TypeError` menutupi akar masalah. Kontras `downloadAndSend` (bot.js:245) yang `.catch` + cek dengan benar. Severity: medium.

**M6 — `bot.js:1240-1261` — `sendPaidMediaVideo` caption di top-level**
- Kontrak Bot API `sendPaidMedia` menaruh caption di `media[0]` (+`parse_mode`). Caption paid-media hilang diam-diam; `star_count` tanpa validasi. Severity: medium.

**M7 — `bot.js:420-595` — method non-standar ke cloud API**
- `sendRichMessage`/`sendDraft` dikirim juga ke `api.telegram.org` saat Local API mati → 404 tanpa guard/fallback. Severity: medium.

**M8 — Double `answerCallbackQuery` (`bot.js:2957` + cabang `ep:/dl:/sam_*`)**
- Answer kosong di awal lalu answer lagi dengan alert → answer kedua rawan "query too old / already answered". Severity: medium.

**M9 — `lib/telegram.js` `sendAudio/sendDocument` buang `parse_mode`**
- Hanya `sendVideo`/`sendPhoto` yang teruskan → caption HTML tampil mentah. Severity: medium.

**M10 — Duplikasi kecil kandidat `lib/`**
- `hashUrl` (md5) bot.js:1070 vs handlers/download.js:23; `fmtSizeMb` vs `formatFileSize` (bot.js:979 vs :1233); `ucShareId` di handlers/download.js:29. Severity: medium.

**M11 — Kontrak data vs fomo-drama (read-only cross-check, tidak ubah fomo)**
- Tidak ada integrasi langsung (DATABASE_URL terpisah, tak ada kode lintas-repo). Tapi skema menyimpang: `scraper/db.js` bikin `UNIQUE(media_slug, part)` tanpa `season`, sedangkan `fomo-drama/handlers/contentHandler.js` pakai `(media_slug, season, part)` + kolom `caption/provider/...`. Kalau disambung ke satu DB: init PRJS tak menambah kolom `season` → query fomo gagal; namespace slug beda → duplikat. Kontak nyata hanya konvensi caption. Severity: medium.

**M12 — `services/saweriaService.js:565,572` — timer polling tidak di-unref**
- `stopAllPolling` (:225) tidak dipanggil dari SIGINT/SIGTERM bot.js:856-863 → proses tidak exit bersih saat pembayaran menggantung. Severity: medium.

**M13 — TMP_DIR terfragmentasi**
- `downloader.js:16` → `~/workspace/downloads` vs `vidara-uploader.js:8` → `<repo>/downloads`. `cleanupOldDownloads` (bot.js:854) hanya bersihkan satu sisi. Severity: medium.

### LOW

**L1 — `services/vidaraService.js:14-34` — redirect tanpa batas**
- `downloadTo` follow redirect tanpa cek `location` ada + tanpa batas redirect → potensi crash/loop. Severity: low.

**L2 — `services/vidaraService.js:93` — salah variabel error**
- Saat re-encode gagal, error yang dilaporkan `err` (copy) bukan `err2` (re-encode) → log menyesatkan. Severity: low.

**L3 — Asimetri quota (catatan SKILL.md)**
- Gofile/pixeldrain via tombol → ada quota check; via teks langsung → TANPA quota check non-admin. By design tapi patut disadari. Severity: low.

**Komposisi bot.js (±3794 baris) — kandidat ekstraksi:** handler `message` (~1100 baris) dan `callback_query` (~800 baris) inline; kandidat modul: `downloadAndSend`, `sendRichMessage/sendDraft/finalizeDraft`, `handleGofileUrl/handlePixeldrain/Filedon/Mega/Gdrive`, keyboard builders, topic-mirror, invoice/payment, disk-check.

## Detail Teknis (verifikasi independen Hermes)

- H2 & H3 diverifikasi ulang manual via search langsung (bukan klaim mentah): H3 valid penuh (nol require ke `scraper/vidara.js`); H2 valid dengan koreksi scope (terbukti di jalur paid-media via tombol, bukan semua cache-hit).
- Yang sudah compliant (tidak jadi temuan): flood-429 retry (`floodRetryMs` + `API_MAX_RETRY`), `PART_SEND_DELAY_MS` 8 dtk antar part, caption slice 1024, `sendInvoice` Stars, `pre_checkout_query` approve via `handlers/admin.js`, guard 2GB vs 49MB, stream-copy → re-encode fallback, `sendPaidMedia` cloud-guard.

## Refactor Plan (usulan urutan, bukan kode)

| Step | Isi | Paralel / Urut | Risiko |
|---|---|---|---|
| R1 | Fix H1 (kutip curl) + H2 (cabang file_id vs path) + H6 (tambah `.catch`) | Paralel (3 file beda, independen) | Rendah — tapi H1+H2 sentuh jalur upload/kirim, wajib functional test kirim beneran |
| R2 | H4 (bungkus pre_checkout) + H5 (timeout downloadStream) + H7 (df async + path dari env) | Paralel antar item, urut setelah R1 | Sedang — H5 ubah hang jadi fail-fast; error baru yang jujur akan muncul |
| R3 | H8 (satukan merge/concat) + M3 (escape concat) + M1 (parseDramaUrl tunggal) | Urut berurutan | Sedang — salah satukan = semua merge rusak; test merge wajib |
| R4 | M6 (caption paid-media) + M7 (guard local-vs-cloud) + M8 (double-answer) + M9 (parse_mode audio/doc) | Paralel antar item | Rendah–sedang, test dengan bot dev |
| R5 | M4 (silent catch → log warn) + M5 (null-check) + L2 (betulkan var error) | Paralel | Rendah — observabilitas; log bertambah |
| R6 | H3 (hapus `scraper/vidara.js`) + M10 (pindah ke `lib/`) + M13 (satukan TMP_DIR) + M12 (unref timer) | Urut setelah R1–R5 hijau | Rendah — pastikan tak ada `require(variable)` dinamis yang luput dari grep statis |
| R7 | M11: tambah kolom `season` + samakan namespace slug — HANYA kalau memang mau satu DB | Terakhir, butuh keputusan user | Tinggi — migrasi skema DB produksi |

Estimasi kasar: R1–R2 quick wins (1 sesi), R3–R4 inti (1–2 sesi), R5–R6 hygiene (1 sesi), R7 opsional.

## Pertanyaan Terbuka (butuh keputusan user, jangan ditebak)

1. R7 (`season` di `media_parts`): apakah PRJS dan fomo-drama memang direncanakan satu DB? Kalau tidak, M11 cukup didokumentasikan.
2. Tiga jalur kirim video (M2): mana yang kanonis — `lib/telegram.js` atau tiap modul punya sender sendiri?
3. Bot jalan tanpa pm2 (proses node langsung saat dicek) — apakah start/stop memang manual via Replit workflow? Nentuin perlu `pm2 save`/`resurrect` atau tidak.
4. Asimetri quota teks-vs-tombol (L3): disengaja atau bug yang mau disamakan?
5. `scraper/vidara.js` (H3): hapus langsung atau arsipkan dulu?
6. Prioritas: R1–R2 dulu (quick wins user-facing) atau R3 dulu (merge path, area flip-flop Vidara)?

## Verification

- Read-only: nol file kode diubah (hanya file laporan ini yang dibuat).
- `node --check` tidak applicable (tidak ada file .js diubah).
- Verifikasi H2/H3 via search + baca source langsung (bukan asumsi nama fungsi).
- Status proposal: menunggu review + approve user sebelum implementasi (sesuai SOP audit-workflow).
