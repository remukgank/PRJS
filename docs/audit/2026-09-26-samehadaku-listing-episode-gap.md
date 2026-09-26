# Samehadaku listing: 26 episode tidak terbaca (Naruto 474 dari 500)

**Tanggal:** 26 Sep 2026
**File:** `gofile-worker.js` (Cloudflare Worker — deploy manual)
**Status:** kode selesai + terverifikasi live. **BELUM di-deploy** (lihat §Deploy).

---

## 1. Akar masalah (terverifikasi dari HTML asli, bukan asumsi)

HTML listing asli: `/tmp/ns_list.html` (249.904 bytes, diambil via FlareSolverr).

Regex lama (`gofile-worker.js:181`):

```js
/<a[^>]+href="([^"]+(?:-episode-|-エピソード-)(\d+)(?:-?(?:end|END|End))?\/?)"[^>]*>([^<]+)<\/a>/gi
```

Dijalankan langsung ke HTML asli → **474 episode unik**, hilang **26** nomor:

```
hilang: 24,57,58,64,65,68,69,76,77,78,79,82,86,87,101,102,119,120,
        127,128,129,130,152,153,466,500
```

Tiga penyebab berbeda, dipisahkan dengan instrumentasi sumber per episode
(`epRe` 474, `bareRe` 0, `ep1Re` 0 → semuanya dari `epRe`):

### Kasus A — halaman batch 2 episode (22 episode)
Link berbentuk `-episode-N-M/` tidak cocok regex lama (regex menuntut `\/?$`
tepat setelah angka). Terverifikasi 11 link berurutan:

```
57-58, 64-65, 68-69, 76-77, 78-79, 86-87, 101-102,
119-120, 127-128, 129-130, 152-153
```

Halaman batch **memang** berisi server — terverifikasi:
`naruto-shippuuden-episode-57-58/` → title "Naruto: Shippuuden Episode 57-58",
block 360p/480p/720p (reupload, gdriveplayer).

### Kasus B — episode yang tidak di-link (2 episode: 24 & 500)
- **ep 24** → hidup di `naruto-shippuuden-episode-24/` (double-u), server 360p/480p/720p.
- **ep 500** → hidup di `naruto-shippuden-episode-500/` (single-u, **tanpa** suffix).
  Di listing, ep 500 **hanya muncul di dalam HTML comment**:
  `<!-- <div class="all-eps-btn"><a href="...episode-500-selesai/">... -->`
  Regex lama tidak menangkapnya (suffix `-selesai` tidak dikenal).

### Kasus C — slug beda ejaan per rentang episode
Terverifikasi dari HTML asli:

| slug | rentang episode |
|---|---|
| `naruto-shippuuden` (double-u) | ep 1–250 |
| `naruto-shippuden` (single-u) | ep 251–500 |

Artinya kunci ejaan **tidak bisa ditebak dari range** — harus diambil dari
listing itu sendiri.

### Yang memang tidak pernah di-upload (2 episode: 82 & 466)
Diprobe **semua 4 varian** (double-u/single-u × dengan/tanpa `-selesai`/`-end`):

```
naruto-shippuuden-episode-82/        → 200, 238.621 B, tanpa server (placeholder)
naruto-shippuden-episode-82/         → sama
naruto-shippuuden-episode-466/       → sama
naruto-shippuden-episode-466/        → sama
```

Tetangga mereka hidup (81, 83, 465, 467) → memang bolong, bukan kesalahan probe.

> **Catatan koreksi:** ep 465 sempat disangka bolong karena tidak punya
> FULLHD/4K. Ternyata **hidup** — punya server 360p/480p/720p, dan memang
> sudah ada di listing (ter-parse normal). Jadi bolong sebenarnya hanya
> **82 & 466**, dan target yang benar adalah **498**, bukan 500.

---

## 2. Dua jebakan yang tidak boleh di-expand

Ada pola yang menyerupai batch tapi **bukan** batch:

```
naruto-shippuuden-episode-23-2    (selisih -21)
naruto-shippuden-episode-467-2   (selisih -465)
```

Keduanya `ok=false` saat di-resolve, sedangkan `episode-467/` (tanpa suffix)
hidup. Aturan expand **hanya** berlaku bila `M == N+1`.

---

## 3. Perubahan kode (`gofile-worker.js`)

