# Batch E3a — lib/telegram.js (floodRetryMs, sleep, apiPost)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Implemented — branch `batch-e3-telegram-progress` (E3a)

## Scope

Ekstrak 3 pure+config functions dari `scraper/bot.js` ke `scraper/lib/telegram.js` (E3a, tidak sentuh `bot` instance):

- `sleep(ms)`, `floodRetryMs(err)`, `apiPost(method, payload, retry)` + `initTelegram(config)`

`scraper/bot.js` diubah jadi import dari `lib/telegram` dan panggil `initTelegram({ TOKEN, API_BASE, API_HTTP, API_MAX_RETRY })` sekali di top-level. 3 definisi lokal dihapus.

## Detail — Guard untuk E3b

`apiPost` di `lib/telegram.js` punya guard:
```js
if (!_config) throw new Error('lib/telegram belum di-init — panggil initTelegram(...) dulu');
```
Mencegah silent fail jika ada modul lain `require('./lib/telegram')` dan panggil `apiPost`/`sendVideo` sebelum `bot.js` facade init — throw error jelas, selaras Batch A (jangan silent) dan syarat E3b.

## Verification

- `node --check scraper/lib/telegram.js` — lulus
- `node --check scraper/bot.js` — lulus
- **Unit test `floodRetryMs`:**
  ```
  retry after 3 → 3000 ✓
  retry after 10 → 10000 ✓
  no retry → 0 ✓
  with description → 5000 ✓
  ```
- **Unit test `apiPost` guard:** `require('./lib/telegram').apiPost` tanpa `initTelegram` → throw `lib/telegram belum di-init` (bukan silent) ✓
- **Unit test `apiPost` mock:** tidak hit Telegram (butuh TOKEN valid), tapi guard memastikan tidak silent fail
