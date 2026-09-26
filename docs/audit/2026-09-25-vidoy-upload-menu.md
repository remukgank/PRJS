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

## 10. Fix keyboard target anime (26 Sep 2026, 00:03)

### Gejala
User menekan `⬇️ Download Semua` → tidak ada tombol muncul, tanpa pesan apa pun.
Log: `ETELEGRAM: 400 Bad Request: can't parse InlineKeyboardButton: InlineKeyboardButton
must be an Object` (method `editMessageText`).

### Akar masalah
`animeTargetKeyboard()` **sudah mengembalikan array of rows**, tapi pemanggil
membungkusnya sekali lagi dengan `[...]`:

```js
inline_keyboard: [
  animeTargetKeyboard(...),   // ❌ → [[ [btn,btn], [btn,bn] ], …]  (row berisi array)
  [{ text: '⬅️ Kembali', … }],
]
```

Akibatnya `inline_keyboard` berisi array di dalam row, bukan objek tombol →
ditolak Telegram. Perbaikan: spread (`...animeTargetKeyboard(...)`).

**Tiga pemanggil lama ikut salah** (bukan hanya kode baru): preview per-episode
samehadaku (`sam_go`), kuronime (`kur_go`), dan dua menu target batch. Inilah
sebabnya jalur Vidoy anime per-episode tidak pernah bisa dipakai sejak awal —
baru ketahuan karena user memakai `Download Semua`.

### Ditambahkan
- Kegagalan menampilkan menu target tidak lagi ditelan `.catch(() => {})`:
  di-log (`sam_all`/`kur_all: gagal tampilkan pilihan target`) + pesan error
  ke user agar tidak diam-diam.
- Tes: semua 4 pemakaian harus spread; validitas struktur row (array of Object),
  `text` non-kosong, `callback_data` string 1–64 byte; dan tidak boleh ada
  `.catch(() => {})` pada jalur menu target batch.

### Verifikasi
- Uji nyata ke API Telegram dengan keyboard hasil perbaikan → **OK** (pesan uji
  dihapus).
- `test-vidoy-uploader.js`: **82 pass, 0 fail**.
- `test-html-safety` 22, `test-caption-html-escape` 6, `test-anime-topic-router` 18
  — 0 fail.
- PM2 restart (pid 25216), `Bot running`, 0 error baru.

### Belum diuji live
- Target `📥 Vidoy + TG` pada batch anime (`sam_allgo` / `kur_allgo`) — belum
  pernah dijalankan sungguhan; menunggu user. Saran: mulai dari anime pendek.

## 11. Refresh link: "not modified" bukan kegagalan (26 Sep 2026, 00:46)

### Gejala
User menekan `🔄 Perbarui Semua` → 7 warning per tekanan:
`400 Bad Request: there is no text in the message to edit` (method `editMessageText`).
Total 58 warning, padahal caption sudah benar semua.

### Akar masalah (2 lapis)
1. `editMessageCaption` **berhasil** secara fungsional tetapi Telegram membalas
   `400 message is not modified` karena caption yang dikirim identik dengan yang
   ada. Kode memperlakukannya sebagai kegagalan, lalu jatuh ke fallback
   `editMessageText` yang pada pesan video **pasti** 400 → warning palsu.
2. `lib/telegram.js` me-retry sebagai plain text pada **setiap** 400 saat
   `parse_mode: HTML`, termasuk 400 yang sama sekali tidak soal HTML.

### Perbaikan
- `refreshVidoyLink` membaca hasil edit secara eksplisit:
  - sukses → `captionUpdated = true`
  - `message is not modified` → **sukses** (caption sudah benar), tidak jatuh
    ke fallback
  - `message to edit not found` → pesan sudah dihapus user → pointer
    `tg_chat_id`/`tg_message_id` **dibersihkan** (fitur `clearVidoyTelegramPointer`)
    supaya part bisa dikirim ulang di run berikutnya
  - error lain → fallback `editMessageText` (untuk pesan ber-teks)
- `lib/telegram.js`: retry plain-text hanya bila 400-nya memang parse entities
  (`isHtmlEntityError`), sehingga warning palsu tidak muncul lagi.

### Verifikasi
- Uji nyata: `editMessageCaption` ke msg#5615/5616/5617 membalas
  `message is not modified` → kini dibaca sebagai sukses.
- `test-vidoy-uploader` 87 pass, `test-btn-style` 10, `test-html-safety` 22,
  `test-caption-html-escape` 6, `test-libmenu-grid` 14,
  `test-telegram-callback-retry` / `transient-retry` (9/9) / `apiPost` (4/4) — 0 fail.

## 12. Panel Vidoy Links masih pakai domain hardcode (26 Sep 2026, 00:52)

### Gejala
Isi `🗂 Vidoy Links` menampilkan `vidoy.asia/e/…` padahal URL sebenarnya
`https://vski.cc/e/…`. User: "kok nggak berubah cok link e".

