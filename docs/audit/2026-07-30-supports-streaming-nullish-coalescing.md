# Fix: supports_streaming || true → ?? true di sendPaidMediaVideo

**Date**: 2026-07-30
**Author**: opencode

## Root Cause

Di `sendPaidMediaVideo` (bot.js), field `supports_streaming` diset dengan:
```js
supports_streaming: supports_streaming || true,
```
Operator `||` akan fallback ke `true` bahkan ketika nilai eksplisit `false` dipass — karena `false || true === true`. Nilai `false` tidak pernah dihormati.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` | Baris 1431: ganti `||` → `??` (nullish coalescing) |

## Detail Teknis

Operator `??` hanya fallback ke default kalau nilai-nya `null` atau `undefined`, bukan `false`. Ini sesuai semantik yang diinginkan: kalau caller tidak pass `supports_streaming` (undefined), default ke `true`; kalau pass `false`, dihormati.

```js
// Sebelum
supports_streaming: supports_streaming || true,

// Sesudah
supports_streaming: supports_streaming ?? true,
```

## Verification

- `node --check scraper/bot.js` lulus
- Bot di-restart, polling aktif, DB initialized — tidak ada error
