# 2026-07-31: Media table tambah kolom source_url (dupe-check layer-2 full)

## Konteks
sync-check (fomo-drama, commit 58950c7) sudah pakai 2-layer validasi dupe:
1. nama (lowercase)
2. source_url — fallback ke slug kalau kolom belum ada di NeonDB

PRJS belum nyimpen `source_url` di tabel `media`, jadi layer-2 selalu
fallback ke slug. `flickreels:6885` sama `flickreels:6997` sempat kehapus
dua kali gara-gara layer-2 lemah + logika delete yang keliru.

## Keputusan
Proposal user (disetujui langsung): simpan `source_url` = URL detail asli
drama supaya deteksi dupe pakai link beneran, bukan slug. Kalau format URL
source berubah (id pindah), slug gak cukup buat bedain.

## Perubahan (scope: db.js + batch-download.js)
1. `scraper/db.js`
   - Kolom baru: `source_url VARCHAR` (CREATE TABLE + ALTER TABLE IF NOT EXISTS)
2. `scraper/batch-download.js`
   - Helper baru `dramaSourceUrl(params)` — bentuk ulang URL detail asli:
     `https://{subdomain}.dramafren.org/index.php?page=detail&id={id}&lang={lang}`
   - `upsertMedia(nama, totalEps, epMin, sourceUrl)` — simpan `source_url`,
     update pakai `COALESCE(media.source_url, $5)` (kali pertama nulis, gak nimpa)
   - Semua 4 call site di-update: skip-path, upload-path, merge-path, final save

## Tidak diubah (di luar scope)
- Skip-logic tambahan ("judul sama & source_url beda → jangan skip") — opsional,
  identitas masih slug (id) jadi hanya pengaman tambahan. Belum dibutuhkan.
- Logika sync-check di fomo-drama — sudah support otomatis (deteksi kolom
  via information_schema, line 69-81 sync-check.js)

## Verifikasi
- `node --check scraper/batch-download.js && node --check scraper/db.js` — OK
- Cross-check: sync-check.js sudah deteksi `source_url` otomatis; entry lama
  yang `source_url` NULL tetap jalan (fallback slug, line 132)

## Catatan
- Gak perlu backfill: entry lama NULL → fallback slug = perilaku lama (aman).
- Update ini perlu di-commit + push dan diapply ke Replit (batch jalan baru
  butuh restart biar upsert nyimpen source_url).
