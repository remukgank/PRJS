# `kam_all:` Download Semua untuk Kamenime

**Tanggal**: 2026-09-27
**Tag**: v3.3.0 (minor — fitur baru, kontrak yang ada tidak berubah)
**Proposal**: `docs/proposals/2026-09-27-kamenime-download-semua.md`

## Latar

Tombol **"⬇️ Download Semua (500)"** di picker Kamenime adalah pajangan.
Riwayatnya dua tahap:

1. `v3.2.2` — prefix callback diperbaiki dari `sam` jadi `kam`, jadi tombolnya
   tidak lagi menjalankan parser Samehadaku.
2. `v3.2.3` — handler `kam_all:` ditolak dengan pesan "belum tersedia", karena
   feature-nya belum ada. Menolak dengan jujur memang lebih baik daripada diam,
   tapi tombolnya **tetap tidak berfungsi**.

## Empat koreksi dari review user

| # | Koreksi | Kalau diabaikan |
|---|---------|-----------------|
| 1 | `silent` jadi parameter **per-panggilan**, bukan lewat `_samQuiet` global | 500 pesan progres di grup + `_samQuiet` bocor ke download manual yang jalan bersamaan |
| 2 | `customTitle` dikirim di **setiap episode**, bukan hanya episode 1 | episode 1 gagal di `savePartFileId` → 499 episode ikut nama file + tidak masuk library |
| 3 | Simpan library di `actionAnimeEpisode`, **hanya** `provider === 'hokireceh'` | Samehadaku + Kuronime ikut mulai mengisi `media`/`media_parts` — perubahan perilaku di 4 jalur, di luar scope |
| 4 | Rekap akhir **wajib** mencantumkan nomor episode gagal | `silent` mematikan `leafAlert`, jadi user tidak tahu episode mana gagal |

### Koreksi #1: `try/finally` tidak menutup interleaving

Klaim awal saya ("harus pakai `try/finally`") **salah** — `try/finally` sudah ada
di `download.js:1069-1157` dan `1176-1188`. Risiko sebenarnya: batch A menyetel
`_samQuiet = true`, lalu **selama `await` milik A** download manual B berjalan →
B ikut senyap. `try/finally` hanya mengembalikan nilai saat A selesai, tidak
mencegah B melihat `true` di tengah jalan.

Solusi: `opts.silent` per-panggilan. `_samQuiet` global **tidak dipakai** untuk
jalur kamenime sama sekali — `opts.silent || _samQuiet` hanya menjaga
backward-compatibility untuk pemanggil lama.

### Koreksi #3: `actionAnimeEpisode` itu shared

Dipakai 5 pemanggil, hanya satu yang kamenime:

| Baris | Jalur | `sameInfo` |
|-------|-------|------------|
| 3808 | Samehadaku batch | `provider: 'samehadaku'` |
| 4009 | Samehadaku single | `provider: 'samehadaku'` |
| 4134 | Kuronime single (`kur_go:`) | `provider: 'kuronime'` |
| 4314 | Kuronime batch | `provider: 'kuronime'` |
| 4522 | `dl_go:` generik | `{ provider: 'hokireceh' }` |

Opsi (b) — semua provider — ditolak untuk proposal ini: harus jadi item tersendiri
dengan test sendiri.

## Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/handlers/download.js` | `handleKamenimeUrl(..., opts = {})`; `rp = (opts.silent \|\| _samQuiet) ? noopRp() : ...` |
| `scraper/handlers/vidoy.js` | Simpan library gated `animeProvider === 'hokireceh'`; import `getSetting`/`getPartFileId`/`savePartFileId`/`upsertMedia`/`sanitizeSlug`/`kamenimeSourcePattern` |
| `scraper/bot.js` | Handler `kam_all:` / `kam_allgo:` / `kam_fix:` (menggantikan yang menolak) |
| `scraper/tests/test-kamenime-batch.js` | BARU — 11 test |
| `scraper/tests/test-picker-prefix.js` | Test 6c diupdate: dari "menolak" ke "merespons" |
| `scraper/tests/test-kamenime-provider.js` | Test (p) potong blok pada `kam_all:` (bukan `sam_ep:`) |

### Alur `kam_all:`

```
kam_all:<id>              → pilih target (tg / vyt / vv) + "⟳ Lengkapi"
kam_allgo:<target>:<id>   → samAllBusy lock → cache/listing episode
                          → filter "sudah lengkap" via animeDoneMap
                          → SATU RichProgress untuk semua episode
                          → loop: pace SAM_BATCH_PACE_MS (1000 ms)
                          → rekap: sukses / dilewati / GAGAL (nomor ep) / link Vidoy
kam_fix:<id>              → hanya yang link ada tapi Telegram-nya hilang
```

