# `media_key` bocor: satu anime terpecah jadi 2 kunci karena beda ejaan

**Tanggal**: 2026-09-27
**Tag**: v3.3.2 (patch — dua fix bug, tidak ada kontrak yang berubah)
**Sebelumnya**: v3.3.1

## Gejala

Setelah batch Re:Zero selesai (25 episode, 23 sukses · 2 gagal) dan dua episode
yang gagal diisi manual lewat mode **single**, picker menampilkan:

```
📺 Re:Zero kara Hajimeru Isekai Seikatsu
🎞 25 episode · 📨 23 di Telegram · 🗄 2 perlu dikirim · ⬜ 0 belum ada
```

Menggunakan **mode yang sama** (Telegram + Vidoy) dan keduanya sukses, tapi hasil
tampilannya berbeda. Picker seolah tidak tahu bahwa 25 episode sudah lengkap.

## Akar masalah

Dua `media_key` berbeda untuk anime yang sama:

```
vidoy_uploads["Re:Zero kara Hajimeru Isekai Seikatsu"] → 23 part  (tg ada)
vidoy_uploads["Re-Zero kara Hajimeru Isekai Seikatsu"] →  2 part  (part 7, 16)
```

Selisihnya cuma **tanda baca**: titik dua vs hyphen. Sumbernya:

| Jalur | Sumber judul | Hasil |
|-------|--------------|-------|
| batch (`kam_allgo:`) | `listKamenimeEpisodes` → `<title>` situs | `Re:Zero ...` ✅ |
| single (`dl_go:`) | `kamenimeTitleFromFileName(fileName)` | `Re-Zero ...` ❌ |

Single **tidak pernah menanyakan** `<title>` situs — langsung jatuh ke nama file.
Keduanya tidak pernah dibandingkan, jadi tidak ada yang tahu itu anime yang sama.

Bukti di log (nama fileVidoy, apa adanya):

```
13:49-14:12  BATCH    Re:Zero kara Hajimeru Isekai Seikatsu — Ep 01..25.mp4
14:41, 14:44  SINGLE  Re-Zero kara Hajimeru Isekai Seikatsu — Ep 07/16.mp4
```

## Dua sisi bug

### Sisi 1: picker hanya menanyakan satu key

`episodeStatusMap(slug, vidoyTitle, extraVidoyKeys)` mencari:

- `media_parts` lewat `libKey` (slug)
- `vidoy_uploads` lewat **satu** `vidoyTitle` (+ kandidat dari `extraVidoyKeys`)

Jadi dua baris dengan key berbeda → yang tidak ditanyakan tidak terlihat.
Karena picker kamenime **tidak** mengirim `vidoyKeysFromEpisodes` (berbeda dari
samehadaku dan kuronime), tidak ada kandidat tambahan sama sekali.

### Sisi 2 (lebih parah): `media.nama` ikut tertimpa

`upsertMedia` memakai `ON CONFLICT (slug) DO UPDATE SET nama = $2` — **tanpa
syarat**. Setiap single episode menimpa judul yang sudah ada dengan judul dari
nama file. Terbukti di DB:

```
slug            : anime:re-zero-kara-hajimeru-isekai-seikatsu
nama (sekarang) : "Re-Zero kara Hajimeru Isekai Seikatsu"   ← HYPHEN
source_pattern  : "rezero-kara-hajimeru-isekai-seikatsu"    ← stabil, dari URL
```

Dan `media.nama` itu adalah `vidoyTitle` yang dikirim picker. Jadi setiap kali
user download single, picker berikutnya akan mencari key yang **tidak ada** —
dan itu akan berulang selamanya, bukan cuma untuk Re:Zero.

## Perbaikan

### 1. `upsertMedia` tidak lagi menimpa `nama` tanpa syarat

```sql
nama = CASE
  WHEN media.nama IS NULL OR btrim(media.nama) = '' THEN EXCLUDED.nama
  WHEN EXCLUDED.nama IS NULL OR btrim(EXCLUDED.nama) = '' THEN media.nama
  WHEN length(EXCLUDED.nama) > length(media.nama) THEN EXCLUDED.nama
  ELSE media.nama
END,
```

Judul yang lebih lengkap (mis. baru dapat suffix season) tetap boleh menulis;
judul yang lebih pendek atau beda ejaan tidak. Kolom lain tetap `COALESCE`/
`GREATEST` seperti sebelumnya.

### 2. Picker kamenime mencari library lewat `source_pattern`

Slug library dulu diturunkan dari judul (`sanitizeSlug(title)`), jadi ikut
berganti saat ejaan judul berubah. Sekarang:

```js
const libSlug = await resolveLibrarySlugByPattern(animeUrl, `anime:${sanitizeSlug(title)}`);
statusMap = await episodeStatusMap(
  libSlug, title, vidoyKeysFromEpisodes(eps, parseKamenimeEpisode));
for (const [ep, st] of statusMap) if (st.tg) done.add(ep);
```

Tiga bagian sekaligus (sama seperti samehadaku `bot.js:2037` dan kuronime
`bot.js:2097`):

- `source_pattern` untuk cari baris `media` — stabil, tidak terpengaruh ejaan
- `vidoyKeysFromEpisodes` untuk kandidat `media_key` dari URL episode
- `done` diisi dari `st.tg` — tanpa ini tombol tidak pernah hijau

