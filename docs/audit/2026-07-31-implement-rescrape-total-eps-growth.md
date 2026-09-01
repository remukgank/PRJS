# 2026-07-31: Implementasi mekanisme re-scrape total_eps growth (--refresh)

## Referensi
Proposal: `docs/audit/2026-07-31-rescrape-total-eps-growth.md` (fomo-drama,
commit 62b8090) — "Dokumen ini untuk agent PRJS (Replit). Scope: scraper/db.js
+ scraper/batch-download.js saja. JANGAN sentuh fomo-drama."

## Perubahan (persis dokumen)
1. `scraper/db.js`
   - `detail_checked_at TIMESTAMPTZ` di CREATE TABLE media + ALTER TABLE
     IF NOT EXISTS (idempotent, entry lama NULL → fetch ulang)
2. `scraper/batch-download.js`
   - Flag baru `--refresh` (parseArgs default `refresh: false` + showHelp)
   - Early skip-check: SELECT `detail_checked_at`; skip cuma kalau
     cache < 24 jam DAN gak `--refresh`; selain itu fetch detail ulang
   - `detail_checked_at = NOW()` di-set SEKALI pas detail fetch sukses
     (setelah guard `!episodes.length`, sebelum loop upload)
   - Re-scrape aman: media_parts dedup by part → cuma episode baru yang upload

## Penyimpangan dari snippet dokumen (3)
1. **`refresh` disalurkan via parameter**, bukan `config.refresh` global —
   `config` itu variabel lokal di IIFE entry (line ~687), sedangkan
   `processDrama` top-level gak bisa akses. Jadi: parseArgs → runBatch(
   ..., refresh) → processDrama(url, ..., refresh). Sama-sama 1 jalur kayak
   mode/chunkSize, gak nambah kompleksitas.
2. **Fix bonus: path `allDone` (line ~372) upsertMedia masih 3 arg** — ternyata
   commit 71259e2 ketinggalan 1 call site (gak kena replace karena indentasi
   beda). Item d di dokumen udah nangkep — sekarang jadi 4 arg
   (`dramaSourceUrl(params)`).
3. **upsertMedia INSERT set `detail_checked_at = NOW()`** — UPDATE post-fetch
   gak nge-efek drama baru (row belum ada). Tanpa ini, drama baru bakal
   di-fetch ulang tiap run sampai upsert pertama; dengan ini langsung masuk
   cache window 24 jam.

## Verifikasi
- `node --check scraper/batch-download.js && node --check scraper/db.js` — OK
- Edge cases:
  - Interactive mode (no args): config = {} → `refresh` undefined → falsy → cache dihormati ✓
  - Drama baru (belum ada row): SELECT kosong → fetch detail → INSERT set detail_checked_at ✓
  - Detail fetch gagal 3×: return dini, detail_checked_at TETAP lama → retry run berikutnya ✓
  - `--refresh` + total_eps sama: fetch detail, late-check allDone → skip upload ✓
  - Deploy pertama kali: semua detail_checked_at NULL → semua drama di-check ulang
    1× (cost: ~1 detail fetch per drama, gak ada re-upload) — sekali doang, window 24 jam

## Di luar scope
- fomo-drama / sync-check: gak disentuh
- Jadwal `--refresh` 1×/hari: Replit cron/schedule — keputusan user
- Restart batch Replit pas idle: user
