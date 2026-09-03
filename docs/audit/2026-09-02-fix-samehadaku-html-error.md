# Fix Samehadaku — strip HTML dari error message

**Date**: 2026-09-02
**Author**: opencode

## Root Cause

Ketika Worker relay (`gofile.remuk-gank.workers.dev/samehadaku`) return error (misal 502 Cloudflare), `curlJson()` di `samehadaku.js` include raw HTML body di error message:

```
Worker non-JSON: <!DOCTYPE html><html><head><title>502: Bad gateway</title>...
```

Error message ini lalu dikirim ke Telegram dengan `parse_mode: 'HTML'`. Telegram coba parse `<!DOCTYPE html>` sebagai HTML tag → reject "Unsupported start tag !doctype" →Unhandled rejection.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/samehadaku.js:21-22` | `curlJson()` — hapus raw HTML dari error message (hanya kirim status code + length) |
| `scraper/bot.js:23` | Tambah `stripHtml()` helper — strip HTML tags dari string |
| `scraper/bot.js:4347` | Samehadaku error handler — pakai `stripHtml(err.message)` |
| `scraper/bot.js:4487` | Google Drive error handler — pakai `stripHtml(err.message)` |

## Detail Teknis

1. **`curlJson()`**: Error message sekarang hanya `Worker HTTP 502` atau `Worker non-JSON (len=1234)` — tidak include raw HTML body
2. **`stripHtml(s)`**: Helper baru — strip semua HTML tags (`<...>`) dan decode entity (`&amp;` etc.) dari string. Dipakai sebagai safety net di error handler yang kirim ke Telegram dengan `parse_mode: 'HTML'`
3. **Coverage**: 2 tempat yang use `parse_mode: 'HTML'` dengan `err.message` sudah di-fix. Tempat lain yang tidak pakai `parse_mode: 'HTML'` tidak terdampak.

## Verification

- `node --check scraper/samehadaku.js` — lulus
- `node --check scraper/bot.js` — lulus
- **Functional test**: Kirim link Samehadaku anime yang tidak valid/mati → bot harus tampilkan error message bersih (tanpa raw HTML) ke user, bukan Unhandled rejection
