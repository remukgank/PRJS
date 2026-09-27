# Fix Judul di Preview Link Provider (Kamenime)

**Date**: 2026-09-27
**Author**: Hermes (trace + implementasi), lewat review user

## Root Cause

Empat tempat di `scraper/bot.js` menyelesaikan judul untuk alur "link provider
langsung", dan keempatnya punya cacat berbeda:

| # | Lokasi (bot.js) | Cacat |
|---|---|---|
| 1 | 3243-3265 entry URL kamenime | `titleShown = detectedTitle ? ... : null` — null kalau judul belum ada di library, padahal judul bisa diekstrak dari nama file |
| 2 | 3505-3525 picker `kam_ep` | `dTitle = detectedTitle ? ... : null` — sama; judul tidak pernah ditampilkan di teks prompt |
| 3 | 4350-4358 preview "📥 Download" | `titleShown = detectedTitle \|\| fileName` — tidak membaca `customTitle` sama sekali; `takeCustomTitle()` baru dipanggil 20 baris kemudian di blok `dl_go:` |
| 4 | 4402-4410 `titleForCap` | `customTitle \|\| detectedTitle` — tanpa fallback judul dari nama file, jadi caption jatuh ke nama file mentah |

Dua konsekuensi yang dilaporkan user:
- Ketik "Ganti Judul" → preview tetap menampilkan nama file mentah (`Naruto Shippuden-episode-2.mp4`)
- Tombol preview tidak se-detail provider lain, karena nama file kamenime bentuknya polos (title aslinya tersembunyi di sufiks)

Catatan: judul hasil ketikan **memang tidak bisa lintas episode** — `customTitleMap`
di-key by URL lengkap (`bot.js:46`), jadi episode 1 tidak boleh bocor ke episode 2.
Itu perilaku yang benar, bukan bug.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` | 4 lokasi resolusi judul + fungsi `peekCustomTitle()` baru |
| `scraper/tests/test-preview-judul-resolusi.js` | BARU — 11 test |
| `scraper/tests/test-kamenime-provider.js` | assertion (u) dilonggarkan: menguji urutan prioritas, bukan format string |
| `docs/proposals/2026-09-27-custom-title-telegram.md` | proposal + trace |

## Detail Teknis

Urutan prioritas yang dipakai di setiap prompt/preview:

```
1. customTitle                             ← dari "Ganti Judul"
2. detectedTitle (library)                 ← kalau sudah pernah masuk library
3. kamenimeTitleFromFileName(fileName)     ← judul asli, KAMENIME SAJA
4. fileName                                ← fallback terakhir
```

Langkah 3 memakai fungsi yang **sudah ada** di `providers/kamenime.js`
(dipakai jalur Vidoy di `bot.js:4419`), jadi tidak ada request tambahan:

```
"Naruto Shippuden-episode-2.mp4"  ->  "Naruto Shippuden"
"One Piece-episode-1050.mp4"       ->  "One Piece"
"Bleach-episode-1.mp4"            ->  "Bleach"
```

Langkah 3 dikunci `isKamenimeUrl(url)` — provider lain tidak berubah, karena
nama file mereka sudah berbentuk metadata (`TSSDK-S2-P2-1-FULLHD.mp4`).

### `peekCustomTitle()`

`takeCustomTitle()` bersifat destruktif (menghapus entri dari map, `bot.js:48-51`).
Preview (lokasi 3) dan `dl_go:` (lokasi 4) adalah dua callback terpisah, jadi kalau
preview memakai `takeCustomTitle()`, nilainya habis dan `dl_go:` menerima `null` —
persis gejala "judul hilang di layar". Karena itu preview memakai `peekCustomTitle()`
(yang hanya membaca), dan `takeCustomTitle()` tetap dipakai satu kali di `dl_go:`.

### Yang SENGAJA tidak diubah

- **Label `hokireceh`** — keputusan user (commit `17f3ea4`), ada test yang
  menguncinya (`test-kamenime-provider.js` kasus q & x). Proposal versi awal
  menyebutnya bug; itu ditarik kembali setelah trace.
- **Cabang `dl_go:tg`** — sudah memakai `titleForCap` (gofile, gdrive, pixeldrain,
  filedon, kamenime, mega). Hanya `titleForCap`-nya yang lacked fallback, dan itu
  yang diperbaiki.
- **Logika season/part gdrive** (`bot.js:4411-4427`) — dipertahankan utuh.

## Verification

**Bukti run** (`kamenimeTitleFromFileName`):

```
"Naruto Shippuden-episode-2.mp4"   ->  "Naruto Shippuden"
"One Piece-episode-1050.mp4"       ->  "One Piece"
"Bleach-episode-1.mp4"             ->  "Bleach"
"Naruto Shippuden-episode-500.mp4" ->  "Naruto Shippuden"
"some-anime-ep 7.mkv"              ->  "some-anime"
```

**Test**: 11 pass / 0 fail (`test-preview-judul-resolusi.js`)
Test membaca `bot.js` asli — bukan menyalin logikanya — supaya mengunci kode yang
benar-benar jalan.

**Mutasi wajib** (semua tertangkap):

| Mutasi | Hasil |
|--------|-------|
| preview kembali `detectedTitle \|\| fileName` | 9 pass / 2 fail |
| entry URL hapus `kamenimeTitleFromFileName` | 9 pass / 2 fail |
| picker `kam_ep` hapus judul dari nama file | 10 pass / 1 fail |
| preview pakai `takeCustomTitle` (destruktif) | 10 pass / 1 fail |
| `titleForCap` kehilangan fallback | 10 pass / 1 fail |
| `kmTitle` tidak dikunci `isKamenimeUrl` | 10 pass / 1 fail |
| (dikembalikan) | 11 pass / 0 fail |

**Suite penuh**: kamenime 26 · preview-judul 11 · media-contract 10 ·
vidoy-uploader 157 · downloadto-speed-floor 10 — semua 0 fail.

**Deploy**: `pm2 restart prjs-bot` → PID 20403, `Bot running` 10:18:05.
