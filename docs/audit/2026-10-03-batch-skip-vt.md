# 2026-10-03 — Batch skip per-target: animeDoneMap baca juga record Vidara (approve owner)

**Date**: 2026-10-03
**Author**: opencode
**Approve user**: "Approve dan lanjutkan `node --check` HARUS clean… docs/api resmi, bukan asumsi… ikuti semua aturan."

## Root Cause

Batch `sam_allgo`/`kur_allgo`/`kam_allgo` menentukan "sudah lengkap" lewat
`animeDoneMap` (bot.js) yang **hanya membaca `vidoy_uploads`**:

```js
const rows = await listVidoyUploads(mediaKey, 'anime');
```

DBZ berjalan target `vt` (Vidara+TG) → `vidoy_uploads` kosong → map kosong →
syarat skip `st.link && st.hasTg` tidak pernah terpenuhi → **semua episode
di-download ulang + dikirim ulang** ke grup. Data produksi: `vidara_uploads`
DBZ = **144 record, 144 pointer TG, 0 tanpa pointer** (kemarin sudah selesai) —
tidak satu pun terbaca. Gejala: user "kemarin terakhir 144 kok ini balik ke 1".

## Keputusan

- `animeDoneMap(mediaKey, slug = null)` → **union 3 sumber bukti (AGENTS §6)**:
  `vidoy_uploads.pointer` ∪ `vidara_uploads.pointer` ∪ `media_parts.file_id`
  (butuh slug — dipasok runner samehadaku & kuronime; kamenime tanpa slug).
- Syarat skip **per target** via helper `episodeBatchDone(st, target)`:
  - `v`  → record Vidara ada = skip (tidak ada upload & tidak ada kirim)
  - `vt` → record Vidara **+ bukti TG** = skip (tanpa pointer → tetap jalan:
    file Vidara tidak bisa dipakai kirim TG, download memang perlu)
  - `vyt`/`vv`/`tg` → `link && hasTg` — **perilaku lama, tidak berubah**
- Mode `*_fix` (Lengkapi yang hilang) tidak disentuh — tetap `link && !hasTg`.
- Kunci record: `vidara_uploads.drama_key` = **judul** (sama dgn `media_key`
  yang diterima `animeDoneMap`) — terverifikasi `drama_key='Dragon Ball Z'`.

## Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` | `animeDoneMap` union 3 sumber + param `slug` · helper `episodeBatchDone` · 3 loop batch (sam/kur/kam) → `episodeBatchDone(st, target)` · **import `listVidaraUploads`** (jebakan §4: dipakai tapi tak di-import — ketahuan lewat cek statis, `node --check` lulus tapi akan `ReferenceError`) |
| `.tests/batch-skip-vt.js` (baru) | 8 tes: struktur union · import · 3 loop · helper 7 kasus · **DB asli DBZ (144 record → vt/v skip)** · ep tanpa record tetap jalan · mock terkontrol pointer separuh |
| `scraper/tests/test-vidoy-uploader.js` | test "2 runner" → pola `episodeBatchDone` (3 runner) · test runtime `animeDoneMap` diubah struktural (runner file itu **sync** — promise tak pernah di-await, lihat Catatan) + case runtime dipindah ke `.tests/batch-skip-vt.js` #8 |

## Verification

- `node --check` bot.js · test-vidoy-uploader · batch-skip-vt → **lulus ×3**.
- Cek statis identifier (§4): `listVidaraUploads` ketahuan belum di-import →
  diperbaiki sebelum test.
- Suite: `.tests/batch-skip-vt` 8/0 · `caption-server-line` 13/0 ·
  `status-tg-proof` 7/0 · `vidara-active-domain` 10/0 · `vidara-embed-link` 16/0 ·
  `vidara-series-folder` 14/0 · `test-vidara-anime` 25/0 ·
  `test-media-contract` 12/0 · `test-episode-status` 11/0 ·
  `test-btn-style` 10/0 · `test-vidoy-uploader` 164/0 ·
  `test-all-subdomains` exit 0 (live, sempat kena timeout 60s → ulang lulus)
  → **total 290 pass, 0 fail.**
- Bukti DB produksi (bukan asumsi): `COUNT … drama_key='Dragon Ball Z'` →
  `tanpa_tg=0`; map build asli → `record vidara=144`.

## API cross-check

- **Telegram Bot API** (core.telegram.org/bots/api): scope tidak memanggil
  method/param baru — murni logika lokal skip queue → tidak ada endpoint yang
  berubah.
- **Endpoint lain** (Vidara API): tidak disentuh pada fix ini.

## Catatan (luar scope — LAPORAN, belum dikerjakan)

- `test-vidoy-uploader.js` memakai runner **sync** (`t()` tanpa await) →
  **16 test async** di file itu selama ini "pass palsu" (promise dipotong
  `process.exit`). Perbaikan runner = perubahan besar → butuh approve terpisah.
- Batch lama (PID 326, kode sebelum fix) **masih berjalan** saat audit ini
  tulis → selama belum di-restart, download/kirim ulang berlanjut. Restart =
  owner (AGENTS §3).
