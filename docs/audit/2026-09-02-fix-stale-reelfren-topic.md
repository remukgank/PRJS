# Fix Stale ReelFren Topic — auto-evict + retry

**Date**: 2026-09-02
**Author**: opencode

## Root Cause

`data/reelfren_topics.json` menyimpan mapping `provider → thread_id`. Kalau topic dihapus dari forum group secara manual, file tetap punya thread_id lama (stale). Bot tidak handle error "message thread not found" — tidak delete stale entry, tidak retry buat topic baru.

Akibatnya:
- `sendToProviderTopic()` gagal → poster/caption tidak masuk ke topic
- `sendToTopicVideo()` gagal → video fallback ke chat langsung (General di grup, atau private chat)

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js:256-322` | Tambah `isStaleTopicError()`, `evictStaleTopic()`, update `sendToProviderTopic()` dan `sendToTopicVideo()` — handle "message thread not found" → evict stale + retry buat topic baru |

## Detail Teknis

1. **`isStaleTopicError(err)`** — detect error Telegram "message thread not found" (case-insensitive)
2. **`evictStaleTopic(provider)`** — hapus entry dari `reelfrenTopics` Map + save ke file + log warning
3. **`sendToProviderTopic()`** — kalau dapat stale error → evict → retry `getOrCreateTopic()` → kirim ke topic baru. Kalau retry juga gagal → log warning (sama seperti behavior sebelum fix)
4. **`sendToTopicVideo()`** — behavior yang sama. Return `null` jika gagal (untuk fallback ke chat)

## Verification

- `node --check scraper/bot.js` — lulus (no errors)
- **Functional test**: Topic cubetv (thread_id 4) sudah tidak ada di grup → bot harus auto-evict entry stale + buat topic baru + kirim ke topic baru (bukan General)
- **Normal case**: Topic masih ada → tidak ada perubahan behavior
- **Edge case**: Topic baru juga gagal → log warning, fallback ke chat (sama seperti sebelum fix)
