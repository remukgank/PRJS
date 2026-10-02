# 2026-10-02 — Link Vidara bentuk `/e/` di ketiga jalur caption (B+ · proposal fomo-drama)

**Date**: 2026-10-02
**Author**: opencode
**Approve user**: "B+ (ketiganya)" — dengan hasil uji 4 URL HTTP 200 dari user.

## Root Cause

Proposal masuk dari repo fomo-drama (commit `119cbb1`,
`docs/proposals/2026-10-02-prjs-link-vidara-domain.md`): caption PRJS
menghasilkan link bentuk `/{code}`, sedangkan validator fomo-drama hanya
menerima `/e/` atau `/d/` → `source_path` di `media_parts` kosong.

Trace PRJS memperluas temuan fomo-drama — **tiga** pembentuk link memakai
bentuk salah, bukan satu:

| # | Lokasi | Kondisi sebelum |
|---|--------|-----------------|
| 1 | `handlers/vidara.js:252` (caption drama) | `https://${saveDomain}/${code}` |
| 2 | `handlers/vidoy.js vidaraLinkFromRecord` (episode di-skip) | `https://${host}/${code}` |
| 3 | `vidara-uploader.js buildVideoLink` (upload anime) | `apiLink` dipakai apa adanya (`/video/info` balas **tanpa** `/e/` — live-tested: `https://vidara.to/IIV7...`) + fallback `host+code` |

Fakta pendukung:
- URL upload API asli **sudah** `/e/` (`{"filecode":"https://vidara.to/e/0ijm..."}`)
  — hanya dibuang `extractUploadRef` yang hanya mempertahankan `code`.
- Pesan info upload di `vidara.js:95/138/314` **sudah** memakai `/e/` → hanya
  caption & rekonstruksi yang tertinggal.
- **Masalah A (domain) ditutup oleh uji user**: 4 URL — `vidara.to`/`iosbgaigo.com`/`sgoabjgio.com` × `/e/` & `/{code}` — **semua HTTP 200**; ketiga domain = alias layanan sama, host player rotating (`sgoabjgio` → `gbsagbo`) → **tidak mengejar host**, `saveDomain` dipertahankan.

## Keputusan desain

- **B+ sinkron, bukan 1 baris**: kalau hanya #1 yang diubah, batch yang sama
  menghasilkan link diterima (upload) dan ditolak (skip) — persis peringatan
  komentar lama `buildVideoLink` ("dua bentuk beda bikin caption dan DB tidak
  sinkron").
- `toEmbedUrl()` di `buildVideoLink` menyamakan `apiLink`/`ref.url` — sisip
  `/e/` hanya kalau path = 1 segmen dan bukan `e` (path lain tidak disentuh).
- **Syarat fomo-drama dijaga**: baris `➧ Server :- VIDARA` tetap ikut di
  ketiga jalur (`vidara.js:259` bersyarat `vidaraLink`, `captionServer` anime
  v3.6.0) — tanpa baris itu fomo-drama menganggap link = VIDOY.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/handlers/vidara.js` | `:252` → `https://${saveDomain}/e/${vidaraCode}` |
| `scraper/handlers/vidoy.js` | `vidaraLinkFromRecord` → `https://${host}/e/${code}` |
| `scraper/vidara-uploader.js` | `buildVideoLink` → semua cabang bentuk `/e/`; helper baru `toEmbedUrl` (di-export) |
| `scraper/tests/test-vidara-anime.js` | #20/#21 expected → `/e/` (asumsi lama sengaja diungkit); #18 regex → bentuk `captionLink` v3.6.0 (**sudah gagal sebelum B+** — dibuktikan `git stash`, regresi test sejak ed012d4) |
| `.tests/vidara-embed-link.js` (baru) | 16 tes: toEmbedUrl · buildVideoLink 4 cabang · source ketiga titik · syarat baris Server · **LIVE** `/video/info` → `/e/` |

## Verification

- `node --check` lulus (3 file).
- Test: `.tests/vidara-embed-link` 16 · `test-vidara-anime` 25 ·
  `caption-server-line` 13 · `status-tg-proof` 7 · `test-media-contract` 12 ·
  `test-episode-status` 11 · `test-btn-style` 10 · `test-vidoy-uploader` 164 —
  **total 258 pass, 0 fail**.
- LIVE: `videoInfo('IIV7UjteaSEbx').link` = `https://vidara.to/IIV7...`
  → `buildVideoLink` → `https://vidara.to/e/IIV7...` (assert pola `https://<host>/e/<code>`).
- Uji HTTP 4 URL oleh user (2 Okt): semua 200 — `/e/` hidup di semua domain.

## Catatan / luar scope

- `scraper/vidara.js makeEmbedUrl` (`https://vidara.so/e/...`, mematok domain)
  = **dead code** — tidak ada pemanggil di luar def/export.
- `scraper/vidoy-uploader.js` terdeteksi `file` = **data (binary)**, bukan JS —
  tidak ikut diuji/diubah; perlu pengecekan terpisah.
- Pengaman sisi fomo-drama (deteksi domain Vidara tanpa marker `Server`)
  = urusan fomo-drama, menyusul opsional (proposal mereka §opsional).
