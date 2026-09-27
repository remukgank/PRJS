# Proposal — `kam_all:` Download Semua untuk Kamenime

**Tanggal**: 2026-09-27
**Status**: menunggu approve
**Latar**: tombol `⬇️ Download Semua (500)` di picker Kamenime adalah **pajangan** —
menolak dengan pesan, tidak menjalankan apa pun.

---

## 1. Trace — apa yang sudah ada

### 1.1 Alur `sam_all:` (Samehadaku) yang sudah jalan dan jadi acuan

```
sam_all:<id>            → tampilkan pilihan target (tg / vyt / vv) + "⟳ Lengkapi"
sam_allgo:<target>:<id> → samAllBusy lock → cache episode → filter "sudah ada"
                        → RichProgress SATU pesan untuk semua episode
                        → loop per episode
                        → rp.done() + rekap + blok link Vidoy
```

Bukti ada di `bot.js:3644-3847`.

### 1.2 Yang TIDAK ada di `handleKamenimeUrl`

```
handleKamenimeUrl(chatId, url, customTitle = null, expectedEp = null)   ← download.js:739
handleSamehadakuFile(..., { silent })                                    ← dipakai dgn silent:true
```

`handleKamenimeUrl` **tidak punya** parameter `silent`. while `sam_all:`
mengirim `silent: true` (`bot.js:3809`) supaya `RichProgress` per-file tidak dibuat.

**Kalau batch 500 episode dipanggil tanpa `silent`, hasilnya 500 pesan progres di
grup** — persis "spam" yang harus dihindari.

### 1.3 `_samQuiet` global dan risikonya

```
download.js:75    let _samQuiet = false;
download.js:77    if (_samQuiet) return Promise.resolve();     ← mematikan leafAlert
download.js:1067  const prevQuiet = _samQuiet;  _samQuiet = silent;
download.js:1157  } finally { _samQuiet = prevQuiet; }
download.js:1176  const prevQuiet = _samQuiet;  _samQuiet = silent;
download.js:1188  _samQuiet = prevQuiet;
```

`try/finally` **sudah ada** (1069-1157, 1176-1188) — jadi bukan soal jalur
exception. Risiko sebenarnya **interleaving**: batch A menyetel
`_samQuiet = true`, lalu selama `await` milik A, download manual B berjalan →
B ikut senyap. `try/finally` tidak menutup itu.

**Solusi: jangan pakai global sama sekali untuk jalur `tg`** — jadikan `silent`
parameter per-panggilan. Itu menutup di akar.

### 1.4 `actionAnimeEpisode` tidak menyentuh library — terkonfirmasi

`handlers/vidoy.js`, blok 174 baris, nol dari:

```
upsertMedia · savePartFileId · getPartFileId · getSetting('libsimpan') · media_parts
```

 imparted saja: `sendAnimeMedia` (topic Anime) + upload Vidoy. Jadi kalau batch
`vyt`/`vv` lewat `actionAnimeEpisode`, blok `download.js:817-824` **tidak pernah
jalan** → `media`/`media_parts` kosong → `!dell` tidak menemukan, status picker
tidak pernah hijau. Persis akar masalah yang kita bahas.

### 1.5 Resolusi judul sudah aman terhadap ejaan

```
download.js:763  patFile = kamenimeSourcePattern(url) || sanitizeSlug(kmName) || 'kamenime'
download.js:766  const m = await findMediaByPattern(patFile);  if (m) title = m.nama;
download.js:769  if (!title && customTitle) title = customTitle;
download.js:821  await upsertMedia(slug, title, 0, url, patFile);   ← patFile = source_pattern
```

`kamenimeSourcePattern` mengambil slug dari **path URL** (`/anime/<slug>`) →
`"naruto-shippuden"`. Jadi ejaan judul **tidak memengaruhi** `source_pattern`,
dan `findMediaByPattern` di episode berikutnya tetap menemukan. Tidak ada jebak
ejaan (`Shippuden` vs `Shippuuden`).

---

## 2. Empat koreksi dari review user

| # | Koreksi | Dampak kalau diabaikan |
|---|---------|------------------------|
| 1 | `silent` jadi **parameter per-panggilan** (opsi ke-5 `handleKamenimeUrl`), bukan lewat `_samQuiet` | 500 pesan progres di grup + race/leak `_samQuiet` ke download manual |
| 2 | `customTitle` dikirim **setiap episode**, bukan hanya episode 1 | episode 1 gagal → 499 episode ikut nama file, dan tidak masuk library |
| 3 | Simpan library **pindah ke `actionAnimeEpisode`** juga | batch `vyt` (target paling sering dipakai) tetap tidak mengisi `media`/`media_parts` → `!dell` tidak jalan, picker tidak pernah hijau |
| 4 | `_samQuiet` mematikan `leafAlert` → rekap akhir **wajib** menyertakan episode gagal | user tidak tahu episode mana yang gagal |