### Akar masalah
`shortLink()` di `handlers/admin.js` (fungsi terpisah dari `shortLinkLabel` di
`handlers/vidoy.js`) masih mempatok domain `vidoy.asia`. Waktu caption diperbaiki
.awal, hanya fungsi di `handlers/vidoy.js` yang diubah — bagian panel terlewat.

### Perbaikan
`shortLink()` di `handlers/admin.js` sekarang memakai domain asli dari URL, sama
seperti `shortLinkLabel()`. Konsisten antara panel dan caption.

### Catatan: kenapa link tidak berubah saat "Perbarui Semua"
Semua 7 record `link_alive = true` (🟢) dan link yang dikembalikan dashboard
**identik** dengan yang tersimpan, jadi memang tidak ada yang perlu diupdate —
itu perilaku yang benar. Namun `linkAlive()` hanya mengecek status HTTP, dan
`vski.cc/e/<id>` ternyata hanya halaman "Validating browser…" yang
mengarahkan lewat JS ke `vidmonstr.com/e/<id>`. Artinya pengecekan hidup saat
ini **terlalu longgar**: halaman validasi selalu 200 walaupun file-nya sudah
hilang. perbaikan lanjutan (belum dikerjakan): follow redirect + cek apakah
halaman tujuan benar-benar memuat player.

### Verifikasi
- 4 varian link → label domain benar; `test-vidoy-uploader` 88 pass.

## 13. linkAlive: benar-benar cek video, bukan cuma HTTP 200 (26 Sep 2026, 00:56)

### Klarifikasi domain (dari user)
`vidoy.asia` **hanya** domain API untuk upload — bukan web publik, dan sewaktu-waktu
bisa ganti. Audit kode: `vidoy.asia` kini muncul **hanya** di
`VIDOY_BASE = process.env.VIDOY_BASE || 'https://vidoy.asia'` (base URL upload,
sudah configurable). Tidak ada lagi pembangkitan web publik/caption dari domain itu:
- `fetchPublicLink()` mengambil link `/e/<id>` dari halaman dashboard
- `buildFolderUrl()` memakai host folder terpisah

### Temuan
`linkAlive()` lama hanya `curl -o /dev/null -w %{http_code}`. Padahal domain
depan (mis. `vski.cc`) hanya menampilkan halaman "Validating browser…" (953 byte)
yang mengarahkan lewat JS → **selalu HTTP 200**, walaupun file-nya sudah hilang.
Artinya "Perbarui" tidak pernah bisa menemukan link mati.

### Perbaikan
- `linkAlive()` → objek `{ alive, reason, finalUrl }`:
  1. ambil halaman (follow redirect, simpan body)
  2. deteksi halaman mati (404/not found/deleted/expired/tidak ditemukan)
  3. jika halaman interstitial, ambil tujuan dari `meta refresh` atau
     `location.replace(...)` lalu ikut ke sana
  4. **wajib** halaman tujuan punya player (`.m3u8`/`.mp4`/`<video>`/player+file)
     → jika tidak, ditandai mati dengan alasannya
- `refreshVidoyLink()` memakai `check.alive` + menyimpan `reason` & `finalUrl`
  sehingga panel bisa menampilkan alasan saat link mati.

### Verifikasi (uji nyata)
| Link | Hasil |
|---|---|
| `vski.cc/e/ru9a4av12kd9` | ✅ alive, final `vidmonstr.com/e/ru9a4av12kd9` |
| `vski.cc/e/vn6z1ypbazhf` | ✅ alive |
| `vski.cc/e/r5n4whnd8250` | ✅ alive |
| `vski.cc/e/tidak-ada-id-999` | ❌ mati — "file hilang (404 Page Not Found)" |
| `vidmonstr.com/e/tidak-ada-id-999` | ❌ mati — redirect ke `/404` |

- `test-vidoy-uploader` 92 pass (+5 tes: linkAlive bukan status-only,
  pageHasPlayer, interstitialTarget, dan **vidoy.asia hanya boleh sebagai
  VIDOY_BASE** di seluruh file), `test-btn-style` 10, `test-html-safety` 22,
  `test-caption-html-escape` 6, `test-libmenu-grid` 14 — 0 fail.

## 14. Bug: callback "Download Semua" tidak terbaca (off-by-one) — 26 Sep 2026, 01:00

### Gejala
User menekan `⬇️ Download Semua` → menu target **muncul** (perbaikan spread
berhasil) → menekan `📥 Vidoy + TG` → **tidak terjadi apa-apa** (tombol ditekan
dua kali). Log hanya mencatat callback, tanpa "Menyiapkan batch download…",
tanpa pre-scan, tanpa unduhan; CPU 0%, tanpa socket, `media_parts` tetap 0.

### Akar masalah
Parser callback memakai index tetap:
```js
const rawUrl = isTargetPick ? data.slice(11) : data.slice(8);          // ✗
const batchTarget = isTargetPick ? (data.slice(8, 11).split(':')[0]) : ''; // ✗
```
Panjang prefix `"sam_allgo:"` = **10** karakter, bukan 11. Untuk
`data = "sam_allgo:vyt:2"`:
- `data.slice(11)` → `"yt:2"` → `resolveUrl` gagal → `animeUrl` kosong
- `data.slice(8, 11)` → `"o:v"` → target tidak valid

