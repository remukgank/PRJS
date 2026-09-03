# Fix H1/M4 — safeHandler top-level try/catch di Telegram handlers

**Date**: 2026-09-03
**Author**: opencode
**Status**: Batch A (Fase 1) — di-approve & diimplementasikan

## Root Cause

`bot.on('message')` dan `bot.on('callback_query')` adalah handler async yang **tidak punya top-level try/catch**. Kalau ada error yang dilempar keluar dari cabang routing (yang tidak punya try/catch internal), error jatuh ke `process.on('unhandledRejection')` (bot.js:38) → log **tanpa konteks chatId** dan **user tidak dapat feedback** (diam/gantung).

Contoh nyata: error Samehadaku `can't parse entities: Unsupported start tag "!doctype"` jadi unhandled rejection.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js:3619` | Tambah `safeHandler(kind)` — wrapper async handler, tangkap error, log + feedback ke user |
| `scraper/bot.js:3634` | Wrap `bot.on('message', ...)` dengan `safeHandler('message')` |
| `scraper/bot.js:4664` | Wrap `bot.on('callback_query', ...)` dengan `safeHandler('callback')` |

## Detail Teknis

`safeHandler` adalah functional wrapper:
```js
function safeHandler(kind) {
  return (fn) => async (...args) => {
    try { return await fn(...args); }
    catch (err) {
      const chatId = kind === 'callback' ? args[0]?.message?.chat?.id : args[0]?.chat?.id;
      logger.error({ err: {...}, chatId, kind }, `Unhandled error in ${kind} handler`);
      if (chatId) await bot.sendMessage(chatId, `❌ Error: <msg>`).catch(() => {});
    }
  };
}
```

- Pass-through penuh saat sukses (tidak ubah behavior).
- Catat error dengan konteks `chatId` + `kind` (fix M4).
- Kirim feedback error ke user (fix H1 — user tidak diam/gantung).
- `bot` adalah const module-scope, aman diakses saat handler dipanggil.
- Pendekatan **non-invasif**: tidak refactor isi 1000+ baris handler (SOP Step 5 — file besar jangan di-refactor agresif), cukup wrap di pembuka & penutup.

## Verification

- `node --check scraper/bot.js` — lulus
- Struktur: message handler ditutup `}));`, callback handler ditutup `}));`
- **Functional test**: kirim input yang memicu error tak-ter-handle → log muncul "Unhandled error in message/callback handler" dengan chatId + user dapat pesan error. **Perlu bot restart.**

## Catatan

Ini bagian dari rencana refactor audit 2026-09-03 (Batch A). Fase 2 (H3 case-insensitive) & seterusnya menunggu approval terpisah.