Helper baru di `lib/episode-status.js`:

- `resolveLibrarySlugByPattern(animeUrl, fallback)` — `findMediaByPattern` dulu,
  baru fallback ke slug tebakan. Picker tetap tampil kalau DB tidak punya polanya.
- `parseKamenimeEpisode(episodeUrl)` — parser berbentuk sama dengan
  `parseSamehadakuEpisode` supaya bisa dipakai `vidoyKeysFromEpisodes`;
  `provider: 'hokireceh'`.

## Backfill data

2 baris yang sudah terlanjur bocor digabung (izin user diberikan eksplisit):

```
part 7  https://vski.cc/e/fzozha3ajt7j  tg=7468   → "Re:Zero ..."
part 16 https://vski.cc/e/ypx33125p9xs  tg=7488   → "Re:Zero ..."

SESUDAH: "Re:Zero kara Hajimeru Isekai Seikatsu" → 25 part (1-25)
         Sisa di key bocor: 0
```

Hanya `media_key` yang berubah; `link` / `part` / `tg_chat_id` / `tg_message_id`
tidak disentuh, jadi tidak ada file yang berubah (§6: satu episode satu file).
`media_parts` sudah 25/25 sejak awal — tidak perlu apa-apa.

Script: `.hermes/cache/scratch/backfill_rezero.js` (idempoten, dry-run default,
backup JSON per-baris sebelum menulis).

## Verifikasi

`test-media-key-konsisten.js` **15 pass / 0 fail** (baru), termasuk:
- `upsertMedia` tidak lagi memakai `nama = $2` telanjang; `CASE` melindungi nama
  yang sudah ada; kolom lain tetap `COALESCE`/`GREATEST`
- picker kamenime tidak lagi menebak slug dari judul
- `resolveLibrarySlugByPattern` **selalu** mengembalikan fallback di akhir fungsi
  (kalau tidak, DB error → picker kehilangan kunci)
- `parseKamenimeEpisode` menghasilkan `provider: 'hokireceh'`
- **ketiga picker seragam**: punya `vidoyKeysFromEpisodes` + mengisi `done`
- anti-regresi: `prefix: 'kam'` masih ada, `kamenimeSourcePattern(url)` masih
  dipakai **duluan** di `handleKamenimeUrl` (nama file hanya fallback)

### Mutasi wajib (7, semua tertangkap)

| # | Mutasi | Hasil |
|---|--------|-------|
| M1 | `upsertMedia` balik ke `nama = $2` | 11 pass / 2 fail |
| M2 | picker kamenime balik ke slug tebakan langsung | 10 pass / 5 fail |
| M3 | hapus `vidoyKeysFromEpisodes` dari picker kamenime | 11 pass / 2 fail |
| M4 | hapus loop `done` dari `st.tg` | 11 pass / 2 fail |
| M5 | fallback helper dihapus (`return null`) | 13 pass / 2 fail |
| M6 | `parseKamenimeEpisode` provider salah | 12 pass / 1 fail |
| M7 | `CASE` ditulis terbalik (nama baru selalu menimpa) | 12 pass / 1 fail |
| — | dipulihkan | 15 pass / 0 fail |

⚠️ **M2 dan M5 awalnya LOLOS** karena test tidak cukup spesifik, dan mutasi M2
tidak cocok dengan indentasi sebenarnya (6 spasi vs 4) sehingga tidak pernah
terpakai. Test 2b/2d/2e ditulis ulang: 2b kini memeriksa bahwa fungsi
**berakhir** dengan `return fb;` setelah catch, 2d melarang `episodeStatusMap`
dipanggil dengan slug tebakan, 2e memverifikasi `findMediaByPattern` dipanggil
**sebelum** fallback dikembalikan. Setelah itu keduanya tertangkap.

### Regresi

```
test-media-key-konsisten   15 pass  0 fail   (BARU)
test-media-contract        10 pass  0 fail
test-kamenime-batch        11 pass  0 fail
test-kamenime-provider     26 pass  0 fail
test-picker-prefix         12 pass  0 fail
test-preview-judul-resolusi 11 pass  0 fail
test-dell-vdell-logging    11 pass  0 fail
test-vidoy-uploader       157 pass  0 fail
test-speed-floor-batas     15 pass  0 fail
test-downloadto-speed-floor 10 pass  0 fail
```

### Deploy

Restart dilakukan setelah `download progres` terakhir > 2 menit (15:09:35, cek
pada 15:11:41) — **memakai cara benar** yang tercatat di memori, bukan
`ps | grep aria2c` seperti kemarin yang tidak mungkin menangkap unduhan HTTP.
`Bot running 15:11:56`, PID 5988, restart count 1.

## Catatan proses

Tiga kesalahan nyata di sesi ini, semuanya dicatat:

1. Probe dengan kolom salah (`slug` vs `media_slug`) → report "1 baris" padahal 23.
2. Klaim "batch vyt tidak mengisi library" — **salah**; dia mengisi, tapi
   `media_key`-nya beda sehingga tidak terlihat di picker.
3. Usulan "tambah `vidoyKeysFromEpisodes` akan memperbaiki ini" — **tidak akan**;
   parser itu menghasilkan key yang sama, bukan key yang bocor. Baru sadar
   setelah baca `episodeStatusMap` baris per baris.
