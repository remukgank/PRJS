# Vidoy sebagai target upload + menu upload Drama & Anime

**Date**: 2026-09-25
**Author**: opencode
**Versi**: `v3.0.0` (major — provider upload baru, 2 menu, tabel DB, alur anime)
**Proposal**: `docs/proposals/2026-09-25-vidoy-upload-menu.md` (disetujui: "kamu atur saja asal profesional")
**Sumber kebenaran**: Bot API resmi **10.3** (24 Agu 2026, via r.jina.ai)

## 1. Kebutuhan

Drama ke depan pakai **gabung 10** (bukan per episode); perlu target upload
**Vidoy** selain Vidara & Telegram. Anime per-episode dengan 4 target
(Telegram / Vidara+TG / **Vidoy+TG** / **Vidara+Vidoy**).

## 2. Bukti live (akun Vidoy user, 25 Sep 2026)

| Uji | Hasil |
|---|---|
| Login session | ✅ HTTP 200 |
| Upload 2-step (CDN → `/manual/upload`) | ✅ `id=xrp5jzq6ten0` |
| Public link | ✅ `https://vski.cc/e/{id}` HTTP 200 tanpa auth |
| Struktur 3 level `VVIP AKSES/DATABASE/ANIME|DRAMA/...` | ✅ create-di-root + `move` |
| Panjang nama | ✅ s.d 160 karakter |
| `:` `?` `*` `"` `|` `\` `&` `+`, CJK | ✅ utuh |
| `<` `>` | ❌ gagal dibuat — **`add-folder` tetap balas 303 (silent fail)** |
| Emoji | ⚠️ tersimpan `???????` |
| `/folders` tanpa session | **302** (bukan 401/403) |

Konsekuensi desain (wajib): verifikasi create lewat **re-list**; sanitasi buang
`<`/`>`/emoji; session handling mencakup 302.

## 3. Scope Perubahan

| File | Perubahan |
|---|---|
| `scraper/vidoy-uploader.js` (baru) | Port teruji: logger **pino**, session 302/301/303/401/403, dead code `pairs` dibuang, quote-path `-F "files[]=@path"`, plus `sanitizeFolderName` (buang `<>`/emoji/kontrol, cap 120 + hash), `segmentsToPath` (terima string/array), `getOrCreateFolderPath` (multi-level, **verifikasi re-list**), `dramaFolderPath`/`animeFolderPath`, util URL galeri, `isConfigured` |
| `scraper/services/vidoyService.js` (baru) | `uploadBatches` (merge-10) & `uploadSingle` (per-ep), reuse `downloadChunk`/`ffmpegConcat`/`ensureMp4` dari `vidaraService`, simpan ke DB per batch/episode |
| `scraper/db.js` | Tabel `vidoy_uploads` (PK `media_key, kind, part`) + `saveVidoyUpload`, `listVidoyUploads` |
| `scraper/handlers/download.js` | Helper `resolveDirectUrl` (gofile direct/folder, pixeldrain, filedon, gdriveplayer, gdrive, mega → link file langsung) untuk alur upload anime; diekspor |
| `scraper/handlers/vidoy.js` (baru) | `actionVidoyMerge10`, `actionVidoyAndTelegramMerge10` (drama, RichProgress per batch, laporan link, cleanup), `actionAnimeEpisode` (4 target anime; Vidara via `vidara-uploader`, Vidoy via service, Telegram via `sendVideo`; busy-guard; caption escaped) |
| `scraper/bot.js` | Wiring `initVidoy`; `mainActionKeyboard('drama'\|'anime')` (drama 9 baris: 5 gabung-10 + sub-menu per-episode; anime 7 baris: 4 target) + `dramaLegacyKeyboard`; tombol **aktif pakai `style`** & **mati pakai `disabled: {}`** sesuai kredensial (Bot API 10.3); dispatch `vy_merge10`/`vyt_merge10`/`drama_legacy`/`back_menu`/`a_*`; preview `sam_dl` & `kur_dl` ganti tombol "✅ Ya, Download" → **4 target anime**; parser `sam_go:`/`kur_go:` recognising `tg|vt|vyt|vv` |
| `scraper/tests/test-vidoy-uploader.js` (baru) | 22 test: sanitasi (semua rules live), path 4 level, util URL, **anti-drift** (verifikasi re-list, 302 handling, tanpa `pairs`, logger pino), bentuk & validitas 2 menu, `disabled: {}`, `callback_data` ≤ 64 **byte**, `style` valid |

Tidak diubah: `gofile-worker.js`, `handlers/vidara.js`, alur samehadaku/kuronime
selain preview & routing target anime.

## 4. Keputusan (standar profesional)

- **D1** Target anime dipilih **di preview** (sebelum download), bukan setelahnya.
- **D2** Opsi per-episode drama dipindah ke sub-menu `⚙️ Opsi per episode` (fitur tak hilang, menu utama rapi).
- **D3** Nama file di folder: `<Judul> — Ep X-Y` (drama) / `<Judul> — Ep NN` (anime).
- **D4** Batas ukuran Vidoy belum diketahui → upload streaming `curl` (600 dtk) + deteksi penolakan eksplisit + error jujur bila ditolak.
- **D5** Kredensial absen → tombol **abu-abu** (`disabled: {}`), bukan error saat ditekan; tombol aktif diberi `style` (10.3).
- **D6** Versi **major `v3.0.0`**.

## 5. Verification

- `node --check` **CLEAN**: `vidoy-uploader.js`, `services/vidoyService.js`, `handlers/vidoy.js`, `handlers/download.js`, `bot.js`, `db.js`, test.
- Load test: ketiga modul Vidoy ter-require tanpa error.
- `test-vidoy-uploader.js`: **22 pass, 0 fail** — termasuk penangkapan **2 bug nyata saat implementasi**:
  1. `segmentsToPath` crash bila diberi string (`.map` bukan fungsi) — diperbaiki (terima string/array).
  2. Asersi test sendiri salah (bukan bug produksi) — diperbaiki.
- Regresi **17 suite hijau** (vidoy 22, html-safety 22, caption-escape 6, movie 15, parse-ep1 14, ep1-slug 22, slugtail 28, picker 7, libmenu 14, livechat 4, filename 9, anime-router 18, gdriveplayer 3, prescan, batch, kuronime, extract-provider).

## 6. Deploy

`bot.js`/`db.js`/modul baru berubah → **restart bot**. Skenario tes: menu drama
menampilkan 5 opsi gabung-10 (Vidoy aktif bila kredensial ada), `⚙️ Opsi per
episode` membuka sub-menu, preview anime (samehadaku & kuronime) menampilkan 4
target dengan tombol mati sesuai kredensial, `Vidoy — gabung 10` mengunggah ke
`VVIP AKSES/DATABASE/DRAMA/<judul>/` dan melaporkan link. Setelah verifikasi →
commit + push + tag `v3.0.0`.

## 7. Catatan

- Batas ukuran file Vidoy belum terukur (50 KB teruji). Bila file besar ditolak,
  pesan galatgabe dijawab eksplisit (D4) — pengukuran batas jadi follow-up.
- Artefak uji live untuk dihapus user: video `xrp5jzq6ten0`; folder uji
  `ZZ-TEST-VIDOY` + 15 folder `ZZT …`. Folder `VVIP AKSES/DATABASE/ANIME|DRAMA` **dipertahankan**.

## 8. Perbaikan caption & link (audit 25 Sep 2026, sesi kedua)

Laporan user: caption hasil refresh `Provider :- undefined`, link tertukar antar
record, dan video tidak stream di Telegram. Approved scope: trace menyeluruh.

### Akar masalah (hasil trace)
1. **`Provider :- undefined`** — jalur kirim Drama memakai shorthand objek yang
   salah: `buildCaption({ title, providerLabel, ... })` tanpa key `provider:`.
   `safeHtml(undefined)` → teks literal `undefined`. BUKAN masalah di panel.
2. **Video tidak stream** — `sendVideo` dipanggil tanpa `supports_streaming`
   (pola Vidara yang benar memakainya, `handlers/vidara.js`).
3. **Link tertukar** — tombol panel memakai indeks (`ORDER BY uploaded_at DESC`),
   sehingga indeks bergeser bila ada upload baru antara render dan klik.
4. **`vinfo` tidak terdefinisi** (baru ketahuan saat trace) — `mediaOpts` memakai
   `vinfo` yang tak pernah dideklarasikan di jalur Drama → `ReferenceError` saat
   kirim Telegram.
5. **`updateVidoyLink` `RETURNING id`** — tabel tidak punya kolom `id`.
6. **Panel `_ctx.isAdmin` undefined** — `initAdmin` tidak menerima `isAdmin`,
   sehingga guard `handleVidoyLinks` selalu menolak.

### Perubahan
- Caption unified (spesik user): `Judul` / `Part:Episode` / `Provider` / `Link`
  — tanpa baris `Server` dan `Tipe`. Format part: `1 (Ep 1–10)`, episode tunggal
  `Ep 8`. `buildCaption` kini menerima `part`.
- Penyebab `undefined` dipatok: setiap call site wajib punya `provider:` (tes).
- `supports_streaming: true` + `duration/width/height` di kedua jalur kirim
  (drama via `mediaOpts`, anime inline), mengikuti pola Vidara.
- `vinfo` dideklarasikan sebelum dipakai (tes regresi).
- DB: kolom baru `provider` + `caption` pada `vidoy_uploads` (dengan migrasi
  `ADD COLUMN IF NOT EXISTS`); caption asli disimpan saat upload.
- Refresh link memakai **caption tersimpan** dan hanya mengganti baris `➧ Link :-`
  (`replaceLinkLine`); record lama tanpa caption memakai `buildFallbackCaption`
  yang menurunkan provider dari `media_key` dan tidak pernah menghasilkan
  `undefined`. Refresh mengedit caption tanpa syarat link berubah.
- Panel memakai token identitas record `sha1(media_key|kind|part)[0..8]`
  (`recordToken`/`findRowByToken`) — 27 byte, aman < 64; tidak lagi susceptible
  pergeseran indeks.
- `updateVidoyLink` mengembalikan kolom yang benar; `initAdmin` menerima `isAdmin`.

### Koreksi diri
Dulu dilaporkan `safeHtml` gagal escape `<`/`>` sebagai bug keamanan. **Salah**:
`safeHtml` adalah sanitizer allow-list yang disengaja (tag Telegram yang diizinkan
dipertahankan, `<script>` dan tag asing dinetralkan) dan sudah punya 22 tes. Yang
salah adalah test baru saya yang menyalahi kontraknya; test diperbaiki, bukan
helper. Tidak ada perubahan pada `lib/html.js`.

### Verifikasi
- `node --check`: bot, db, handlers/admin, handlers/vidoy, tests — CLEAN.
- `scraper/tests/test-vidoy-uploader.js`: **62 pass, 0 fail** (dari 44; +18 tes
  regresi caption/refresh/token/streaming/provider).
- Regresi seluruh suite: 0 fail. Tidak terkait kode: `test-all-subdomains`
  (butuh jaringan, timeout), `test-rich` (butuh FlareSolverr), `test-rich-direct`
  (skrip manual butuh env).
- Simulasi terhadap 7 record DB: caption hasil perbaikan = `1 (Ep 1–10)` s/d
  `7 (Ep 61–68)`, provider `dramawave`, tiap part ke link yang cocok.
- PM2 `prjs-bot` restart → pid 14758, `Bot running`.
- Live run 22:03–22:32: 7/7 batch terkirim Telegram, 0 gagal (termasuk pemulihan
  Part 1 yang sebelumnya bolong).

### Masih perlu user
- Tekan `🛠 Admin Panel` → `🗂 Vidoy Links` → `🔄 Perbarui Semua` untuk menulis
  ulang caption 7 pesan lama (link tidak berubah, hanya caption).
- Video yang 7 pesan lama dikirim tanpa `supports_streaming`; streaming baru
  berlaku untuk pengiriman berikutnya.
- Commit/push/tag `v3.0.0` — **belum dilakukan**, menunggu persetujuan.

## 9. Sesi 25 Sep 2026 (lanjutan) — target batch, menu, season anime

### Temuan & perbaikan
1. **`Provider :- undefined`** — shorthand salah di jalur kirim Drama
   (`buildCaption({ title, providerLabel, … })` tanpa key `provider:`). Bukan
   masalah panel. Diperbaiki + tes pengunci.
2. **Video tidak stream** — `sendVideo` tanpa `supports_streaming`. Ditambahkan
   `supports_streaming: true` + `duration/width/height` di kedua jalur kirim
   (drama & anime), mengikuti pola `handlers/vidara.js`.
3. **`vinfo` tak terdefinisi** di jalur Drama → `ReferenceError` saat kirim
   Telegram. Diperbaiki + tes regresi.
4. **Link tertukar antar part** — tombol panel memakai indeks list
   (`ORDER BY uploaded_at DESC`) yang bergeser. Diganti token identitas
   `sha1(media_key|kind|part)[0..8]` (27 byte).
5. **Refresh caption video gagal** — `refreshVidoyLink` memakai `editMessageText`
   → 400 "there is no text in the message to edit". Diganti `editMessageCaption`
   dengan fallback `editMessageText`. (Tombol `🔄 Perbarui` sebelumnya pasti gagal
   untuk semua pesan video; belum pernah diuji live.)
6. **`updateVidoyLink` `RETURNING id`** — kolom `id` tidak ada. Diganti kolom nyata.
7. **Panel `_ctx.isAdmin` undefined** — `initAdmin` tidak menerima `isAdmin`, guard
   selalu menolak. Diperbaiki.
8. **Label link tidak sama dengan URL** — `shortLinkLabel` mempatok `vidoy.asia`
   sementara host asli `vski.cc`. Sekarang label memakai domain asli dari URL.
9. **Kirim ulang yang sudah terkirim** — `normalizeTrackEntry` membaca `tgSent`
   yang tidak ada di DB (yang ada `tg_chat_id`/`tg_message_id`), dan `track.json`
   terhapus setelah run sukses → 7 part akan diunduh & dikirim ulang. Diperbaiki:
   `tgSent` dihitung dari track **atau** pointer Telegram. Dibuat 5 tes KRITIS.
10. **Tombol `🗂 Vidoy Links` tidak pernah tampil** — ada dua definisi
    `adminPanelKeyboard` (bot.js & handlers/admin.js) yang berbeda isi; yang
    dipakai `handleAdminPanel` tidak punya tombol tersebut. Log: `act:vidoy_links`
    0 kali masuk. Baris ditambahkan di keyboard yang benar.
11. **`⬇️ Download Semua` (batch anime) tanpa pilihan target** — langsung unduh ke
    Telegram. Kini `sam_all` **dan** `kur_all` menanyakan target dulu
    (Telegram / Vidara+TG / Vidoy+TG / Vidara+Vidoy); target non-TG memakai
    `actionAnimeEpisode` (dengan fallback antar server) + link per-episode
    dilaporkan di akhir. Mode `silent` ditambahkan agar tidak spam per-episode.
12. **Season anime** — parser membuang `-season-N` dari judul sehingga潜在 tabrakan
    Judul/folder/file/`mediaKey`. Sekarang ditulis bentuk pendek `S4`/`P2`,
    konsisten dengan gaya slug situs (`-s3`, `-s2-p2`). Anime tanpa season tidak
    berubah.
13. **Format label** — episode tunggal → `Episode :- N`; batch drama tetap
    `Part/Episode :- 1 (Ep 1–10)`.

### Koreksi diri
- Dulu dilaporkan `safeHtml` gagal escape `<`/`>` sebagai bug keamanan. **Salah**:
  `safeHtml` adalah sanitizer allow-list yang disengaja dan sudah 22 tes.
- Dulu dilaporkan tabrakan season sebagai bug produksi. **Salah untuk data
  produksi**: situs memakai `-s3` yang sudah aman; yang bermasalah hanya gaya
  `-season-N` di fixture test. Lesson: verifikasi ke data sumber (DB/situs)
  sebelum menyimpulkan.

### Data
- 4 baris `media_parts` slug `anime:naruto-kecil` dihapus (state "sudah save")
  agar `Download Semua` menghitung semua episode. Slug lain tidak disentuh.
- 7 pesan video lama drama dihapus (#5601–#5607) setelah 7 video terkirim ulang
  dengan streaming (#5615–#5621).
- Folder uji & artefak tes dibersihkan; `downloads/` kembali 0.

### Verifikasi
- `node --check`: bot, db, handlers/admin, handlers/vidoy, services/vidoyService,
  providers/samehadaku, tests — CLEAN.
- `scraper/tests/test-vidoy-uploader.js`: **79 pass, 0 fail**.
- Regresi: `test-samehadaku-parse-ep1` 14, `test-samehadaku-slugtail-fallbacks` 28,
  `test-samehadaku-ep1-slug` 22, `test-samehadaku-movie-link` 15,
  `test-html-safety` 22, `test-caption-html-escape` 6, `test-anime-topic-router` 18,
  `test-sam-prescan` & `test-sam-picker-pagination` exit 0 — 0 fail.
- PM2 `prjs-bot` online (pid 24358), 0 error sejak restart.
- Belum ada tes live untuk target Vidoy di batch anime (menunggu user).
