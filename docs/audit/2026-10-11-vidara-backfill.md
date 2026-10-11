# Audit — Backfill Vidara: target `🗜 Vidara` mengisi episode yang sudah ada di Vidoy

**Tanggal:** 11 Okt 2026
**Status:** ✅ Di-approve user, diimplement, diuji (26/26 test vidara-anime)
**Scope:** `scraper/handlers/vidoy.js` (guard pre-check), `scraper/tests/test-vidara-anime.js`

---

## 1. Masalah

Guard kanonik lama:

```js
if (preVidoy && (!needTg || hasTg)) { return skip 'sudah ada di Vidoy'; }
```

Bertujuan mencegah duplikat & pemborosan, tapi berdampak: target **`🗜 Vidara`**
(backfill eksplisit user) **melewatkan episode yang sudah ada di Vidoy** →
koleksi Vidara **tidak lengkap** (kasus Super Dragon Ball Heroes: Ep 1–2 di
Vidoy, Ep 3–55 kosong → backfill menghasilkan Vidara tanpa Ep 1–2).
User: *"konyol itu jika tidak lengkap"*.

## 2. Root cause

Guard tidak membedakan **target**. Untuk `vyt` (Vidoy+TG) skip memang benar
(episode sudah sah di Vidoy, tidak ada kerja). Tapi untuk `v` (Vidara saja)
masih ada kerja nyata: **upload ke Vidara** yang belum punya record.

## 3. Fix (1 guard, khusus target `v`)

```js
// scraper/handlers/vidoy.js
const backfillVidara = target === 'v' && !preVidara;
if (preVidoy && !backfillVidara && (!needTg || hasTg)) { return skip; }
```

- **`v` + episode di Vidoy + TANPA record Vidara** → diproses (diunduh → upload
  Vidara → record dibuat, tanpa sentuh Telegram).
- **`v` + episode sudah punya record Vidara** → tetap skip (dedupe per-akun
  utuh — 1 episode = 1 file).
- **`vt` / `vyt` / `vy`** → guard lama berlaku penuh (tidak ada perubahan:
  vt/vyt tidak akan mengirim ulang TG massal).

Keamanan lanjutan: file hasil backfill **permanen** — jalur "Vidara dibersihkan
setelah masuk Vidoy" hanya aktif di alur upload Vidoy (`if (res)`), yang tidak
dilewati target `v` (`needVidoy=false` → `res` null).

## 4. Bukti

- `node --check scraper/handlers/vidoy.js` ✓
- `.tests/` + `scraper/tests/`:
  - `test-vidara-anime.js` **26/26** — termasuk test baru **8b** (flag
    `backfillVidara = target === 'v' && !preVidara` + guard memakai `!backfillVidara`)
  - `test-media-contract.js` 12/12 ✓
  - `vidara-multi-account.js` 9/9 ✓
  - `batch-skip-vt.js` 8/8 ✓
- Guard dipakai oleh 4 target (`v`/`vv`/`vt`/`vyt` — lihat preVidoy yang di-
  fetch di blok `needVidara`), hanya `v` yang longgar.

## 5. Efek untuk kasus SDBH

`🗜 Vidara` untuk Super Dragon Ball Heroes kini: **Ep 1–2 ikut di-backfill**
(diunduh → Vidara, tanpa TG) + Ep 3–55 seperti sebelumnya → koleksi Vidara
lengkap 55 episode. `🗜 Vidara + TG` tidak berubah (Ep 1–2 tetap skip).
