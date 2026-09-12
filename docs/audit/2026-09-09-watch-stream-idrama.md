# Wire watch_stream JSON API idrama (2026-09-09)

## Temuan
Watch page idrama render "Video Unavailable (link expired)", tapi endpoint
AJAX pemutar `?action=watch_stream` me-mint URL fresh (m3u8 + ts/secret):
server 1-3 semua `ok:true`. Vonis "konten mati" sebelumnya SALAH — yang
expired hanya link embed halaman. Direct curl kena CF 403 -> via FlareSolverr
(sessionless, terbukti). Total_eps aktual 75.

## Implementasi (interleave (a) per-server, idrama tahap 1)
- `providers/dramafren.js`: `getVideoUrlViaWatchStream()` (sessionless
  request.get + parse `<pre>{json}</pre>` + decode entities; subs defensif)
  + export. Allowlist `WATCH_STREAM_SUBDOMAINS = ['idrama']` di index.js.
- `index.js getVideoUrl`: dalam loop server existing, watch_stream dulu —
  dapat -> continue (loop-top break); gagal -> intercept lama. Pola loop
  tak berubah; intercept tidak dihapus. Non-idrama tak tersentuh.

## Verifikasi (tanpa Telegram send/download)
- `node --check` + ESLint 0 (index.js, dramafren.js).
- Live jalur repo penuh: `getVideoUrl('idrama',161001641281,'',1,1,'id')`
  -> hasUrl true, host v-a.idrama.video, server 1, 12 dtk (vs 2x gagal
  37-51 dtk via intercept kemarin).