---

## 3. Scope

### Diubah

| File | Perubahan |
|------|-----------|
| `scraper/handlers/download.js` | `handleKamenimeUrl(..., opts = {})` + pakai `opts.silent` di baris 774 |
| `scraper/handlers/vidoy.js` | `actionAnimeEpisode` menyimpan library (`upsertMedia` + `savePartFileId`, gated `libsimpan`) |
| `scraper/bot.js` | `kam_all:` / `kam_allgo:` handler (baru), `kamBackBusy` lock, pace `SAM_BATCH_PACE_MS` |
| `scraper/tests/test-kamenime-batch.js` | BARU |

### Di luar scope — tidak disentuh

- `vidoy_uploads` (sudah benar mencatat link + `tg_message_id`)
- parser / `sanitizeSlug`
- kontrak media §5 (caption 4 baris, `supports_streaming: true`, topic Anime)
- **`test-vidoy-uploader.js`** — ringkasan sudah pindah ke akhir file (`a98db63`),
  bukan lagi masalah
- Data lama (record `Shippuuden`/`Shippuden`) — pembersihan data = keputusan
  user, terpisah

---

## 4. Item

### 4.1 `silent` per-panggilan (koreksi #1)

```js
// download.js:739
async function handleKamenimeUrl(chatId, url, customTitle = null, expectedEp = null, opts = {}) {
  ...
  // baris 774
  rp = (opts.silent || _samQuiet)
    ? noopRp()
    : await new _ctx.RichProgress(chatId, cap, [{ ep: capWithEp }]).start();
```

**Wajib**: periksa **semua** pemanggil `handleKamenimeUrl` — parameter ke-5 baru
dengan default `{}` jadi tidak mengubah perilaku lama, tapi agent WAJIB
memverifikasi tiap call-site.

### 4.2 `customTitle` di setiap episode (koreksi #2)

Bot sudah tahu judulnya dari `listKamenimeEpisodes()` → `animeTitle`. Kirim
`animeTitle` sebagai `customTitle` **untuk setiap episode**. Urutan resolusi di
`handleKamenimeUrl` sudah benar: library dulu, `customTitle` cuma fallback. Satu
panggilan `findMediaByPattern` yang **sudah ada** di sana — biaya nol.

### 4.3 Simpan library di `actionAnimeEpisode` (koreksi #3)

> **KEPUTUSAN: opsi (a) — HANYA kamenime.** `actionAnimeEpisode` itu **shared**,
> dipakai 5 pemanggil, dan hanya satu yang kamenime:
>
> | Baris | Jalur | `sameInfo` |
> |-------|-------|------------|
> | 3808 | Samehadaku batch | `parseSamehadakuEpisode` → `provider: 'samehadaku'` |
> | 4009 | Samehadaku single | `sameInfoG` → `provider: 'samehadaku'` |
> | 4134 | Kuronime single (`kur_go:`) | `kurInfoG` → `provider: 'kuronime'` |
> | 4314 | Kuronime batch | `kurInfo` → `provider: 'kuronime'` |
> | 4522 | `dl_go:` generik | **`{ provider: 'hokireceh' }`** ← kamini |
>
> Tanpa syarat provider, blok ini akan membuat **Samehadaku dan Kuronime ikut
> mulai mengisi `media`/`media_parts`** — perubahan perilaku besar di 4 jalur
> yang tidak pernah terjadi dan **tidak** termasuk scope proposal ini.
>
> Syarat yang dipakai: `sameInfo?.provider === 'hokireceh'`. Nilai itu sudah ada
> di `bot.js:4521`, jadi tidak perlu parser baru. Opsi (b) — semua provider —
> harus jadi item tersendiri dengan test sendiri.

Pindahkan logika `download.js:817-824` ke `actionAnimeEpisode`, **hanya** untuk
`provider === 'hokireceh'`, agar jalur `vyt`/`vv` kamenime juga mengisi
`media`/`media_parts`:

```js
if (sameInfo?.provider === 'hokireceh' && title && sent?.video?.file_id
    && (await getSetting('libsimpan')) === 'on') {
  const slug = `anime:${sanitizeSlug(title)}`;
  if (!await getPartFileId(slug, partN)) {
    await upsertMedia(slug, title, 0, episodeUrl, patFile);
    await savePartFileId(slug, partN, sent.video.file_id, bytes, fileName);
  }
}
```