Akibatnya bot menjawab toast `⚠️ Link kadaluarsa, kirim ulang` (tidak terlihat
di log) dan **tidak pernah menjalankan batch**. Salah sama berlaku untuk
`kur_allgo`.

### Perbaikan
Fungsi `parseBatchPick(data, prefix)` — memecah berdasarkan panjang prefix
string, bukan index tetap:
- `sam_all:2` → `{ target: '', urlId: '2' }`
- `sam_allgo:vyt:2` → `{ target: 'vyt', urlId: '2' }`
- `kur_allgo:vyt:9` → `{ target: 'vyt', urlId: '9' }`

Kedua handler (`sam_all`/`sam_allgo`, `kur_all`/`kur_allgo`) memakai helper ini.

### Verifikasi
- 8 kasus parser (termasuk `urlId` non-numerik) + assertion bahwa handler tidak
  lagi memakai `data.slice(<angka>)`; `test-vidoy-uploader` 94 pass.
- `test-btn-style` 10, `test-anime-topic-router` 18, `test-sam-picker-pagination`
  exit 0 — 0 fail.
- PM2 restart (01:01:46), `Bot running`.
- **Belum diverifikasi live** — user perlu menekan ulang `📥 Vidoy + TG`.

## 15. Bug: `targetLabel is not defined` di bot.js (26 Sep 2026, 01:02)

### Gejala
User menekan `Download Semua` → `📥 Vidoy + TG`:
```
📦 Menyiapkan batch download...
🔎 Pre-scan selesai: 220 ep layak unduh, 0 dilewati
❌ Error: targetLabel is not defined
```
Log: `ReferenceError: targetLabel is not defined at scraper/bot.js:3297:61`

