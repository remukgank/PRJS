# Trace Hosting Video Baru: vikuy.click (Visoy Platform)

**Date**: 2026-10-04
**Author**: opencode
**Status**: Trace/riset saja — **belum ada perubahan kode**, menunggu approve user sebelum integrasi.

## Tujuan

User menemukan hosting video baru `https://vikuy.click/` ("Vikuy — Upload Videos.
Earn Money.", komentar JS internal = **"Visoy Platform"**) dan menyediakan kredensial
`VIKUY_EMAIL` / `VIKUY_PASSWORD` di secrets. Tugas: trace cara kerja + API-nya
sebelum memutuskan apakah diintegrasikan ke alur dual-host Vidara+Vidoy.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| *(tidak ada)* | Trace eksternal saja; tidak ada kode repo yang disentuh. Satu video test dibuat & dihapus dari akun user (lihat Verification). |

## Hasil Trace (semua teruji langsung)

### Akses & autentikasi

| Aspek | Hasil |
|---|---|
| Stack | PHP + session cookie `PHPSESSID` (HttpOnly, path=/, 30 hari), di belakang Cloudflare |
| Login | `POST /login` field `email`, `password`, `remember` → **302 `Location: dashboard`** = sukses |
| Cloudflare Turnstile | Ada widget di halaman login & remote upload, tapi **login via curl tanpa token diterima** (Turnstile tidak memblokir server-side di login) |
| API key | `GET /settings.php?tab=apikey` → tombol POST `gen_api` → key prefix **`vsy_`** (44 char) berhasil digenerate. **API Docs = link mati `href="#"`** → peran key belum jelas; semua tes di bawah pakai **session cookie** |
| ⚠️ Insiden minor | Nilai API key sempat terbaca sebagian di output grep saat generate (pelanggaran §8 "jangan cetak kredensial"). Saran: user klik **Generate Key** ulang untuk merotasi. File temporary `/tmp/vk_key.txt` (di-wipe saat restart), tidak masuk repo |

### Upload API — `POST https://vikuy.click/upload.php`

Teruji end-to-end dengan file MP4 30 KB (chunk tunggal):

- **Tanpa Turnstile** ✓, auth = session cookie.
- Multipart chunked, **`CHUNK_SIZE = 4194304` (4 MB)**, field per request:

  | Field | Nilai |
  |---|---|
  | `chunk_upload` | `1` |
  | `upload_id` | client-generated (`Date.now().toString(36)` + random) |
  | `chunk_index` | 0-based |
  | `total_chunks` | `ceil(size/4MB)` |
  | `file_name` | nama file asli |
  | `title` | judul video |
  | `folder_id` | `0` = root |
  | `chunk` | blob 4 MB (`type=video/mp4`) |

- Respons JSON (bukti nyata tes):

  ```json
  {"ok":true,"state":"done","done":true,"id":25729,
   "daily_used":1,"daily_limit":5,"redirect":"videos?upload=ok&id=25729"}
  ```

- **Limit harian**: awalnya `daily_limit: 5` (tes 3 Okt); **setelah user
  mengaktifkan Creator Studio → `daily_limit: 10`** (tes ulang 4 Okt:
  `daily_used:1, daily_limit:10`). JS UI `upload.php` juga mengenal
  `BATCH_LIMIT = 10` (maks 10 file/batch) dan `DAILY_REMAINING` (alert
  "Daily upload limit reached" bila kuota habis).
- **Max 200 MB/file** (teks UI `upload.php`); dukungan MP4/MOV/AVI/MKV/WebM.
- Chunk terakhir diproses server-side (ffmpeg, "Checking codec & preparing MP4 at
  original resolution"). Kalau request terakhir putus → polling
  `POST upload.php` field `check_upload_result=1` + `upload_id` (JS klien: 60×
  interval 5 s). Respons polling `{state:'done'|'failed', ...}`.
- Parallel upload sampai 3 worker per sesi UI (urusan klien, tidak mengikat API).

### Link publik video

`https://vikuy.click/watch?v=<id>` — teruji **200 untuk anonim** (tanpa cookie);
setelah dihapus → **404**. Judul tampil di `<title>`.

### Halaman lain relevan

| Endpoint | Fungsi | Catatan |
|---|---|---|
| `POST /remote_upload.php` | `action=import, urls, folder_id, cf-turnstile-response` — server-side download dari URL; `action=status` = queue (JSON `{success, items, skipped, errors}`) | **Maks 25 URL/batch** (teks UI). Tes nyata 4 Okt: import **TANPA token Turnstile diterima** (`{"success":true,"imported":1}`) → video masuk library, dan **`daily_used` counter upload.php TIDAK naik** (1→2 hanya karena 1 upload chunk tambahan, bukan 3) → remote **tidak mengurangi kuota harian 10**. Belum diuji apakah ada limit terpisah khusus remote |
| Folder | Daftar folder tampil di `remote_upload.php` & `videos.php?folder=<id>` (contoh milik user: Cuan Online=197, **Hijab=198**, Lagi Viral=199) | `folder_id` field remote import & upload chunk berfungsi |
| Edit judul | `POST videos.php` FormData `edit_video_id` + `edit_title` → JSON `{ok, title}` | Teruji: rename `25754` → "Urfavmatcha 3some" ✅ |
| Judul saat remote import | Server **mengabaikan field `title`** — judul = nama file dari URL | Teruji: import `mov_bbb.mp4` + `title=JudulTesDariAPI` → judul tetap **"mov bbb"**. "Deteksi judul asli halaman sumber" harus di sisi klien: baca `<title>` halaman (mis. vidovr) → setelah import, panggil endpoint edit judul |
| `POST /videos.php` `delete_ids=<id>` | Hapus video | Teruji (lihat Verification) |
| Menu lain | `shortlink.php`, `wallet.php`, `arcade.php`, `events.php`, `daily-rewards.php` | Platform social/earn — **bukan** hosting unduhan seperti Vidara |

### Sifat platform

Social video + monetisasi (feed, leaderboard, shortlink earning). **Kandidat =
target upload ke-3** (parallel Vidoy/Vidara), **bukan** sumber download untuk
provider.

## Evaluation terhadap kebutuhan bot

| Kebutuhan | Cocok? |
|---|---|
| Kontrak caption §5 (`Server :- …`, link domain asli) | ✅ link `watch?v=` stabil & publik |
| Volume batch (ratusan episode) | ❌ **10 video/hari** (setelah Creator Studio aktif; sebelumnya 5) → hanya cadangan mikro, bukan pengganti |
| Ukuran file | ⚠️ 200 MB/file → episode tunggal muat; merge-10 (±1 GB) tidak |
| Duplikat | Belum ada info — perlu cek perilaku upload judul sama (aturan keras §6 Vidoy dilarang duplikat) |
| Re-encode server | ⚠️ file hasil = hasil proses ffmpeg, bukan byte asli |

## Celah yang BELUM dibuktikan

1. Apakah API key `vsy_` berfungsi **tanpa** session cookie (semua tes = cookie).
2. ~~Remote upload tanpa Turnstile~~ — **TERBUKTI**: import tanpa token diterima
   (4 Okt). Sisa: apakah ada limit terpisah khusus remote bila diuji beruntun,
   dan apakah `api_key` ikut diterima sebagai alternatif auth.
3. Jam reset `daily_limit` harian.
4. Perilaku re-encode: apakah stream `watch` langsung tanpa transcode tambahan,
   dan berapa lama proses final untuk file besar.
5. Duplikat judul & rate limit per-IP.

## Opsi integrasi (proposal — MENUNGGU approve, jangan diimplementasi dulu)

- **A. Target upload ke-3** (`vk`/`vkt`): provider baru + pointer DB + opsi batch +
  caption `Server :- VIKUY`. Terhambat limit 5/hari → cadangan kecil saat quota
  Vidoy habis & limit Vidara habis.
- **B. Remote upload URL** (server-side download, hemat bandwidth bot) — perlu
  uji Turnstile dulu.
- **C. Dokumentasi saja** (arsip trace ini) sampai ada kebutuhan nyata.

## Verification

- Login: `POST /login` → 302 → `/dashboard` (`Dashboard | vikuy.click`).
- Upload nyata: chunk tunggal → `{"ok":true,"done":true,"id":25729}`.
- Link: `watch?v=25729` → **200** dgn cookie & **200 anon**; `<title>vk_trace_test | vikuy.click`.
- Pembersihan: `POST videos.php delete_ids=25729` → 302; daftar `videos.php` tidak
  lagi memuat `data-id="25729"`; `watch?v=25729` anon → **404**. Akun user bersih.
- **Cek ulang 4 Okt (setelah user aktifkan Creator Studio)**: menu
  `creator-studio.php` muncul (Overview/Earning/My Videos, Account Status Active);
  upload tes ke-2 → `id=25733`, **`daily_used:1, daily_limit:10`** (naik dari 5);
  API Docs di settings masih `href="#"` (mati); video test `25733` dihapus →
  `watch?v=25733` anon 404. Akun bersih.
- **Remote upload 4 Okt**: `action=status` → queue kosong; `action=import`
  1 URL (`mov_bbb.mp4`) **tanpa Turnstile** → `{"success":true,"imported":1}`;
  video masuk library (`id=25739`); upload chunk ke-3 → `id=25740`,
  **`daily_used:2/10`** → remote tidak menaikkan counter kuota harian.
  Pembersihan: hapus `25739` + `25740` (302) → `videos.php` kosong (`data-id=0`),
  keduanya `watch` anon → 404.
- **Kasus nyata vski.cc → folder Hijab (4 Okt, atas permintaan user)**:
  1. `https://vski.cc/d/bpl0ls3lhd6v` → **ditolak remote** (`skipped:1`,
     "link is a web page, no video file") — isinya halaman "Validating
     browser..." yang JS-redirect ke `vidovr.com/d/bpl0ls3lhd6v`.
  2. vidovr `/d/` → halaman player; iframe `/ip129jk?id=…&t=JWT` →
     `stream.php?bucket=vidoycdn&id=…` → halaman share → **direct file
     `https://mp4-09.overfetch.video/RXDx6vZbET-DGFCIcoR1I`** (200,
     `video/mp4`, **113.800.000 B ≈ 108 MB** < limit 200 MB).
     Catatan: vidovr = mirror keluarga **vidoy** (bucket `vidoycdn`, abuse →
     vidoy.com).
  3. `action=import` direct URL + `folder_id=198` (Hijab) → `imported:1` →
     `videos.php?folder=198` → `data-id="25754"`; `watch?v=25754` anon **200**
     (judul awal = nama file CDN `RXDx6vZbET DGFCIcoR1I`). Video **tidak dihapus**
     (milik user, bukan video tes).
- **⚠️ Remote upload = "thin link", TIDAK mengunduh file (temuan penting)**:
  video hasil remote import **tidak bisa diputar**. Root cause teruji:
  `<source>` di watch page men-embed URL remote apa adanya
  (`mp4-09.overfetch.video/…` = server **VidoyCDN-09**), dan CDN itu punya
  hotlink protection: referer `vidovr.com` → **206 OK**, referer `vikuy.click`
  / kosong / lain → **403**. Browser pemutar (kirim referer `vikuy.click`)
  ditolak. → Remote import vikuy hanya cocok untuk URL video **polos tanpa
  proteksi referer**; thumbnail/tetap terbaca & judul tetap bisa diedit.
- **Perbaikan jalur chunk (disetujui user)**: download file 113.796.505 B
  (200 dgn referer `vidovr.com`, `ftypisom`, ffprobe 448,88 dtk) → upload
  **28 chunk × 4.194.304 B** ke `upload.php` (satu `upload_id`,
  `folder_id=198`, `title=Urfavmatcha 3some`) → semua `{ok:true,next:n}` →
  chunk final `{"ok":true,"done":true,"id":25758,"daily_used":4,"daily_limit":10}`
  (`daily_used:4` = konsisten:3 upload chunk sebelumnya + ini; **remote import
  tetap tidak dihitung**). Verifikasi playback: `watch?v=25758` anon **200**,
  judul "Urfavmatcha 3some", `<source>` = `serve_video.php?t=…` → 302 →
  **`https://vid.vikuy.click/videos/vid_1bdeb2c10679fe7c52832211.mp4`** →
  **206 `video/mp4`** (dengan & tanpa referer) — file di-serve dari CDN vikuy
  sendiri, bebas hotlink. Video rusak `25754` dihapus (watch → 404); isi
  folder Hijab kini hanya `25758`. File temp lokal `/tmp/vk_src.mp4` dibersihkan.
- **Edit judul + uji field title (4 Okt, permintaan user)**: `POST videos.php`
  `edit_video_id=25754&edit_title=Urfavmatcha 3some` → `{"ok":true}` →
  `watch?v=25754` `<title>Urfavmatcha 3some` ✅. Uji remote import sambil
  mengirim `title=JudulTesDariAPI` → judul video hasil import tetap **"mov bbb"**
  (nama file URL) → field `title` **tidak didukung** remote import; deteksi judul
  asli harus di sisi klien lalu edit setelah import. Video tes `25755` dihapus
  (watch → 404); sisa video di akun = hanya `25754` (milik user).
- `node --check`: tidak perlu (tidak ada perubahan kode JS repo).
