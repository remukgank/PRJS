# Fix H3 — findMediaByPattern Case-Insensitive (Batch B)

**Date**: 2026-09-03
**Author**: opencode
**Status**: Batch B — di-approve & diimplementasikan (setelah enumerasi H3 0 collision & verifikasi Batch A)

## Root Cause

`findMediaByPattern` di `scraper/db.js:390` pakai `WHERE source_pattern = $1` (exact, case-sensitive). File Samehadaku lewat `extractSourcePattern` bisa return SHORT huruf kapital (`TSSDK`), sedangkan DB menyimpan lowercase (`kuronime-tssdk`) atau mixed case (`TsSDKMGnoKh`). Akibatnya auto-detect judul gagal untuk variasi kapitalisasi yang sama pattern-nya.

Sebelumnya di-fix via workaround per-handler (tambah fallback `parseSamehadakuFilename` + alias lowercase di 4 handler) — duplikat & rawan lupa.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/db.js:390` | `WHERE source_pattern = $1` → `WHERE LOWER(source_pattern) = LOWER($1)` |
| `scraper/bot.js` | Hapus trigger buatan Batch A (`/__throw_test_message`, `__throw_test_callback`, setup) — batch A fully verified |

## Detail Teknis

- Ubah query jadi case-insensitive via `LOWER()` di kedua sisi, bukan `ILIKE` (lebih eksplisit, tanpa wildcard).
- Tidak mengubah index/struktur lain — `source_pattern` tetap disimpan apa adanya, hanya pencocokan yang case-insensitive.
- Fallback `parseSamehadakuFilename` di handler yang sudah ada tetap dipertahankan (menangani kasus `TSSDK` vs `kuronime-tssdk` yang beda string, bukan cuma beda kapitalisasi).

## Verification

- `node --check scraper/db.js` — lulus
- `node --check scraper/bot.js` — lulus (setelah hapus trigger)
- **Functional test** — re-test 15 source_pattern dari enumerasi H3 dengan variasi kapitalisasi:

  ```
  kuronime-tssdk / KURONIME-TSSDK / Kuronime-Tssdk → anime:tensei-shitara-slime-datta-ken ✓
  TSSDK-S2-P2 / tssdk-s2-p2 → anime:tensei-shitara-slime-datta-ken-s2-p2 ✓
  TsSDKMGnoKh / tssdkmgnokh / TSSDKMGNOKH → anime:...-guren-no-kizuna-hen ✓
  kuronime-kjny / KURONIME-KJNY → anime:kaifuku... ✓
  tss / TSS → anime:tensei...-s4 ✓
  tensei-s3 / TENSEI-S3 → anime:tensei...-s3 ✓
  ```

  Hasil: **15 pass, 0 fail**. Negative check `tss` vs `kuronime-tssdk` tetap distinct (tidak salah-match), non-existent pattern return null.

## Catatan

Batch B ini root fix untuk H3. Batch C (dedup helper `detectTitleFromFilename`) depends on Batch B — baru dibahas setelah Batch B di-log (sesuai urutan approved).