**Harus cari `patFile` dari `episodeUrl`**, bukan dari nama file — agar
`source_pattern` konsisten dengan `findMediaByPattern` (koreksi #2, soal ejaan).

**Tidak boleh** Pathway `tg` jadi dobel-tulis: `handleKamenimeUrl` sudah
menyimpan. Jadi `actionAnimeEpisode` baru menulis kalau `target !== 'tg'`, atau
`savePartFileId` di-check duplikat (memakai `getPartFileId` yang sudah ada).

### 4.4 Rekap wajib menyertakan episode gagal (koreksi #4)

`silent` mematikan `leafAlert`, jadi pesan per-episode tidak muncul. Rekap akhir
**wajib** memuat daftar episode gagal, bukan cuma jumlahnya — meniru `sam_all:`
(3837-3842).

### 4.5 Dua jalur target

```
target = tg   → handleKamenimeUrl(chatId, ep.url, animeTitle, ep.ep, { silent: true })
target = vyt  → actionAnimeEpisode(chatId, { target, title, ep, episodeUrl,
target = vv      directUrl, silent: true, resolveFreshDirectUrl })
```

### 4.6 Tidak ada pre-scan server

`scanSupportedServers`/`viableFromScanned` khusus Samehadaku (harus memilih host
antar file). Kamenime URL langsung → tidak perlu.

### 4.7 Backpressure

`await sleep(_downloadHandlers.SAM_BATCH_PACE_MS || 1000)` per episode, persis
`bot.js:3834`. `SAM_BATCH_PACE_MS` default 1000 ms (`download.js:1268`), bisa
di-set lewat env. Tidak perlu tabel konkurensi baru.

---

## 5. Test wajib

`scraper/tests/test-kamenime-batch.js`

1. `kam_all:` menampilkan pilihan target (tg/vyt/vv) + "⟳ Lengkapi"
2. `kam_allgo:` memakai `animeDoneMap` — episode yang `link && hasTg` **dilewati**
3. `handleKamenimeUrl` menerima `opts.silent` dan **tidak** membuat `RichProgress`
4. **Semua call-site** `handleKamenimeUrl` yang ada tetap kompatibel (5 param,
   default `{}`)
5. `actionAnimeEpisode` memanggil `upsertMedia` + `savePartFileId` **dan** gated
   `getSetting('libsimpan')`
6. `actionAnimeEpisode` **tidak** dobel-tulis kalau `getPartFileId` sudah ada
7. `actionAnimeEpisode` menulis `source_pattern` dari `episodeUrl` (bukan nama file)
8. `customTitle` dikirim di **setiap** episode, bukan hanya episode 1
9. Loop memberi pace (`SAM_BATCH_PACE_MS`) dan `try/finally` melepas `samAllBusy`
10. Rekap akhir memuat daftar episode gagal

### Mutasi wajib

| # | Mutasi | Test harus gagal |
|---|--------|------------------|
| M1 | Hapus `opts.silent` di baris 774 | (3) |
| M2 | Hapus blok `upsertMedia` dari `actionAnimeEpisode` | (5) |
| M3 | Ubah `customTitle` jadi hanya episode pertama | (8) |
| M4 | Hapus `patFile` dari `upsertMedia` (pakai `sanitizeSlug(kmName)`) | (7) |
| M5 | Hapus `sleep` pace di loop | (9) |

### Regresi

```
test-kamenime-provider    26
test-picker-prefix        12
test-media-contract       10
test-preview-judul-resolusi 11
test-dell-vdell-logging   11
test-vidoy-uploader      157
```

---

## 6. Catatan tag

Fitur baru dengan alur baru (`kam_all:`), kontrak yang ada **tidak** berubah
(format callback sudah ada dari `buildPicker`) → **minor** → `v3.3.0`.

Koreksi #3 (library di `actionAnimeEpisode`, **hanya** kamenime) memperbaiki
`!dell` dan status picker untuk episode `vyt` yang selama ini kosong — itu
perbaikan bug, bukan kontrak baru, jadi tetap minor bukan major.

**Disadari**: sejak `v3.2.0` sudah ada banyak commit tanpa tag (termasuk 3 fix
`ReferenceError`/import dan fitur logger). `v3.3.0` akan membungkus semuanya.
Sesuai `AGENTS.md` ("34 commit tetap boleh jadi satu minor") itu tidak masalah.
