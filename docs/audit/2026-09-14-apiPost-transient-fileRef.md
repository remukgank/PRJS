# apiPost Transient Retry + Route file_id Sends via Lib Sender

**Date**: 2026-09-14
**Author**: opencode

## Root Cause

Lanjutan dari `2026-09-14-transient-retry-telegram-upload.md`: audit call-site Telegram API menemukan
jalur kirim yang belum lewat layer terpusat `lib/telegram.js`, sehingga tidak mendapat retry transient:

1. `apiPost` (lib/telegram.js) — hanya retry flood 429; `sendPaidMediaVideo` (bot.js) yang
   memanggil `apiPost` langsung tidak dapat retry transient.
2. Kirim ulang via **file_id** masih `bot.sendVideo/Audio/Document` langsung (4 call site) →
   bypass retry & bypass backpressure accounting.

Empat jalur `file_id`:

| Line (bot.js) | Sebelum | Sesudah |
|---|---|---|
| 2448 | `bot.sendVideo(chatId, file.file_id, …)` | `sendVideo(…)` |
| 2475/2477/2479 | `bot.sendAudio/sendVideo/sendDocument(dfile.file_id, …)` | lib senders |
| 3500 | `bot.sendVideo(chatId, file.file_id, …)` | `sendVideo(…)` |

Catatan desain wajib: branch apiPost di sender lama **hardcode** `file://${filePath}` — akan
merusak `file_id` bila diteruskan (Local Bot API mengangap `file://<fileid>` sebagai path). Maka:

- Satu helper `toLocalFileRef(filePath)` di lib: path lokal (dimulai `/`, `\`, `./`, `../`) →
  prefix `file://`; `file://`, `http(s)://`, `attach://`, dan **file_id** → dikirim apa adanya.
- Dipakai oleh `sendVideo`/`sendAudio`/`sendDocument`/`sendPhoto` (semua sender lib) DAN
  `sendPaidMediaVideo` (bot.js).

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/lib/telegram.js` | helper `toLocalFileRef`; apiPost tambah retry transient (kuota 2, backoff 3 s, counter terpisah dari flood); 4 sender pakai `toLocalFileRef`; export |
| `scraper/bot.js` | import `toLocalFileRef`; `sendPaidMediaVideo` pakai `toLocalFileRef`; 4 call site file_id → lib senders |
| `scraper/tests/test-telegram-apiPost-fileRef.js` (baru) | unit `toLocalFileRef` (8); stub HTTP: apiPost transient recover/habis/non-transient; sendVideo local-leg payload path→`file://` & file_id→raw |

## Detail Teknis

- apiPost signature bertambah `_transient` (default 2). Floyd: `_retry-1` (perilaku lama).
  Transient: `_transient-1`, `_retry` tidak disentuh. Non-retryable → reject langsung.
- **Double-layer lokal diterima (keputusan user, tanpa refactor pindah-branch):** di Local
  API, `withUploadRetry` (cloud-leg) + apiPost (local-leg) masing-masing retry transient
  sampai 2. Worst-case reject ≈ 21 s (bukan 14 s) pada blip jarang — dibahas, diterima.
- `sendPhoto` local-leg ikut `toLocalFileRef` (bagian "semua sender"); bonus: poster flow
  lib jadi aman untuk file_id/URL.
- Poin 3 (poster `bot.sendPhoto` di library.js:121-123, bot.js:3482) = **TUNDA**; poin 4
  (batch-download.js) = **DITOLAK** (di luar scope user).

## Verification

- `node --check` 3 file: OK; ESLint `.eslintrc.noundef.json`: 0 error
- `test-telegram-apiPost-fileRef.js`: 4/4 (payload terverifikasi: path→`file:///tmp/…`, file_id→raw tanpa prefix)
- Regresi: transient-retry 9/9, callback-retry 4/4, anime-topic-router 18/18, failfast 32/32
- Test manual (server): restart bot; kirim ulang part via library (file_id) → item terkirim
  normal; pada blip 500 lokal, log `apiPost transient — retry`. `sendPaidMedia` ikut terlindungi.