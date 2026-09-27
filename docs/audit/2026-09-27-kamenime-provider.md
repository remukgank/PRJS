# Provider kamenime: MP4 direct

**Tanggal:** 27 Sep 2026
**File:** `scraper/providers/kamenime.js` (baru), `scraper/handlers/download.js`, `scraper/bot.js`, `scraper/tests/test-kamenime-provider.js` (baru)
**Status:** kode selesai + terverifikasi. **Belum di-deploy** (butuh restart pm2).

---

## 1. Masalah

Host gdriveplayer (server Samehadaku) sekarat: 20–120 KB/s, 43,7 MB dalam 18 menit,
3× retry sia-sia, 65 MB terbuang. Commit `e632358` + `ca1f013` (speed floor +
fail-fast) hanya **membatas** kerusakan, tidak menyelamatkan unduhan.

Scan 75 episode Naruto Shippuuden (`logs/app.log` + probe worker):

| server | jumlah |
|---|---|
| gdriveplayer + reupload | 57 |
| gdriveplayer + mirrored | 10 |
| gdriveplayer saja | 5 (ep 21, 27, 28, 29, 47) |
| reupload saja | 1 (ep 57) |
| 404 | 2 (ep 14, 58) |

**gofile / pixeldrain / filedon = TIDAK ADA** di anime ini. Jadi tidak ada server
cepat di Samehadaku sama sekali.

## 2. Probe kamenime (verified 27 Sep 2026)

| | |
|---|---|
| halaman `/anime/naruto-shippuden/episode/1` | HTTP 200, 156.163 bytes, ada `<source src="/storage/...">` |
| file | 121.331.884 bytes (115,7 MB) |
| signature | `ftypisom` — MP4 valid |
| kecepatan | 3,2–9,4 MB/s (probe 10 dtk) |
| Content-Length | tidak ada |
| Accept-Ranges / Range | **diabaikan** (HTTP/2 200, bukan 206) |
| worker Cloudflare | tidak diperlukan |

≈ **200× lebih cepat** dari gdriveplayer, dan **MP4 jadi** (tanpa remux).

## 3. Perubahan

### 3.1 `providers/kamenime.js` (baru)
- `isKamenimeUrl(url)` — dua bentuk: `/storage/…mp4` dan `/anime/<slug>/episode/<N>`.
  Menolak domain menipu (`kamenime.com.evil.tld`) dan halaman anime tanpa `/episode/N`.
- `resolveKamenimeFile(url)`:
  - bentuk `/storage/` → **instan, tanpa request sama sekali** (sudah URL final)
  - bentuk `/episode/N` → 1 GET, parse `<source src="…">`, decode HTML entity
- `absolutize()` — **tidak** memakai `encodeURI` (lihat §4).

### 3.2 `handlers/download.js`
- `resolveDirectUrl()` — cabang kamenime, **sebelum** `isGdrivePlayerUrl`.
- `handleKamenimeUrl()` — unduh via `downloadTo` (bukan aria2c), **tanpa remux**,
  kirim via `sendAnimeMedia` (`supports_streaming: true`).
- import `downloadTo` dari `services/vidaraService`.

### 3.3 `bot.js` — 6 titik
import · dispatcher pesan link · `pendingDownloads` handler · provider label ·
`dl_go:tg` dispatch · pesan "Link tidak dikenali" (tambah `kamenime.com`).

## 4. Dua jebakan yang tertangkap test

**a) Double-encode.** Versi pertama `absolutize()` memakai `encodeURI`, yang
mengubah `%20` → `%2520` pada input yang sudah ter-encode. Test (b) gagal
("fileUrl harus persis input"). Perbaikan: `new URL()` sudah mem-percent-encode
space sendiri, jadi cukup decode entity lalu teruskan ke URL constructor.

**b) Salah tangkap `indexOf`.** Test (e) awalnya memakai `src.indexOf('if
(isGdrivePlayerUrl(url)) {')` di seluruh file — string itu juga muncul di
`downloadSamehadakuFile`, sehingga membandingkan indeks dari fungsi yang salah.
Diperbaiki: slice body `resolveDirectUrl` dulu.

## 5. Verifikasi

`test-kamenime-provider.js` — **8 pass / 0 fail**.

| kasus | hasil |
|---|---|
| a) `/episode/1` → URL `.mp4` benar, tanpa space mentah | ✅ |
| b) `/storage/` → persis input, **0 request** | ✅ |
| c) 9 URL non-kamenime (termasuk domain menipu) → `false` | ✅ |
| d) halaman tanpa `<source>` → error menyebut `<source>` | ✅ |
| e) urutan guard kamenime < gdriveplayer (scoped ke `resolveDirectUrl`) | ✅ |
| f) `handleKamenimeUrl` tanpa remux + pertahankan `.mp4` + `sendAnimeMedia` | ✅ |
| g) caption 3 baris `Judul`/`Episode`/`Provider` | ✅ |
| h) encode space + decode `&amp;` | ✅ |

Bukti mutasi:

| mutasi | hasil |
|---|---|
| cabang kamenime dipindah **sesudah** gdriveplayer | 7 pass / **1 fail** (e) |
| `handleKamenimeUrl` memakai `remuxToMp4` | 7 pass / **1 fail** (f) |

Bukti nyata (3 URL, resolver asli):

```
/episode/1    → .../Naruto%20Shippuden/Naruto%20Shippuden-episode-1.mp4
/episode/500  → .../Naruto%20Shippuden/Naruto%20Shippuden-episode-500.mp4
/storage/     → (instan, tanpa request)
```

`test-samehadaku-movie-link.js` diperbarui: hitungan call-site `epCapLabel(`
6 → 7 (kamenime ikut memakainya).

Suite penuh: **227 pass / 0 fail**.

## 6. Batas yang diketahui

- **Tidak ada listing episode.** Halaman `/anime/<slug>` cuma 37 KB dan tidak
  memuat daftar episode (dimuat via Livewire AJAX). Jadi provider ini
  **per-episode**: caller harus sudah tahu slug + nomor episode. Integrating ke
  picker Samehadaku butuh pekerjaan terpisah (parsing Livewire) dan TIDAK
  dikerjakan sekarang.
- **Range diabaikan** (200, bukan 206) — tidak ada resume. Karena unduhan hanya
  ±20 detik, dan `downloadTo` kini fail-fast dengan pesan "tidak mendukung
  resume" alih-alih restart dari nol, ini trade-off yang diterima.
- Caption memakai 3 baris (`Judul`/`Episode`/`Provider`), mengikuti pola
  `handleFiledonUrl`. Kalau label link 4 baris diperlukan untuk target tertentu,
  itu penyesuaian terpisah.

## 7. Catatan legal

Konten yang diunduh adalah materi berhak cipta tanpa izin. Menambahkan domain
baru berarti menambah sumber distribusi; keputusan itu ada di pemilik proyek,
bukan di perubahan kode ini.
