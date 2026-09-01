# Fix: Skip sv fallback saat session kena challenge timeout

**Date**: 2026-07-31
**Author**: opencode

## Root Cause

Saat session FlareSolverr kena flag Cloudflare, tiap request watch page gagal dengan `Error solving the challenge. Timeout after 60.0 seconds.` — tapi `getVideoUrl` tetap mencoba sv=1, sv=2, sv=3 dengan **session yang sama**, padahal semua server pasti timeout juga. Akibatnya tiap episode gagal memakan 3×60s (loop server) + 60s (retry sessionless) = ~4 menit terbuang percuma.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/dramafren.js` | `interceptVideoUrl` tambah flag `result.timeout = true` saat error/status bukan ok dengan pola `Timeout after`/`solving the challenge` |
| `scraper/index.js` | `getVideoUrl` break loop server `[1,2,3]` saat `r.timeout` — langsung lompat ke retry sessionless |

## Detail Teknis

- Deteksi timeout: `status === 500` + `body.message` cocok `/Timeout after|solving the challenge/i`, berlaku juga di cabang `resp.data.status !== 'ok'`
- Flag hanya di-set kalau retry sessionless (`_isRetry: true`) juga gagal dapat video — kalau retry berhasil, `timeout` tetap false
- Retry sessionless (Chrome baru) tetap jadi penyelamat — fingerprint baru bisa solve challenge

## Verification

- `node --check` lulus di `dramafren.js` dan `index.js`
- Skenario: drama 468 (Selingkuhan Tunanganku) — burst timeout di ep 45-49, 57/58 akhirnya complete. Dengan fix ini tiap episode gagal hemat ~2 menit (skip sv2/sv3)
