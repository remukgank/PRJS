# Anime Single-Send: File Khusus Topic via getOrCreateTopic('anime')

**Date**: 2026-09-13
**Author**: opencode

## Root Cause

File anime (samehadaku/kuronime/wibutv — lewat host gofile/pixeldrain/filedon/gdrive/mega/ucdrive) dikirim **dua kali**: sekali `sendVideo(chatId, ...)` ke chat asal (General) lalu kopian `mirrorAnimeToTopic` ke thread anime (sebelumnya const hardcode `ANIME_TOPIC_ID = 655`). Dampak: duplikat di General + topic, dan const `655` bocor sebagai tema ID instance kita ke repo open source (thread 655 di deployment lain = thread yang salah).

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/lib/animeTopic.js` | Baru. Router `buildAnimeSender(senders, resolveThread)` → `sendAnimeMedia` (single-send, dispatch ext video/audio/doc, thread topic atau fallback chat). Export `ANIME_TOPIC_KEY = 'anime'`. |
| `scraper/bot.js` | Hapus `ANIME_TOPIC_ID` (const+default 655). `sendToAnimeTopic` → `resolveAnimeThread()` (pakai `getOrCreateTopic('anime')`, stale-evict + retry-once, RF gate) + `sendAnimeMedia = buildAnimeSender(..., resolveAnimeThread)`. Export ctx diganti. |
| `scraper/handlers/download.js` | Hapus `mirrorAnimeToTopic` + const `VIDEO_EXTS`/`AUDIO_EXTS`. 8 site `if VIDEO/AUDIO/Document` + `mirrorAnimeToTopic` → satu panggilan `_ctx.sendAnimeMedia(...)`: handleGofileUrl (direct+folder), handleGofileBatch, handleUcDriveUrl, handlePixeldrainUrl, handleFiledonUrl, handleMegaUrl, handleGdriveUrl. |
| `data/reelfren_topics.json` | Seed `"anime": 655` (data per-deployment; reuse topic lama, bukan hardcode kode). |
| `scraper/tests/test-anime-topic-router.js` | Baru. Test router single-send, thread/fullback, dispatch, return result. |

## Detail Teknis

- **Anti-hardcode**: tidak ada ID topik di kode. Thread di-resolve via `getOrCreateTopic(ANIME_TOPIC_KEY)` — reuse infra yang sama dengan topik provider reelfren/dramafren (auto-create `createForumTopic` pada first-use per deployment, cache di `data/reelfren_topics.json`, stale-evict + retry). Grup = `RF_GROUP_ID`.
- **Fallback aman**: `resolveAnimeThread()` null saat `RF_GROUP_ENABLED/RF_GROUP_ID` off, atau error → router kirim ke chat asal (file tidak hilang, tidak dobel).
- **Library file_id**: `sendAnimeMedia` mengembalikan result pengiriman persis seperti sebelumnya — `savePartFileId`/`upsertMedia` (done-state, `sam` list) tidak berubah.
- **Perbaikan ikutan**: audio/document sekarang menerima `message_thread_id` (sebelumnya hanya video yang kena thread pada mirror lama).
- Dispatch ekstensi pindah dari handler ke router (satu choke point keputusan; handler cuma swap 1 panggilan).

## Verification

- `node --check` lulus: bot.js, download.js, animeTopic.js, 2 test file.
- ESLint `.eslintrc.noundef.json` 0 error.
- `test-anime-topic-router.js`: 18/18 pass (single-send saat topic; tanpa thread saat fallback; resolve error → fallback; dispatch audio/doc dengan thread; undefined resolver → chat).
- Regresi: `test-samehadaku-ep1-slug.js` 22/22, `test-samehadaku-parse-ep1.js` 14/14.

## Live Test (di tangan user)

1. **Reuse**: pastikan `reelfren_topics.json` berisi `"anime": 655` → trigger 1 anime (mis. mynoghra) → file muncul 1× di topic 655, tidak di General; log 1 baris `File anime terkirim ke topic grup`.
2. **Auto-create**: kosongkan `"anime"` dari JSON → trigger ulang → topik baru "anime" dibuat (log `Topic ReelFren dibuat`), file hanya di sana, trigger berikutnya reuse tanpa create ulang.