# Audit Struktur PRJS — Laporan & Refactor Plan

**Date**: 2026-09-03
**Author**: opencode
**Status**: Laporan untuk review — belum ada implementasi

## Ringkasan

Audit struktur kode PRJS (`scraper/` : download konten → kirim ke Telegram & Vidara). Output = laporan + refactor plan. **Belum ada kode yang diubah** — menunggu keputusan user.

Kondisi: `bot.js` = 5594 baris, 4 handler utama dalam 1 file (message, callback_query, pre_checkout_query, polling_error). Total 23 file `.js` di `scraper/` + `services/` + `utils/`.

---

## Temuan

### 🔴 HIGH

**H1. `bot.on('message')` & `bot.on('callback_query')` async tanpa top-level try/catch**
- Lokasi: `scraper/bot.js:3617` dan `:4647`
- Deskripsi: Handler utama tidak dibungkus try/catch. Error di dalam → jatuh ke `process.on('unhandledRejection')` (bot.js:38) → log tanpa konteks chatId, user tidak dapat feedback.
- Contoh nyata: error Samehadaku `can't parse entities: Unsupported start tag "!doctype"` jadi unhandled rejection (sebelum di-fix).
- Severity: **High**

**H2. Duplikasi logic auto-detect judul di 4+ tempat**
- Lokasi: `scraper/bot.js` ~1904 (GoFile direct), ~2038 (GoFile share), ~2249 (Pixeldrain), ~2555 (GDrive)
- Deskripsi: Blok `extractSourcePattern` + `parseSamehadakuFilename` + loop prov → `findMediaByPattern` identik di 4 tempat. Tiap fix harus diedit di semua → rawan lupa → inkonsistensi.
- Severity: **High**

**H3. `findMediaByPattern` exact case-sensitive = akar bug samehadaku**
- Lokasi: `scraper/db.js:387-398`
- Deskripsi: `WHERE source_pattern = $1` case-sensitive. File samehadaku lewat `extractSourcePattern` return SHORT kapital (`TSSDK`), DB simpan lowercase (`kuronime-tssdk`). Di-fix via workaround per-handler (duplikat), bukan root fix.
- Severity: **High**

### 🟡 MEDIUM

**M1. `require()` berulang dalam bot.js (indikator file oversized)**
- Lokasi: seluruh bot.js
- Deskripsi: `http` 11x, `vipService` 6x, `vidaraService` 4x, `vidara-uploader` 4x, `ai` 2x (late-require).
- Severity: **Medium**

**M2. Import `pool` di bot.js hanya dipakai 1x**
- Lokasi: `scraper/bot.js:23` (import), `:3680` (pemakaian)
- Deskripsi: Sebagian besar query lewat wrapper db.js; 1 query `pool.query` langsung.
- Severity: **Medium**

**M3. README.md outdated vs codebase**
- Lokasi: `scraper/README.md`
- Deskripsi: Masih list subdomain lama, tidak sebut reelfren/samehadaku/vidara/gofile/pixeldrain/filedon/gdrive/VIP/AI/library. Stack setup juga outdated (`docker run flaresolverr` → sudah native).
- Severity: **Medium**

**M4. `unhandledRejection` log tanpa konteks user action**
- Lokasi: `scraper/bot.js:38-40`
- Deskripsi: terkait H1; konteks minim.
- Severity: **Medium**

### 🟢 LOW

**L1. Duplicate file root vs scraper (test identik) + root bot.js legacy**
- Lokasi: root `test*.js` vs `scraper/test*.js` (MD5 identik); root `bot.js` (2405L) beda dari `scraper/bot.js` (5594L).
- Severity: **Low**

**L2. `cleanCaption` jelek utk pola uncensored** — caption jadi `1080p kjny03unc`
- Lokasi: `scraper/bot.js:1606`
- Severity: **Low**

---

## Refactor Plan (urut, bukan eksekusi)

### Fase 1 — Pengaman error handling
1. Top-level try/catch di `bot.on('message')` & `bot.on('callback_query')` → log + feedback user. Hilangkan H1 & M4. Risiko rendah.

### Fase 2 — Root fix pattern matching
2. Ubah `findMediaByPattern` (db.js) jadi case-insensitive (`ILIKE`/`LOWER()`). **Perlu uji kasus TSS multi-season dulu** (`tss`, `TSSDK`, `tensei-s3`).

### Fase 3 — De-duplikasi auto-detect (setelah Fase 2)
3. Ekstrak helper `detectTitleFromFilename(fileName)` → ganti 4 call site. Dependensi: Fase 2.

### Fase 4 — Fragmentasi bot.js (opsional, perlu approval terpisah — SOP Step 5)
4. Pisah jadi modul: handlers/download, handlers/library, handlers/vidara, lib/title-detect, lib/parser. Risiko tinggi (cyclical dep).

---

## Pertanyaan Terbuka

- **Q1** H3: ubah `findMediaByPattern` case-insensitive (perlu uji TSS), atau biarkan workaround per-handler?
- **Q2** Refactor Fase 4 (pecah bot.js): kerjakan sekarang atau tunda?
- **Q3** M2: pindahkan `pool.query` di line 3680 ke wrapper db.js?
- **Q4** L1: cleanup root bot.js legacy + duplikat test files?