### 3.1 Regex `epRe` — tangkap pasangan batch
```js
const epRe = /<a[^>]+href="([^"]+(?:-episode-|-エピソード-)(\d+)(?:-(\d+))?(?:-?(?:end|END|End))?\/?)"[^>]*>([^<]+)<\/a>/gi;
```
Group 3 = nomor kedua. Suffix non-angka (`-selesai`) sengaja **tidak**
ditangkap — link itu sering hanya hidup di HTML comment.

### 3.2 Ekspansi batch bersyarat
```js
const nums = numPair !== null && numPair === num + 1 ? [num, numPair] : [num];
```
Judul tiap entri dibedakan lewat `episodeTitleFor(title, n)` — anchor
"Episode 57-58" menjadi "Episode 57" / "Episode 58".

### 3.3 Gap healing (`healEpisodeGaps`)
Probe nomor yang tidak ada di listing, dengan batas ketat:

| parameter | nilai | alasan |
|---|---|---|
| `GAP_PROBE_BUDGET` | 5 | maks **nomor** per listing (bukan request) |
| `GAP_MAX_GAP` | 3 | hanya celah kecil di tengah range |
| ekor | `rawMax+1`, `rawMax+2` | `rawMax` = nomor terakhir yang muncul sebagai **link listing** (sebelum ekspansi batch) — supaya ekor yang sebenarnya (ep 500) ikut terlihat |

- Kandidat ejaan slug diambil dari **slug yang benar-benar muncul di listing**
  (bukan tebakan range), diurutkan mulai dari episode terdekat.
- Sukses bila halaman punya minimal satu server — kriteria yang **sama** dengan
  halaman episode biasa di worker ini (`parseDownloadBlocks(html).preferred`).
- Hasil di-cache per URL listing (`gapProbeCache`) supaya tidak probe ulang.

### 3.4 Helper baru (module-level)
`episodeSlugOf`, `episodeTitleFor`, `probeEpisodePage`, `healEpisodeGaps`,
`gapProbeCache`.

---

## 4. Verifikasi

### 4.1 Live — 3 anime, worker lama vs baru (via FlareSolverr)

| Anime | LAMA | BARU | catatan |
|---|---|---|---|
| Naruto Shippuden | 474 (max 499, 25 lubang) | **498** (max 500, 2 lubang) | +24 episode |
| Dragon Ball Heroes | 50 (0 lubang) | 50 (0 lubang) | sudah lengkap |
| Black Torch | 12 (0 lubang) | 12 (0 lubang) | sudah lengkap |

Slug DBH yang benar adalah `dragon-ball-heroes` (bukan `super-dragon-ball-heroes`
— slug itu balas halaman placeholder).

### 4.2 Regression test — `scraper/tests/test-samehadaku-listing-gaps.js`
**12 pass / 0 fail.** Fixture sintetis mereproduksi pola HTML asli (batch,
jebakan 23-2/467-2, ep 500 di dalam comment, slug beda ejaan).

| | hasil |
|---|---|
| dengan fix | **12 pass / 0 fail** |
| mutasi A (ekspansi batch dibatalkan) | 8 pass / **3 fail** |
| mutasi B (guard `M == N+1` dilepas) | 11 pass / **1 fail** |
| mutasi C (gap healing dimatikan) | 7 pass / **4 fail** |

---

## 5. Deploy — WAJIB MANUAL

`gofile-worker.js` = Cloudflare Worker. **Kode di repo tidak otomatis jalan.**

**Worker yang harus di-redeploy:** worker produksi `gofile-worker` (URL di
`GOFILE_WORKER_URL` pada environment bot).

**Langkah:**
1. Buka `https://dash.cloudflare.com` → Workers & Pages → pilih worker.
2. Tab **Edit code** → paste seluruh isi `gofile-worker.js` yang baru.
3. **Deploy** → tunggu aktif.
4. Pastikan secret `TOKEN` (GoFile) dan binding `CF_CLEARANCE` tidak berubah.

**Setelah redeploy, jalankan ulang verifikasi:**
```
Naruto Shippuden  → episodes.length harus 498 (bukan 474)
```

**Jangan nyatakan selesai sebelum user konfirmasi redeploy + hasil 498.**

---

## 6. Catatan biaya

Gap healing menambah request. Terukur: worker baru 185,7 detik untuk 3 anime
via FlareSolverr (dominan 5 probe Naruto × ~30 detik FlareSolverr), worker lama
13,3 detik. Di produksi (Cloudflare Worker + `cf.cacheTtl`) probe jauh lebih
cepat, dan cache per listing mencegah probe ulang.
