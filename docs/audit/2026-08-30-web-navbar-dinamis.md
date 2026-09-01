# Web: Navbar dinamis dari DB

**Date**: 2026-08-30
**Author**: opencode

## Root Cause

Navbar HokiDrama hardcode 7 link sumber (FlickReels/ShortMax/ReelShort/dll) di `layout.js`. Setelah migrasi web ke PostgreSQL (`vidara_uploads`), sumber yang tampil di navbar harusnya mengikuti data yang benar-benar ada di DB (via `getSources()`), bukan daftar statis. Saat `vidara_uploads` masih kosong, navbar hardcode menyesatkan; saat terisi, navbar tidak update.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `hokidrama/src/app/layout.js` | Import `getSources` dari `../lib/data`; ubah `Navbar` jadi `async function Navbar()` yang `await getSources()` dan render link dinamis `{sources.map(s => <a href={`/${s.key}`}>{s.label}</a>)}`; hapus 7 link hardcode |

## Verification

- `next build` sukses: `Route (app)` — ƒ /, ● /[source], ƒ /drama/[id]
- Web HTTP 200, HTML mengandung `drama-grid`/`drama-card` (build terbaru termuat)
- Setelah ada data di `vidara_uploads`, `getSources()` mengembalikan `[{key, label, icon, count}]` sesuai provider yang ter-upload
