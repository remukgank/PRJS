# Residual Risk fomo-drama (untuk agent fomo-drama)

**Tanggal**: 2026-09-02
**Konteks**: Cross-check kesiapan fomo-drama menangkap format caption PRJS (`➧ Season :- N Episode M` / `➧ Episode :- M`). PRJS = scraper (jalan di Replit, `080509c`). fomo-drama read-only di workspace ini, jalan di server kamu.

## Status: 2 residual risk NYATA, tapi TIDAK dipicu alur normal PRJS→fomo

### R1 — Parsing fail silent (risiko LOW)
**Lokasi**: `fomo-drama/index.js` (`if (!saved)` setelah blok `➧ Judul`/`epPartLine`), + fallback old-format.
- Jika `newTitleMatch` found tapi `epPartLine` TIDAK match, atau match tapi `!saved`, **tidak ada `logger.warn`** → episode di-skip tanpa trace.
- Gejala bila terjadi: episode hilang dari library tanpa log.

**Kenapa tidak dipicu PRJS**: PRJS `080509c` selalu kirim `➧ Judul :- ...` + `➧ Season :- N Episode M` / `➧ Episode :- M` (prefix `➧`), jadi `epPartLine` selalu match & `saved=true`. Baris regex fomo 1476/1500 sudah support format ini (verified: `Season :- 3 Episode 19` → `{ep:19,season:3}`, `Episode :- 19` → `{ep:19,season:null}`, `Season :- 2 Part 2 Episode 1` → `{ep:1,season:2}`).

**Saran patch fomo (server kamu)**: tambah `logger.warn('Auto-save: caption tidak match — skip', {caption})` di cabang `if (!saved)` saat `newTitleMatch` ada tapi tak ter-parse.

### R2 — Fallback old-format kehilangan season (risiko MEDIUM, conditional)
**Lokasi**: `fomo-drama/index.js` fallback `Judul — Ep X` / `Judul — Part N (Ep A-B)` (tanpa `➧`).
- Format lama hanya baca `epNum`/`partNum`, **tanpa `season`** → disimpan `season=null` (0).
- Utk S2/S3/S4, jika ada caption lama tanpa `➧ Season`, akan masuk `season=0` (keluar dari `season 2/3/4`) → salah.

**Kenapa tidak dipicu PRJS**: PRJS `080509c` selalu `➧ Season :- / Episode :-` dengan prefix, jadi fallback old-format tidak pernah ke-trigger.

**Saran patch fomo (server kamu)**: utk fallback old-format, tambah deteksi season dari judul (`S2`/`Season 2` suffix) sebelum simpan, atau set `season` sesuai.

### R3-R5 — Aman (tanpa aksi)
- **Dedupe duplicate**: OK via `UNIQUE(media_slug, season, part)` + season-aware `find` (`_saveOnePart`).
- **Race batch**: PRJS upload 12 ep → auto-save queue sequential (`_processUploadQueue` edit in-place, bukan spam). Aman.
- **Category unknown → drama**: sudah fix `DEFAULT_SCRAPER_KATEGORI=auto`; Movie samehadaku bug sudah fix di PRJS (`TsSDKMGnoKh → source_pattern`).

## Konsistensi caption (verified)
| PRJS kirim | fomo parse |
|---|---|
| `➧ Season :- 3 Episode 19` | `{title:..S3, ep:19, season:3}` |
| `➧ Episode :- 19` (S1) | `{title:.., ep:19, season:null}` |
| `➧ Season :- 2 Part 2 Episode 1` | `{title:..S2 P2, ep:1, season:2}` |

fomo saat ini `Already up to date` (commit `4ecd3da`+`ed4fd6f` = hilangkan kata redundan `Season`/`Episode` di label, sinkron PRJS). Tidak perlu ubah kode dari workspace ini.