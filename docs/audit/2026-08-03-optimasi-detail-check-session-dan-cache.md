# 2026-08-03: Optimasi detail-check — session di-skip + cache window 7 hari

## Konteks
Batch keliatan "mengulang": tiap 24 jam semua drama (1784) di-re-check
detail-nya karena cache `detail_checked_at` kedaluwarsa, dan tiap cek bikin
`sessions.create` (105 session untuk 106 cek detail). DB sehat — 0 page=watch
= gak ada re-upload. Tapi biaya cycle-nya ~3-5 jam/hari + boros session.

## Keputusan (disetujui user, proposal 3 bagian)
1. Skip session untuk detail-check — detail page gak butuh CF session
2. Cache window 24 jam → 7 hari — cycle jadi 1×/minggu
3. Deteksi growth utama pindah ke sync-check (fomo-drama): tulis list
   "Lokal > Neon" → feed ke batch → re-scrape target, tanpa nunggu cycle

## Perubahan (PRJS)
### scraper/index.js
- `getAllEpisodes` fetch detail dengan `session: null` — sessionless
  (direct axios cepat jalan duluan, FlareSolverr sessionless cuma fallback)

### scraper/batch-download.js
- `DETAIL_CHECK_CACHE_MS = 7 * 24 * 3600 * 1000` (konstanta baru)
- Early skip-check pakai konstanta itu (bukan 24 jam hardcoded)
- `createSession` DIPINDAH setelah allDone check — session cuma dibuat kalau
  drama beneran mau di-scrape (drama lengkap → skip tanpa sessions.create)

## Perubahan (fomo-drama) — review di server user
### scripts/sync-check.js
- Flag `--rescrape <file>`: tulis list URL drama "Lokal > Neon" ke file
  - URL dari `source_url` (kalau ada), fallback bangun dari slug
    (`https://{sub}.dramafren.org/index.php?page=detail&id={id}&lang=id`)
  - Format cocok sama `parseDramaUrl` batch-download (page=detail&id&lang)
  - Cara pakai:
    `yes s | node scripts/sync-check.js --rescrape rescrape-list.md`
    `node scraper/batch-download.js rescrape-list.md` (di Replit)

## Verifikasi
- `node --check` — batch-download.js, index.js, dramafren.js, sync-check.js — OK
- Test terisolasi: bangun URL dari slug + parseDramaUrl round-trip — OK
  (netshort:1973235073021644802 → URL detail → parsed subdomain/id/lang ✓)
- Block duplikat (akibat salah edit) sudah dibersihkan — `detail_checked_at
  = NOW()` cuma 1×, `createSession` cuma 2× (import + 1 call)

## Trade-off
- Cache 7 hari: growth drama yang lagi tayang ketangkep maksimal telat 7 hari
  KALAU sync-check gak jalan — makanya #3 jadi detector utama. Rekomendasi:
  jalankan sync-check --rescrape rutin (cron) di server user.