### Akar masalah
Saat menambahkan judul progress & laporan batch (slice "target di Download
Semua"), saya memanggil `targetLabel(target)` — fungsi itu **ada di
`handlers/vidoy.js`**, tapi tidak di-import ke `bot.js`, dan tidak ada
`require` untuknya. Batch sudah mulai (pre-scan jalan) lalu crash saat membuat
judul RichProgress, sehingga tidak ada episode yang diunduh.

### Perbaikan
Fungsi lokal `batchTargetLabel(target)` di `bot.js` (dipakai di 3 titik: judul
progress + 2 laporan batch) — tidak lagi bergantung silang antar modul.

### Pencegahan
Tes statis baru: mengambil seluruh badANode runner batch, membuang komentar,
lalu memastikan **tidak ada bare call fungsi yang tak terdefinisi** di sana
(buat obrigado calls member & keyword). Test ini akan menangkap
`ReferenceError` serupa sebelum runtime. `batchTargetLabel` juga diuji untuk
4 target.

### Verifikasi
- `test-vidoy-uploader` 96 pass, `test-btn-style` 10, `test-anime-topic-router` 18,
  `test-sam-picker-pagination` exit 0 — 0 fail.
- PM2 restart (01:04:29), `Bot running`.

## 16. Batch anime: lewati yang sudah lengkap + mode "Lengkapi yang hilang" (26 Sep 2026)

### Keputusan user
- **Vidoy: duplikat dilarang keras.** (Ternyata sudah dijamin `uploadSingle()` yang
  mengecek `vidoy_uploads` sebelum upload → `skipped: true`.)
- **Telegram: tidak masalah** kalau dikirim ulang — tapi diverifikasi bahwa
  Telegram **tidak menimpa**, setiap `sendVideo` membuat pesan baru. Jadi
  "kirim ulang semua" hanya buang-buangan bandwidth (219 episode diunduh ulang).

### Perubahan
1. **Default: episode yang sudah lengkap DILEWATI.**
   `animeDoneMap(title)` membaca `vidoy_uploads` sekali, lalu di dalam loop:
   `link && hasTg` → `⏭️ sudah lengkap` (tidak diunduh, tidak dikirim).
   Angka `skippedDone` dilaporkan di pesan akhir.
2. **Tombol baru `⟳ Lengkapi yang hilang`** (hijau) di menu target, untuk
   samehadaku & kuronime.
   - Hanya menyaring episode `link && !hasTg` → yang pesan Telegram-nya hilang
     (pointer sudah dibersihkan otomatis saat pesan dihapus user).
   - Target dikunci `tg` → **tidak ada upload baru ke Vidoy** (aturan duplikat).
   - Kalau tidak ada yang perlu dilengkapi → pesan
     "✅ Tidak ada episode yang perlu dilengkapi — semua pesan Telegram masih ada."

### Verifikasi
- Smoke test logika dengan DB mock (Ep 1 lengkap, Ep 2–3 link tanpa pointer,
  Ep 4–5 baru): `dilewati [1]`, `lengkapi [2,3]`, `normal [5]` ✓
- `test-vidoy-uploader` 100 pass (+4 tes: skip default, animeDoneMap,
  mode lengkapi, dan **uploadSingle tetap mencegah duplikat Vidoy**),
  `test-btn-style` 10, `test-anime-topic-router` 18, `test-sam-picker-pagination`
  exit 0 — 0 fail.

### Catatan
Job 220 episode Naruto masih berjalan saat perubahan ini dibuat; perubahan baru
aktif setelah restart. Tidak di-restart agar job tidak terputus — restart
dilakukan setelah job selesai.

## 17. Video anime masuk topic General, bukan topic Anime (26 Sep 2026)

### Gejala
User: "kok masuk ke topic 1 (general) kok bukan topic anime kenapa?" — semua
episode Naruto dari batch `Vidoy + TG` muncul di topic **General**.

### Akar masalah
Jalur anime yang lama memakai `buildAnimeSender()`
(`lib/animeTopic.js`) yang:
1. me-resolve thread topic anime lewat `resolveAnimeThread()` →
   `getOrCreateTopic('anime')` (otomatis buat/pakai ulang, tanpa hardcode ID), lalu
2. menambah `message_thread_id` ke opsi kirim, dan
3. memaksa `supports_streaming: true`.

`actionAnimeEpisode` (jalur upload Vidoy anime) memanggil `_ctx.sendVideo` polos
→ **tanpa `message_thread_id`** → Telegram menaruhnya di topic General.OOK juga
tidak memakai sender anime sama sekali.

### Perbaikan
- `initVidoy` kini menyuntikkan `sendAnimeMedia` (getter, mengikuti pola
  `sendVideo`/`sendToTopicVideo` yang sudah ada).
- `actionAnimeEpisode` mengirim lewat `sendAnimeMedia(chatId, destPath, mediaOpts)`
  dengan fallback ke `sendVideo` bila sender tidak tersedia. `mediaOpts` tetap
  membawa `supports_streaming` + durasi/dimensi; sender juga memaksa flag tersebut.

### Verifikasi
- `test-vidoy-uploader` 103 pass (+3 tes: anime wajib lewat sendAnimeMedia,
  initVidoy menyuntikkannya, dan kontrak `lib/animeTopic`),
  `test-anime-topic-router` 18, `test-btn-style` 10 — 0 fail.
- Restart dilakukan setelah job batch selesai agar tidak terputus.

## 18. KONTRAK MEDIA — test pengunci streaming & format caption (26 Sep 2026)

### Latar
User angrily warned repeatedly: **video WAJIB streaming** dan **format caption
WAJIB tidak berubah**. Kalau rusak lagi, user menyatakan akan menuntut
pertanggungjawaban. Jadi ini harus dicek otomatis, bukan INGAT-ingat.

### `scraper/tests/test-media-contract.js` (file baru, terpisah & diberi nama jelas)
10断言:
1. **Format caption persis karakter demi karakter** (golden):
   - anime: `➧ Judul :- <b>…</b>` / `➧ Episode :- 5` / `➧ Provider :- …` / `➧ Link :- <a …>…</a>`
   - drama: `➧ Part/Episode :- 1 (Ep 1–10)`
2. Caption tanpa link tetap 3 baris (tidak ada baris Link kosong).
3. Caption **tidak pernah** memuat `undefined`.
4. **Setiap call site kirim video di seluruh repo** wajib punya
   `supports_streaming` — pemindaian semua `.js` (kecuali `tests/`). Opsi yang
   ditulis lewat variabel (`opts`, `options`, `mediaOpts`) ikut ditelusuri ke
   definisinya. Call site `file_id` dikecualikan (kirim ulang file yang sudah ada
   di Telegram → tidak ada upload, flag tidak berlaku). Wrapper passthrough
   (`sendToTopicVideo`) ada di **allowlist** — dan allowlist ikut gagal bila
   baris tersebut berubah, jadi wajib ditinjau manusia.
5. `lib/animeTopic` tetap memaksa `supports_streaming`.
6. `handlers/vidoy` punya minimal 2 `supports_streaming` (drama & anime) dan
   anime lewat `sendAnimeMedia` (topic Anime).
7. `lib/telegram` meneruskan `supports_streaming` ke API di semua jalur.
8. Keluarannya **non-zero exit + pesan "KONTRAK MEDIA BERSYARAH"** kalau gagal.

### Bug nyata yang langsung ketahuan oleh kontrak ini
`buildCaption` tidak阐述了guard `title` → `title: undefined` menghasilkan
`➧ Judul :- <b>undefined</b>` (persis kelas bug yang dikeluhkan user).
Sekarang `title || '—'`. Caption dengan judul valid **tidak berubah format**.

### Verifikasi
- `test-media-contract` 10 pass; `test-vidoy-uploader` 103; `test-caption-html-escape` 6;
  `test-html-safety` 22; `test-btn-style` 10; `test-anime-topic-router` 18;
  `test-libmenu-grid` 14; `test-sam-*` & telegram retry suites exit 0 — 0 fail.

## 19. Bug: `db is not defined` di batch anime (26 Sep 2026, 01:28)

### Gejala
```
📦 Menyiapkan batch download...
🔎 Pre-scan selesai: 220 ep layak unduh, 0 dilewati
❌ Error: db is not defined
```

### Akar masalah
`animeDoneMap()` (ditambahkan di §16) memanggil `db.listVidoyUploads(...)`,
tapi di `bot.js` modul db di-import **destructuring**:
```js
const { pool, ..., listRecentVidoyUploads } = require('./db');
```
Tidak ada objek bernama `db` → `ReferenceError` setiap kali batch dijalankan.

### Perbaikan
- `listVidoyUploads` ditambahkan ke import destructuring.
- `animeDoneMap` memanggil `listVidoyUploads(...)` langsung.

### Pencegahan
Tes statis diperluas (yang sebelumnya hanya mengecek **fungsi** tak terdefinisi,
karena itu yang menangkap `targetLabel`):
- sekarang mengecek juga **alias modul** yang dipanggil sebagai objek
  (`db.`, `_vidoyHandlers.`, `Vidoy.`, dll) di jalur runner batch
- plus tes khusus: `bot.js` **dilarang** memakai `db.` dan wajib meng-import
  `listVidoyUploads`

Artinya kelas bug "X is not defined" — yang sudah menimpa dua kali
(`targetLabel`, lalu `db`) — sekarang dicek sebelum runtime.

### Catatan lain (tidak terkait kode)
Instance Replit di-restart (pm2 state + log hilang). Setelah start ulang, bot
lama ternyata masih hidup sebagai proses liar di luar pm2 (PID 219) →
`409 Conflict: terminated by other getUpdates request`. Orfan tersebut di-kill
(SIGTERM), pm2 `save` ulang, dan start pakai `--max-memory-restart 700M`.

### Verifikasi
- `test-vidoy-uploader` 105 pass, `test-media-contract` 10, `test-btn-style` 10,
  `test-html-safety` 22, `test-caption-html-escape` 6, `test-anime-topic-router` 18,
  `test-libmenu-grid` 14, `test-sam-*` exit 0 — 0 fail.
- PM2 restart 01:30:21, `Bot running`, tanpa 409.

## 20. Skip episode tidak bekerja → duplikat Telegram (26 Sep 2026, 02:31–02:37)

### Gejala
`hokireceh` menekan `sam_allgo:vyt:2` (Vidoy + TG). Video terkirim ke
**topic Anime (threadId 655)** ✓, tapi:
- **tidak ada** log `Vidoy upload sukses`
- `vidoy_uploads` (anime) tetap **60 record**
- pointer berubah: part 1 msg#5674 → **#5771**, part 2 → #5772

Artinya episode **1–60 terkirim ulang ke Telegram** (duplikat), sementara
upload Vidoy dilewati (karena record ada). Persis yang tidak boleh terjadi.

### Akar masalah
`animeDoneMap()` membaca `r.tg_chat_id` / `r.tg_message_id`, tapi
`listVidoyUploads()` **tidak mengambil kedua kolom itu** di SQL-nya
(hanya kind, part, ep_start/end, title, folder_url, link, dashboard, provider,
caption, uploaded_at). Akibatnya `hasTg` selalu `false` →
`st.link && st.hasTg` selalu salah → tidak ada episode yang dilewati.

Sudah terduga saat simulasi karena simulasi memakai **mock**, bukan
`listVidoyUploads` asli — kelemahan tes saya.

### Kerugian
±20 pesan Telegram duplikat (part 1–20 sudah terkirim ulang, msg#5771+).
Tidak ada duplikat di **Vidoy** (uploadSingle tetap skip). Pointer lama
(msg#5674–5733) jadi orphan — pesan lama masih ada di topic tapi tak terlacak.

### Perbaikan
- `listVidoyUploads` sekarang mengambil `tg_chat_id, tg_message_id`.
- Uji nyata ke DB: 60 record → **dilewati 60 · diproses 160** ✓
- Bot dihentikan saat ditemukan agar duplikat tidak bertambah.
- Tes baru mengunci: `listVidoyUploads` WAJIB mengambil kedua kolom pointer,
  dan `animeDoneMap` WAJIB menghitung `hasTg` dari keduanya.

### Verifikasi
`test-vidoy-uploader` 107 pass, `test-media-contract` 10 pass — 0 fail.

## 21. ATURAN KERAS (ditetapkan user, 26 Sep 2026)

> **ATURAN KERAS #1 — VIDOY**
> Dilarang keras ada **duplikat di Vidoy**. Satu episode = satu file di Vidoy,
> untuk selamanya. Kalau record-nya sudah ada → **dilewati**, tidak pernah
> di-upload ulang. Tidak ada pengecualian.
>
> **ATURAN KERAS #2 — TELEGRAM**
> Telegram **boleh** mengirim ulang. Duplikat di Telegram **tidak masalah**,
> tidak perlu dicegah, tidak perlu dihindari. Kalau episode dikirim ulang ke
> Telegram, itu dianggap normal dan tidak dianggap bug.

Konsekuensi yang sudah disepakati:
- Kalau pointer Telegram kosong (pesan dihapus) → episode **dikirim ulang**
  (link Vidoy yang sudah dipakai, tanpa upload ke Vidoy).
- Kalau `vidoy_uploads` sudah punya link → upload ke Vidoy **dilewati**,
  playlist Telegram tetap boleh dikirim.

Referensi: §20 (bug kolom pointer) — duplikat Telegram di situ **diizinkan**,
yang tidak boleh terjadi hanya duplikat di Vidoy.

## 22. REGRESI: season merusak slug library (26 Sep 2026)

### Gejala
User: "deteksi yang udah masuk juga gak work kenapa jadi hancur total logikaku
setelah penambahan vidoy".지 Anime bergaya URL `-season-N`/`-part-N` tidak lagi
terdeteksi "sudah masuk" di library.

### Akar masalah
`bot.js:1818` `samehadakuAnimeSlug()` menyusun slug library dari judul + season:
```js
const base = `${info.title}${info.season ? ` S${info.season}` : ''}${info.part ? ` P${info.part}` : ''}`;
```
Luego saya mengubah `parseSamehadakuEpisode`/`parseSamehadakuAnime` supaya
**judul ikut memuat** season (`-season-4` → "… S4"). Akibatnya season ditambahkan
**dua kali**:

| URL | slug sebelum | slug setelah (rusak) |
|---|---|---|
| `naruto-kecil` | `anime:naruto-kecil` | sama ✓ |
| `…-s3` (format situs) | `anime:…-s3` | sama ✓ |
| `…-season-4` | `anime:…-s4` | **`anime:…-s4-s4`** ❌ |
| `…-season-2-part-2` | `anime:…-s2-p2` | **`anime:…-s2-p2-s2-p2`** ❌ |

Slug berbeda → part yang sudah tersimpan tidak ketemu → unduhan ulang & library
terpecah. Data di DB diverifikasi **tidak rusak** (0 slug terduplikasi dari 146).

### Perbaikan
- Parser **kembali** ke perilaku semula: judul polos, `season`/`part` di field
  terpisah. `samehadakuAnimeSlug` tidak berubah lagi.
- Suffix season untuk **folder/nama file/mediaKey Vidoy** dipindah ke
  `handlers/vidoy.js` lewat `withSeasonSuffix(title, season, part)` yang
  **idempoten** (tidak menghasilkan "S4 S4").

### Tes (7 assertion baru)
- 4 kasus slug library harus identik dengan sebelum perubahan
- judul parser harus polos + season di field terpisah
- `withSeasonSuffix` idempoten (dipanggil 2x tetap 1 suffix)
- `actionAnimeEpisode` wajib memakai `vidoyTitle` untuk mediaKey & nama file
- 3 test lama yang mengunci perilaku salah dikoreksi

`test-vidoy-uploader` 110 pass, 0 fail. `test-media-contract` 10,
`test-html-safety` 22, `test-samehadaku-parse-ep1` 14,
`test-samehadaku-slugtail-fallbacks` 28, `test-samehadaku-movie-link` 15,
`test-anime-topic-router` 18, `test-libmenu-grid` 14, `test-btn-style` 10,
`test-caption-html-escape` 6 — 0 fail.

### Pelajaran
Perubahan pada parser yang dipakai banyak jalur harus dicek terhadap **semakipemanggil**
terutama yang menyusun slug/kunci DB. Regresi ini hanya terlihat setelah-user,
karena simulasi saya tidak memeriksa slug library.

## 23. Deteksi "sudah ada" di menu picker = library ∪ Telegram (26 Sep 2026)

### Permintaan user
"semua wajib ada tidak boleh ada yang bolong, dan di menu itu buat deteksi yang
sudah ada di Telegram."

### Fakta sebelum perubahan
Picker episode menandai episode dari **library saja**:
`bot.js` → `listPartsWithFile(slug)` → `SELECT … FROM media_parts WHERE file_id IS NOT NULL`.
Jalur upload Vidoy anime **tidak pernah** menulis `media_parts` (0 kemunculan
`media_parts`/`savePartFileId` di `handlers/vidoy.js` & `services/vidoyService.js`).
Akibatnya 62 episode Naruto yang sudah terkirim ke Telegram tetap terlihat "belum
ada" di menu, dan `Download Semua` menghitung 220.

### Perubahan
- `episodeStatusMap(slug, vidoyTitle)` — sumber gabungan:
  `lib` dari `media_parts`, `tg` dari `vidoy_uploads` (hanya bila pointer
  `tg_chat_id` + `tg_message_id` masih tersimpan), `link` selalu diambil.
  Kunci/library: `anime:<slug>`; kunci Vidoy: judul (`"Naruto Kecil"`).
- Kedua picker (samehadaku & kuronime) memakai `done = lib ∪ tg`.
- Label tombol episode: `✅ N` (di library) · `📨 N` (di Telegram saja) ·
  `Ep N` (belum). Caption picker menyebut jumlah keduanya.
- Tidak ada penulisan ke `media_parts` dari jalur Vidoy (mempertahankan
  pemisahan: library = penyimpanan library; Vidoy = status pengiriman).

### Verifikasi
Uji nyata ke DB untuk `anime:naruto-kecil` / `Naruto Kecil`:
```
✅ library       : 0
📨 Telegram saja: 62
belum            : 158  (43 di antaranya sudah ada di Vidoy, pointer sengaja dikosongkan)
contoh Ep 18     : { lib: false, tg: false, link: 'https://vski.cc/e/8hn3e2ok9ulw' }
```
`test-vidoy-uploader` 112 pass (+2 tes), `test-media-contract` 10,
`test-btn-style` 10, `test-anime-topic-router` 18, `test-sam-*` exit 0,
`test-libmenu-grid` 14 — 0 fail.

## 24. "Sudah ada" hanya yang punya pesan Telegram + warna tombol per status (26 Sep 2026)

### Gejala
Picker menampilkan `✅ 113 sudah ada · 📨 69 di Telegram` (Naruto Kecil).
Data nyata: hanya **69** episode yang punya pesan Telegram; **44** dihitung
"sudah ada" padahal baru ada di Vidoy (video-nya belum ada di topic Anime).

### Akar masalah
Aturan "sudah ada" = `media_parts` (library) ∪ Telegram. Library hanya berarti
**file tersimpan untuk unduh ulang**, bukan berarti videonya sudah ada di topic.
Akibatnya episode yang belum pernah dikirim ikut terlewati.

### Trace yang dilakukan
- `bot.js:1836` sumber centang picker = `listPartsWithFile()` (library)
- `handlers/vidoy.js` / `services/vidoyService.js` → 0 kemunculan `media_parts`
  (jalur Vidoy memang tidak menulis library)
- `animeDoneMap` (batch) memakai `vidoy_uploads`
- **Caption kuronime** masih pola lama (tidak ikut saat samehadaku diperbarui) —
  baru ketahuan saat trace kedua picker
- Label `✅ Semua episode sudah di library` di `buildPicker` menyesatkan karena
  `done` = library ∪ Telegram

### Perubahan
1. **Aturan "sudah ada" = punya pointer Telegram saja.** Episode yang hanya ada
   di Vidoy atau library dihitung **belum** → tombol `🗄` merah.
2. Warna tombol episode (satu warna, satu simbol):
   | Status | Tombol | `style` |
   |---|---|---|
   | Punya pesan Telegram | `📨 N` | `primary` (biru) |
   | Ada di Vidoy / library, belum dikirim | `🗄 N` | `danger` (merah) |
   | Belum ada | `Ep N` | — |
3. Caption picker memakai `statusBreakdown()` di **kedua** picker:
   `📨 N di Telegram · 🗄 N perlu dikirim · ⬜ N belum ada`
4. Label buildPicker: `✅ Semua episode sudah ada` (bukan "di library").

### Verifikasi (DB nyata, Naruto Kecil)
```
caption : 🎞 220 episode · 📨 69 di Telegram · 🗄 44 perlu dikirim · ⬜ 107 belum ada
Ep 1   → 📨 1   primary   Ep 18  → 🗄 18  danger
Ep 70  → 📨 70  primary   Ep 150 → Ep 150 (tanpa warna)
```
`test-vidoy-uploader` 115 pass (3 tes warna/breakdown/done + 2 tes lama
dikoreksi), `test-media-contract` 10, `test-btn-style` 10,
`test-anime-topic-router` 18 — 0 fail. `node --check` CLEAN.

## 25. Flow Telegram-only tidak membawa link Vidoy (26 Sep 2026)

### Gejala
User: "`⟳ Lengkapi yang hilang` tidak sertakan link padahal link ada". Pesan
episode 18–60 di topic **tidak** punya baris `➧ Link :-`, padahal
`vidoy_uploads` menyimpan linknya.

### Trace (bukan asumsi)
| Pemeriksaan | Hasil |
|---|---|
| Kemunculan `batch mode lengkapi` di log | **1×** — `⟳ Lengkapi` baru jalan sekali lalu terputus (instance restart) |
| `vidoy_uploads.tg_message_id` untuk part 18–60 | **NULL** → pesan-pesan itu memang bukan dari flow Vidoy |
| `media_parts.file_name` | `Naruto-18-720p-SAMEHADAKU.CARE.mp4` → format **flow LAMA** (`downloadSamehadakuFile`), bukan `Naruto Kecil — Ep 18.mp4` (format flow Vidoy) |
| Caption di `vidoy_uploads` | **sudah benar** (`➧ Link :- vski.cc/e/8hn3e2ok9ulw`) |

Jadi pesan yang dilihat user dikirim flow **Telegram-saja** (`handlers/download.js`)
yang **tidak tahu-menahu soal Vidoy** — caption-nya tidak pernah mengambil link.

### Perubahan
1. `scraper/lib/caption.js` (baru) — sumber tunggal untuk:
   - `shortLinkLabel()` (label ikut domain asli)
   - `vidoyLinkLine()` (baris `➧ Link :- <a …>`)
   - `withSeasonSuffix()` (dipindah dari `handlers/vidoy.js`, prevents duplikasi)
2. `db.getVidoyLink(mediaKey, kind, part)` — baca link dari `vidoy_uploads`
   (**read-only, tanpa upload**).
3. `handlers/download.js` — `withVidoyLink(caption, title, part, season)`
   dipasang di **2 titik kirim** (per-episode & batch): caption otomatis dapat
   baris Link kalau episode sudah ada di Vidoy, dan tidak pernah dobel.
4. `handlers/vidoy.js` memakai helper bersama (definisi lokal dihapus).

### Catatan
- Tidak ada upload baru di jalur ini — hanya pembacaan DB.
- Two flow (Telegram-saja & Vidoy) sekarang menghasilkan caption yang sama.
- Episod yangcaption-nya sudah terlanjur terkirim tanpa link dapat diperbaiki lewat
  panel `🔄 Perbarui` (pointer Telegram tersimpan) atau dengandelete + kirim ulang.

### Verifikasi
`test-vidoy-uploader` **118 pass** (+3 tes: konsistensi flow, `getVidoyLink`,
sumber tunggal `lib/caption`), `test-media-contract` 10, `test-btn-style` 10,
`test-caption-html-escape` 6, `test-anime-topic-router` 18 — 0 fail,
`node --check` CLEAN.

## 26. `!dell` sekarang lengkap: hapus library + pesan Telegram, LINK VIDOY DIPERTAHANKAN (26 Sep 2026)

### Diskusi dengan user & hasil trace
Alur yang diinginkan user:
```
!dell <judul> → hapus (library + Telegram), TIDAK menghapus Vidoy
→ Download Semua: cek Vidoy (ada → skip upload) + cek Telegram (belum → kirim)
→ caption + link Vidoy yang sudah ada
```
Trace menemukan **3 hal**:

| Asumsi | Kenyataan |
|---|---|
| `!dell` hapus semua | ❌ `deleteMedia()` hanya `DELETE FROM media` — **`media_parts` tidak dihapus** (bug) |
| `!dell` hapus pesan Telegram | ❌ **tidak ada** `deleteMessage` di jalur itu (PRJS maupun fomo-drama) |
| link Vidoy tetap | ✅ `vidoy_uploads` tidak disentuh |

Karena `media_parts` tidak dihapus, episode tetap ditandai "sudah ada" → alur user
**macet di langkah pertama**.

### Perubahan (A + B + C, disetujui user)
| | Perubahan |
|---|---|
| **A** | `deleteMedia()` sekarang menghapus `media_parts` **dan** `media` (selaras fomo-drama) |
| **B** | `clearVidoyTelegramPointers(mediaKey, kind)` — `UPDATE … SET tg_chat_id=NULL, tg_message_id=NULL` **tanpa menyentuh `link`** (ATURAN KERAS #1) → episode jadi `🗄` merah = "perlu dikirim" |
| **C** | `deleteTelegramMessagesRaw()` menghapus pesan dari pointer library **dan** pointer `vidoy_uploads`; jumlah terhapus dilaporkan di pesan konfirmasi. Ditambah `setPartTelegramPointer()` yang menyimpan `chat_id`/`message_id` setiap kali library mengirim part (agar `!dell` bisa menghapusnya ke depan) |

Konfirmasi `!dell` sekarang berbunyi:
`🗑️ … dihapus dari library (semua part)` + `📨 Pesan Telegram dihapus: N` +
`🗄 Link Vidoy tetap disimpan: N episode → ditandai 🗄 (perlu kirim ulang ke Telegram)`

### Catatan
- Pointer library **baru** diisi sejak deploy ini; 147 slug lama belum punya
  pointer, jadi `!dell` untukJudul lama hanya bisa menghapus pesan yang tercatat
  di `vidoy_uploads` (jalur Vidoy).
- `listVidoyTelegramPointers(media.nama, 'anime')` memakai **nama**-judul
  (`"Naruto Kecil"`) yang sama dengan `media_key` di `vidoy_uploads`.

### Verifikasi
- Smoke test DB: semua 6 fungsi terdefinisi; pointer Naruto tersedia **69**
  (mis. part 1 → msg#5771); pointer library 0 (expected, kolom baru).
- `test-vidoy-uploader` **122 pass** (+4 tes: A, B, C×2), suite lain 0 fail,
  `node --check` CLEAN.
- 2 silent no-op tertangkap saat implementasi: helper `deleteTelegramMessagesRaw`
  dan import `./db` tidak ter-insert → would've `ReferenceError`. Keduanya
  tertangkap oleh `node --check` + verifikasi import eksplisit.
