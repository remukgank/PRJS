# 2026-07-31: Fix timeout propagation di fallback sessionless (sv loop 3×60s)

## Konteks
Log batch (drama 472 "Perangkap Suami Sempurna", netshort) menunjukkan pola
gagal yang boros: per episode yang kena challenge timeout, request berjalan
`sv1 → sv2 → sv3`, masing-masing 60 detik — total ~183 detik per episode.
Drama 471 juga sempat kena (Ep 39, percobaan 1/3).

## Root cause
Fix 5f38613 propagate flag `timeout` cuma di dua branch:
- catch axios (line 102-106)
- status != 'ok' (line 115-119)

TAPI fallback "session return 200 OK tanpa videoUrl" (dramafren.js:267-271)
lupa propagate `retry.timeout`:
- Session request: 200 OK cepat (~1 detik, "Challenge not detected") tapi
  HTML-nya gak ada video → fallback sessionless dipanggil (line 268)
- Fallback sessionless: kena challenge, 60s, 500 "Timeout after 60.0 seconds"
  → `retry.timeout = true` (line 107/120) — TAPI nilai ini DIABAIKAN,
  `result.timeout` tetap false
- getVideoUrl (index.js:96-106): `r.timeout` false & `r.videoUrl` null →
  loop lanjut ke sv2, sv3 — 2× 60s tambahan terbuang

## Perubahan (scope: scraper/dramafren.js, 1 baris)
```js
if (retry.timeout) result.timeout = true;
```
di dalam fallback sessionless (line 270). Efek:
- sv1 timeout → `result.timeout = true` → getVideoUrl break → episode gagal
  dalam ~61 detik (bukan ~183)
- Path sukses tidak berubah: sessionless solve (12-51s) tetap return videoUrl,
  timeout tetap false

## Verifikasi
- `node --check scraper/dramafren.js && node --check scraper/index.js` — OK
- Pola request FlareSolverr (docker logs) cocok dengan hipotesis:
  - request session diikuti request sessionless +1 detik (fallback line 268)
  - timeout 60s hanya WARN di sessionless; sv2/sv3 tetap dipanggil (bug)
  - setelah challenge mereda: sessionless solve 12-51s → episode sukses
    (eps 51-62 drama 472 semua berhasil)

## Catatan
- Fix ini butuh restart batch Replit biar kepakai. Batch sekarang lagi jalan
  (drama 472 hampir selesai) — restart bisa dilakukan pas pergantian drama
  atau setelah drama ini kelar.
