# Migrasi API_BASE ke api.reelfren.com (2026-09-09)

## Bukti migrasi
Site pindah `reelfren.dramafren.org` -> `reelfren.com`; API pindah
`api.dramafren.org` -> `api.reelfren.com` (CORS baru allow reelfren.com).
Host lama 503 konsisten berjam-jam; host baru 200/0.28s + data penuh
(60 ep, videoUrl, sub Indo) untuk judul yang kemarin bakar 429 dtk.

## Perubahan (scraper/providers/reelfren.js saja)
- `API_BASE` -> `https://api.reelfren.com` (menggerakkan /api/video +
  /api/detail); `API_BASE_LEGACY` = host lama.
- Origin header (video + detail) -> `https://reelfren.com`;
  `WEB_BASE` (watch-scrape + URL episode) -> `https://reelfren.com`.
- Fallback satu arah: primer full-retry -> host lama 1x (murah, sebelum
  FlareSolverr) -> FlareSolverr -> gagal. Berlaku di video + detail.
- Komentar domain disesuaikan. Retry/backoff, break :307, fail-fast,
  backpressure, merge/upload tak disentuh. Terpisah dari Hook 3.

## Verifikasi (tanpa Telegram send/download)
- `node --check` + ESLint 0.
- Live modul asli ke host baru, judul kemarin: video ep1 (title/60/
  unlocked/hasUrl ✅) + episode-list 60 + title ✅.
- Catatan harness: `getAllEpisodesReelFren` return `{episodes, meta}`
  (bukan array) — pembacaan awal "undefined" itu salah harness, bukan kode.
