# Batch E3b — lib/progress.js (Progress + RichProgress)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Implemented — branch `batch-e3b-progress`

## Scope

Ekstrak `Progress` / `RichProgress` (+ `FRAMES`, `STATUS_ICONS`) dari `scraper/bot.js` ke `scraper/lib/progress.js` (E3b). `bot.js` 5394 → 4997 baris (−397). `lib/progress.js` 444 baris.

**Pola yang dipakai (sesuai syarat E3b): closure-init + guard yang sama seperti `lib/telegram.js` (E3a).**

## Detail — Guard Konsisten

`lib/progress.js` punya:
```js
let _bot = null, _config = null;
function initProgress({ bot, config }) { _bot = bot; _config = config; }
function ensureInit(caller) {
  if (!_bot || !_config) throw new Error(`lib/progress belum di-init — panggil initProgress({ bot, config }) dulu (dari ${caller})`);
}
```
Semua constructor/method (`Progress.constructor/start`, `RichProgress.constructor/start/tick/done`) memanggil `ensureInit(caller)` dulu — throw error jelas, **bukan silent fail**. `bot.js` facade memanggil `initProgress({ bot, config: { TOKEN, LOCAL_API_PORT } })` tepat setelah `const bot = new TelegramBot(...)` (line 286).

**Bedakan dari `sendRichMessage` AI chat:** `bot.js` tetap punya `sendRichMessage(chatId, content, opts)` sendiri untuk AI chat/streaming (line 360). `lib/progress.js` memakai helper internal `_internalSendRichMessage` (privat, tidak di-export) agar tidak bentrok nama.

## Verification

- `node --check scraper/bot.js`, `lib/progress.js` — lulus
- Unit test: guard tanpa init throw ✓, `Progress.render` ✓, `RichProgress.update+render` ✓, `renderRichDone` Selesai ✓

## Rollback

Branch `batch-e3b-progress` dari `main` (382c5d1, setelah E3a merge). Jika bermasalah: `git checkout main -- scraper/bot.js scraper/lib/progress.js` atau `git revert` 1 commit. DB tidak disentuh.
