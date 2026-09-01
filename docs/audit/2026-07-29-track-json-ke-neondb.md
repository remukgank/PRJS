# Migrasi Track.json ke NeonDB

**Date**: 2026-07-29
**Author**: opencode

## Root Cause

`batch-download.js` menggunakan file `track.json` (JSON file per-drama + global) untuk melacak episode yang sudah diupload ke Telegram. Data ini tidak bisa di-query dari server fomo-drama (produksi) untuk verifikasi sinkronisasi. Perlu diganti dengan tabel PostgreSQL di NeonDB agar bisa diakses dari kedua sisi.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/db.js` | Tambah `CREATE TABLE IF NOT EXISTS` untuk `media` dan `media_parts` di `initDatabase()` |
| `scraper/batch-download.js` | Ganti `loadTrack/saveTrack` (JSON file) dengan query ke `media_parts` + `media` via pool dari `db.js` |

## Detail Teknis

- **Tabel `media`**: `slug VARCHAR PK`, `nama VARCHAR NOT NULL`, `created_at TIMESTAMP`, `created_by VARCHAR`
- **Tabel `media_parts`**: `media_slug VARCHAR FK → media(slug) ON DELETE CASCADE`, `part INTEGER NOT NULL`, `added_at TIMESTAMP`, `UNIQUE(media_slug, part)`
- `loadTrack()` → `SELECT part FROM media_parts WHERE media_slug = $1`
- `saveTrack()` → `INSERT INTO media_parts (media_slug, part) ON CONFLICT DO NOTHING`
- Global track check → query `media` + `media_parts` untuk cek kelengkapan
- Migrasi otomatis dari track.json lama ke DB saat pertama kali drama diproses
- Merge mode tetap pakai file-based track.json (tidak diubah)
- `initDatabase()` dipanggil di `runBatch()` agar tabel siap sebelum dipakai

## Verification

- `node --check` lulus untuk kedua file.
- Test migration 4 drama (68, 78, 86, 110 parts) — data cocok persis dengan track.json asli.
- Test production: batch download 1778 drama, migration berjalan lancar (flickreels 220+ drama selesai tanpa upload ulang).
