# Proposal E3 — lib/telegram.js + lib/progress.js

**Date**: 2026-09-03
**Author**: opencode
**Status**: Proposal — belum dieksekusi, menunggu approve

## 1. Isi Modul yang Diusulkan

| Modul | Fungsi / Class | Baris Asal | Ketergantungan |
|-------|----------------|------------|----------------|
| `lib/telegram.js` | `floodRetryMs(err)`, `sleep(ms)`, `apiPost(method, payload, retry)`, `sendVideo(chatId, filePath, opts, cacheInfo)`, `sendAudio(...)`, `sendDocument(...)`, `sendPhoto(...)` | 71-220 | `bot` instance, `config` (`LOCAL_API_PORT`, `API_BASE`, `API_MAX_RETRY`, `TOKEN`), `logger`, `fs`, `path`, `crypto` |
| `lib/progress.js` | `class Progress`, `class RichProgress` (constructor, `start()`, `update()`, `done()`, `fail()`, `render()`) | 812-1213 | `bot` instance, `logger` |

**Tidak termasuk di E3** (tetap di `bot.js` facade atau modul lain):
- `sendPaidMediaVideo`, `sendToProviderTopic`, `sendToTopicVideo` — tetap di `bot.js`/`handlers` karena dep ke `reelfrenTopics` Map

## 2. Shared State / Dependency ke `bot` Instance (Kritis)

**Kedua modul sangat terikat `bot` instance:**
- `lib/telegram.js`: semua `sendVideo`/`sendPhoto` memanggil `apiPost` → `bot` via `API_BASE`/`TOKEN`, dan `sendVideo` butuh `cacheInfo`/`file_id` handling yang sekarang di `bot.js` scope
- `lib/progress.js`: `Progress`/`RichProgress` memanggil `bot.sendMessage`/`bot.editMessageText` langsung untuk render progress bar

**Rencana akses lintas modul:**
- **Dipilih: Factory dengan inject `bot` + `config`** — `lib/telegram.js` export `createTelegram({ bot, config, logger })` yang return `{ apiPost, sendVideo, ... }`, atau simple `require` dengan closure:
  ```js
  // lib/telegram.js
  let _bot, _config;
  function initTelegram({ bot, config }) { _bot = bot; _config = config; }
  // atau
  function sendVideoFactory(bot) { return async function sendVideo(...) {...} }
  ```
- **Ditolak: `require('../bot')` langsung** → handler `bot.js` juga `require('./lib/telegram')` → cyclical. Sama seperti E1/E2, hindari.
- **Pure helper** (`floodRetryMs`, `sleep`) tidak butuh `bot`, bisa diekstrak tanpa inject.

**Alternatif paling simpel untuk E3 (low-risk):** `lib/telegram.js` dan `lib/progress.js` **tidak inject `bot` saat require**, tapi export factory yang dipanggil sekali di `bot.js` facade:
```js
// bot.js facade
const { initTelegram, sendVideo } = require('./lib/telegram');
initTelegram({ bot, config: { LOCAL_API_PORT, API_BASE, TOKEN, API_MAX_RETRY } });
```

## 3. Urutan Ekstraksi Dalam E3

E3 dipecah jadi 2 sub-step (tidak 1 commit besar):

| Sub-step | Modul | Kenapa duluan | Risk |
|----------|-------|---------------|------|
| **E3a** | `lib/telegram.js` (`floodRetryMs`, `sleep`, `apiPost`) — pure + config | Tidak butuh `bot` instance untuk 3 fungsi pertama, bisa unit test tanpa Telegram | Low |
| **E3b** | `lib/telegram.js` (`sendVideo` family) + `lib/progress.js` | Butuh `bot` inject, depend ke E3a | Medium |

Jangan gabung E3a+E3b dalam 1 commit — E3a bisa di-merge dulu, verifikasi polling tetap jalan, baru E3b.

## 4. Testing Plan

Tiap sub-step wajib sebelum lanjut:
1. `node --check` semua file berubah + `require('./lib/telegram')` smoke test (tanpa bot)
2. **E3a:** unit test `floodRetryMs` (parse `retry_after` dari error 429) + `apiPost` mock (tanpa hit Telegram)
3. **E3b:** restart pm2 dari branch, verifikasi `Bot running`/`Polling started`, trigger 1 download GoFile + 1 Pixeldrain (cek `sendVideo`/`sendPhoto` masih kirim + progress bar `RichProgress` update/done tanpa error baru)
4. Regression: `npm test` + cek log tidak ada `Unhandled error in ...` baru

## 5. Catatan

- E3 tidak sentuh DB — rollback hanya file: `git checkout main -- scraper/bot.js scraper/lib/telegram.js scraper/lib/progress.js`
- Branch `batch-e3-telegram-progress` sesuai rollback plan (1 branch per sub-batch)

Tunggu approve sebelum mulai E3a.