### Dua jalur target

```
tg   → handleKamenimeUrl(chatId, ep.url, kmTitle, ep.ep, { silent: true })
vyt  → actionAnimeEpisode({ target, title, ep, sameInfo: { provider: 'hokireceh' },
vv       directUrl, episodeUrl, silent: true })
```

### `source_pattern` dari URL, bukan nama file

```js
const libPat = kamenimeSourcePattern(episodeUrl) || sanitizeSlug(title) || 'kamenime';
```

Kalau dari nama file, tiap episode punya pola berbeda (`...-episode-1`,
`...-episode-2`) sehingga `findMediaByPattern` di episode berikutnya tidak
menemukan — judul tidak pernah connect. Dari URL (`/anime/<slug>`) polinya satu
untuk semua episode, dan **tidak dipengaruhi ejaan** (relevan untuk
`Shippuden` vs `Shippuuden`).

## Dampak ke masalah lama

Ini menutup akar masalah `!dell Naruto Shippuden tidak ditemukan`: episode yang
hanya dikirim via `vyt`/`vv` sekarang **juga** mengisi `media`/`media_parts`,
karena sebelumnya `actionAnimeEpisode` nol menyentuh library.

## Verifikasi

`test-kamenime-batch.js` **11 pass / 0 fail**, mencakup:
- `animeDoneMap` + guard `st.link && st.hasTg` → episode lengkap dilewati (§6)
- `opts.silent` dipakai, dan `_samQuiet` **tidak** lagi jadi satu-satunya
- `getPartFileId` dipanggil **sebelum** `upsertMedia` (cegah dobel-tulis)
- `customTitle` **tidak** bersyarat pada nomor episode
- `try { … } finally { samAllBusy.delete() }` + tolak kalau sedang jalan
- rekap menyatukan nomor episode gagal
- syarat `animeProvider === 'hokireceh'` ada **sebelum** `upsertMedia`

### Mutasi wajib

| # | Mutasi | Hasil |
|---|--------|-------|
| M1 | hapus `opts.silent` (kembali `_samQuiet` global) | 10 pass / 1 fail |
| M2 | hapus blok `upsertMedia` dari `actionAnimeEpisode` | 7 pass / 4 fail |
| M3 | `customTitle` hanya episode 1 | 10 pass / 1 fail ⚠️ |
| M4 | `source_pattern` dari nama file | 10 pass / 1 fail |
| M5 | hapus pace `sleep` | 10 pass / 1 fail |
| M6 | hapus syarat `provider === 'hokireceh'` | 10 pass / 1 fail |
| — | dipulihkan | 11 pass / 0 fail |

⚠️ **M3 awalnya tidak tertangkap.** Test 8 hanya mengecek kata `kmTitle` ada di
baris panggilan — dan `Number(e.ep) === 1 ? kmTitle : null` juga memuatnya. Test
diperketat: sekarang ia mengambil **argumen `customTitle` dari call-site** dan
menolak yang bersyarat (`?`, `===`) atau bukan `kmTitle` apa adanya. Setelah
diperketat, M3 tertangkap (1 test gagal).

### Regresi

```
test-kamenime-batch             11 pass  0 fail
test-picker-prefix              12 pass  0 fail
test-kamenime-provider          26 pass  0 fail
test-media-contract             10 pass  0 fail
test-preview-judul-resolusi     11 pass  0 fail
test-dell-vdell-logging         11 pass  0 fail
test-vidoy-uploader            157 pass  0 fail
```

Dua test lama sempat gagal karena mengunci batas blok pada `sam_ep:` — handler
`kam_all:` kini ada di antara `kam_ep:` dan `sam_ep:`. **Perilaku yang diuji tidak
berubah**; hanya cara memotong blok. `test-picker-prefix` 6c diupdate karena
ekspektasinya berubah memang: dari "menolak dengan popup" ke "merespons".

### Deploy

`pm2 restart prjs-bot` → `Bot running` 13:45:52, nol error.

## Yang belum diuji

Belum ada E2E — batch 500 episode adalah operasi besar yang tidak dijalankan
otomatis. Yang terverifikasi: handler terpanggil, tidak `Unhandled error`, filter
& pace ada. Perilaku nyata (upload sungguhan ke Vidoy/Telegram) **perlu diuji
manuais** dengan anime kecil lebih dulu.
