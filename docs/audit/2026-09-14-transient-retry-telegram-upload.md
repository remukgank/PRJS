# Retry Transient Upload Telegram (internal Server Error)

**Date**: 2026-09-14
**Author**: opencode

## Root Cause

Log produksi melolo (drama `7568754697738128437-jatuh-dalam-perangkap-cintanya`, merge10, 82 ep): **Part 4 (Ep 31–40, 73.2 MB)** gagal kirim ke topic 2928 dengan `Bad Request: internal Server Error during file upload` (error transient sisi Telegram upload infra). Alur saat itu:

1. `sendToTopicVideo` (bot.js:174) memanggil `sendVideo` → throw error tsb.
2. `floodRetryMs` (lib/telegram.js) hanya mengenali 429 flood (`retry after N`) → untuk "internal Server Error" return `0`.
3. `sendVideo` langsung throw tanpa retry → `sendToTopicVideo` return `null` → fallback `sendVideo(chatId)` kirim ke chat (bot.js:1806).
4. Efek: batch terpecah — Part 4 di General, sisanya di topic. Dan jalur `sendAudio`/`sendDocument` sama sekali tanpa retry (kalaupun transient error terjadi saat fallback, part bisa hilang total).

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/lib/telegram.js` | Helper `transientRetryMs` + wrapper `withUploadRetry` dipakai `sendVideo`/`sendAudio`/`sendDocument`; export `transientRetryMs` |
| `scraper/tests/test-telegram-transient-retry.js` (baru) | Unit test matcher + behavior retry 3 sender (9 kasus) |

## Detail Teknis

- `transientRetryMs(err)`: match **sempit** `/internal server error/i` → backoff tetap **3000 ms**; selain itu `0`.
- `withUploadRetry(label, sendFn)`: satu helper retry untuk video/audio/document.
  - Flood 429 → kuota `API_MAX_RETRY` (perilaku lama dipertahankan);
  - Transient (internal server error) → kuota **2 attempt tambahan** (bukan API_MAX_RETRY penuh), jeda `waitMs + 500` ms;
  - Error non-retryable (`file is too big`, dll.) langsung di-throw (1 call, tanpa retry).
- `sendPhoto` TIDAK ikut (di luar scope approved).

## Verification

- `node --check` `lib/telegram.js` + test baru: OK
- ESLint `.eslintrc.noundef.json`: 0 error
- `test-telegram-transient-retry.js`: 9/9 pass
- Regresi: `test-telegram-callback-retry.js` 4/4, `test-anime-topic-router.js` 18/18
- Test manual (server): restart bot, trigger batch/upload besar; observe log `WARN ... sendVideo upload — retry` lalu part tetap masuk topic (bukan fallback chat). Non-transient error tetap langsung gagal tanpa retry.