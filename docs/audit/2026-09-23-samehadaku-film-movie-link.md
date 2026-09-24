# Fix halaman film/movie Samehadaku (slug non-numerik `-episode-movie`)

**Date**: 2026-09-23
**Author**: opencode
**Source**: dokumen resmi Bot API 10.3 via r.jina.ai (cross-check method & alur) + inspeksi HTML asli samehadaku
**Proposal**: disetujui user

## Root Cause

Halaman film Samehadaku `/anime/<slug>/` **tidak punya** blok download; satu-satunya
link ada di container `lstepsiode` dengan slug **non-numerik**:
`https://v2.samehadaku.how/<slug>-episode-movie/`. Blok download (11 `li>strong`:
360p/480p/720p/1080p/MP4HD/FULLHD, 11 gofile.io + 11 pixeldrain.com) ada di
**sub-halaman** `-episode-movie/` tersebut.

Worker `gofile-worker.js` gagal menjangkau link itu:
1. `epRe` (semula baris 105) hanya menerima `-episode-(\d+)` → tak match `-episode-movie`.
2. Fallback `bareRe` **menyingkirkan** slug contain `-episode-` (pagar `#-episode-`),
   termasuk link film yang justru pola non-numerik itu.
3. Hasilnya `episodes` kosong → fall-through parse blok download **di halaman film**
   (kosong) → `404 {"ok":false,"message":"no FULLHD/4K servers found"}` → bot balas
   "⚠️ Samehadaku gagal: Halaman ini belum tersedia untuk download" (`scraper/bot.js:2676-2678`).

Reproduksi: `GET /samehadaku?url=.../anime/assassination-classroom-the-movie-our-time/`
→ `{"ok":false,"message":"no FULLHD/4K servers found","blocks":{}}` (sebelum fix).

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `gofile-worker.js` | Tambah helper `QUALITY_ORDER`, `parseDownloadBlocks(html)` (ekstrak parser blok download yang sebelumnya inline, agar bisa dipakai ulang), `detectSinglePageLink(html, scope)` (cari link `-episode-(movie\|ova\|special\|batch\|ona)` di scope `lstepsiode`); di cabang `isAnime`, bila `episodes` kosong → **fetch sub-halaman film** (helper + `CF_CLEARANCE` yang sama) → parse blok → balas `{ok:true, type:'episode', quality, servers, blocks, via:'single'}`; jalur "no servers" sekarang pakai `parseDownloadBlocks` (tidak ada lagi duplikat parser) |
| `scraper/tests/test-samehadaku-movie-link.js` (baru) | 6 test offline: deteksi link `-episode-movie` di scope `lstepsiode`; sub-halaman → quality tertinggi `FULLHD` + gofile & pixeldrain; halaman film tanpa sub-page → fallback aman (tak ada server); halaman anime episode-angka **tak** false-positive; varian slug `MOVIE/OVA/special/batch` terdeteksi; guard anti-drift helper worker |
| `docs/audit/2026-09-23-hapus-dead-code-paid-media-quota.md` | (terpisah) |

Tidak ada perubahan kode PRJS (bot): `bot.js` sudah menangani `type:'episode'` →
user kirim link film langsung dapat tombol pilih server, tanpa ketukan extra.
Server/Worker tak diubah jumlah panggilan untuk halaman non-film.

## Detail Teknis

- Deteksi dibatasi **di dalam scope `lstepsiode`** (sudah di-capture sbg `listHtml`),
  jadi link movie/menu di luar list tak ikut tertangkap.
- Label case-insensitive (`-episode-MOVIE` dst) & anchor teks apa pun (regex tak
  bergantung isi teks anchor, hanya `href`).
- Halaman anime normal (episode angka) tetap di jalur `episodes` — diverifikasi nol
  false-positive.
- Fallback: fetch sub-halaman gagal/404 →Worker tetap balas `ok:false` (tak ada error
  baru, tak ada silent break).
- Error mapping `bot.js:2676` (`no FULLHD|no servers`) tetap cocok untuk kasus film
  yang memang belum ada file.
- Verifikasi silang klaim "nama server" (fix 5bd112e) & caption part-batch (4df07c5)
  terhadap docs 10.3: `sendPaidMedia` path dihapus (dead code), `Message.paid_media`
  tak dipakai lagi — tak ada sisa ketidaksesuaian API di jalur aktif.

## Verification

- `gofile-worker.js` lolos syntax check (ESM, disalin ke `.mjs`).
- Test baru `test-samehadaku-movie-link.js`: **6 pass, 0 fail**.
- Regresi samehadaku: `test-samehadaku-parse-ep1` 14, `test-sam-prescan`, `test-sam-picker-pagination` 7, `test-samehadaku-ep1-slug` 22, `test-samehadaku-slugtail-fallbacks` 28, `test-download-sam-batch` — semua hijau.
- **Simulasi end-to-end dengan helper worker asli + HTML film asli** (bukan dummy):
  deteksi link movie OK → sub-halaman → `FULLHD` + `gofile, pixeldrain`.
- Skenario functional setelah deploy Worker: kirim `https://v2.samehadaku.how/anime/assassination-classroom-the-movie-our-time/`
  → bot menampilkan "📺 Samehadaku FULLHD" + tombol Gofile/Pixeldrain (bukan pesan
  gagal) → unduh & kirim video normal.
- Deploy Worker: **manual paste ke dashboard Cloudflare** (tidak ada wrangler/CF token
  di env). Tidak ada restart bot PRJS (kode PRJS tak berubah).

## Catatan

- Depan (belum diminta): halaman `/anime/` dengan `lstepsiode` kosong & blok download
  di halaman yang sama sudah tertangani jalur fall-through yang ada (tanpa ubah).
