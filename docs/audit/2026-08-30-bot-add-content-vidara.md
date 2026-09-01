# Audit — Menu "Tambah Konten" → Vidara (2026-08-30)

## Tujuan
Menambah kemampuan di bot (admin-only): pilih URL dramafren/reelfren → scrape daftar episode → upload video langsung ke Vidara via URL asli (endpoint `upload/url`), rapi dalam folder per provider+judul, lalu tulis filecode ke `downloads/track.json` sehingga web (hokidrama/DramaShort) bisa menampilkan embed `https://<domain>/e/<filecode>`.

## Perilaku baru
1. Menu utama (admin) ada tombol `📤 Tambah Konten → Vidara` (`act:add_content`).
2. Bot set mode `aimVidara` (Map per chat), kirim instruksi + tombol `❌ Batal`.
3. User paste URL dramafren atau reelfren → interceptor di message handler mem-route ke `handleAddContentVidara` (mode di-clear setelah dipakai).
4. Alur: cek `VIDARA_API` → scrape episode (`getAllEpisodes` / `getAllEpisodesReelFren`) → `services/vidaraService.uploadToVidara`:
   - folder Vidara dibuat nama `Provider — Judul` (Vidara folder flat, tidak nested; prefiks provider agar se-provider mengumpul),
   - per episode: `uploadUrlToVidara` (Vidara narik dari URL video asli) → rename `Judul — Ep NN` → `moveToFolder` → poll encoding hingga active,
   - resume-friendly: episode yang sudah ada di `track.vidara` di-skip,
   - progress live (Progress + message chunk per 12 episode),
   - tulis global `downloads/track.json[dramaKey]` (`title`, `hasVidara`, `uploaded`) + per-drama `downloads/<provider>/<safeTitle>/track.json` (`vidara[ep]=filecode`).
5. Summary akhir: jumlah ok/skip/gagal, folder Vidara, link embed.
6. Konkurensi: `vidaraBusy` per chatId mencegah double-run; proses berjalan dgn sekali eksekusi per chat.

## Perubahan file
| File | Perubahan |
|------|-----------|
| `scraper/vidara-uploader.js` | Guard `require.main` → jadi requireable; tambah export helper (readEnv, vidaraCall, folder/upload/rename/move/poll, track I/O, sanitizeDir, DOWNLOADS dll); nama folder baru `Provider — Judul` via `vidaraFolderName`. CLI workflow tetap sama. |
| `scraper/services/vidaraService.js` (BARU) | `uploadToVidara(opts)` — orkestrasi folder + upload + rename + move + poll + skip dupe + tulis track (global & per-drama). |
| `scraper/bot.js` | Button `act:add_content` (+ cancel), Map `aimVidara` & `vidaraBusy`, interceptor di message handler, `handleAddContentVidara` (parse drama/reelfren, serahkan ke service, progress, summary). |

## Detail teknis
- Upload method: URL asli (Vidara menarik dari CDN dramafren/reelfren) — tidak menyimpan file lokal.
- `VIDARA_API` dibaca via `readEnv` (Replit secrets `/run/replit/env/latest`, `.env`, atau `process.env`). Kalau kosong → pesan panduan menambah secret.
- Folder Vidara **flat** (dari API doc: "Folders are flat — there is no nesting"), karena itu pemisahan rapi lewat pola nama `Provider — Judul`.
- Embed link memakai `VIDARA_DOMAIN` (default `vidara.so`), endpoint tetap `api.vidara.so/v1/...`.

## Verifikasi
- `node --check` bot.js, vidara-uploader.js, vidaraService.js, reelfren.js → OK.
- `vidara-service-test.js` → `VIDARA SERVICE OK (folder provider-first, urutan, resume, track)`:
  - 3 ep upload sequential, folder `reelshort — Cinta Di Tepi Danau Lengkap`, rename `… — Ep NN`, move 3×,
  - global track key `reelshort:12345` (hasVidara, uploaded [01,02,03]),
  - run ke-2 resume → skip 3, tanpa upload baru.
- uploader requireable tanpa side-effect main (CLI tetap jalan sebagai workflow).
- Regression: VIP STACK, VIP MENU (harga baru), SAWERIA SMOKE → semua hijau.

## Tindak lanjut
- User menambahkan `VIDARA_API` (dan opsional `VIDARA_API_BASE`/`VIDARA_DOMAIN`) ke Replit Secrets → restart bot → tes 1 drama dramafren & 1 reelfren.
- Setelah berhasil, episode muncul di web via `data.js getVidaraEpisodes` (embed `/e/<filecode>`).

## Referensi VDL + keputusan lanjutan (2026-08-30)
- Repo referensi `VDL/` di-ignore dari git (`VDL/` di `.gitignore`), bukan bagian workspace repo.
- Temuan VDL (`src/services/VidaraUploader.js`): upload pakai `upload/server` → multipart file via `curl` (Node http hang di upload server, komentar `UPL-VIDARA-001`); progress dibaca dari stderr curl; tanpa polling encoding (sinkron, filecode langsung balik). "Ganti link" = rotasi domain: simpan filecode di DB, link publish di-rebuild dari domain aktif (`bot_config.vidara_domains` + `vidara_active_domain`, menu `/editlink`). Env: `VIDARA_API_KEY`, `VIDARA_API_BASE`, `VIDARA_PUBLIC_BASE` (default `vidara.to/e`).
- KEPUTUSAN TERBUKA: metode upload. Implementasi saat ini `upload/url` (tanpa download) — BELUM diuji live (menunggu API key). Rencana: saat tes, siapkan rute cadangan `curl multipart` ala VDL dan pilih yang terbukti jalan.
- **DB landing untuk rotasi domain** (fondasi, UI `/editlink` ditunda):
  - Tabel baru `vidara_uploads (drama_key, ep, title, filecode, domain, uploaded_at)` PK `(drama_key, ep)`.
  - Helper `db.js`: `saveVidaraUpload`, `getVidaraUpload`, `listVidaraUploads`, `getVidaraDomains`/`setVidaraDomains` (`bot_settings.vidara_domains` JSON), `getVidaraActiveDomain`/`setVidaraActiveDomain`, `buildVidaraBase(domain)`.
  - `handleAddContentVidara` sekarang menyimpan tiap `(dramaKey, ep) -> filecode+domain` setelah upload sukses, sehingga fitur "ganti link" nanti cukup ganti kolom `domain`.
- Verifikasi tambahan: `node --check` bot.js & db.js OK (helper DB tidak ikut di harness offline karena butuh `DATABASE_URL`).

## MENINGKAT: Batch 10-episode + upload curl-multipart (2026-08-30)
- Masalah: mode `upload/url` per-episode lambat (8 episode dalam ~15 mnt, polling encoding + fetcher dingin) — tidak skala untuk 84 episode.
- API key Vidara nyata diverifikasi (`/user/info`: akun `boomber`, 2976 video, unlimited storage). Metode curl-multipart diuji live: `GET /upload/server` → `curl -F api_key -F file=@` → `{filecode, video_id}`; file uji di-hapus via `/video/delete`. TERBUKTI.
- Redesign (per arahan user: "mergｅ 10 episode sama, pakai metode kaya VDL"):
  - `vidara-uploader.js`: tambah `getUploadServer()`, `uploadFileViaCurl(filePath,onProgress)` (execFile curl, `-F api_key`, `-F file=@"path"` — aman shell-injection, timeout `VIDARA_UPLOAD_TIMEOUT_MS` default 600s, parse filecode dari full URL), `extractFilecode(raw)`. `setDownloadsDir(dir)` + `DOWNLOADS`/`GLOBAL_TRACK` jadi live getter agar path track bisa dialihkan (untuk tes offline). Env juga terima alias `VIDARA_API_KEY`.
  - `vidaraService.js`: fungsi baru `uploadDramaBatchesVidara(opts)` — bagi episode jadi batch ≤10; per batch: download video tiap ep (parallel 3) → `ffmpeg -f concat -safe 0 -c copy` gabung jadi `Title — Ep NN-NN.mp4` → `uploadFileViaCurl` → rename + move folder → simpan `track.vidaraBatches[range]` + `track.vidara[ep]` per-ep (share filecode) → bersihkan workdir. Resume: batch dengan `vidaraBatches[range]` di-skip. `uploadToVidara` (per-ep) dipertahankan utk kompatibilitas/CLI.
  - `bot.js`: `handleAddContentVidara` kini pakai `uploadDramaBatchesVidara` (batchSize 10, workers 3), progress per-batch (download/concat/upload/ok/skip/fail), summary link per range, simpan ke DB per-ep (semua ep dlm range → filecode batch) via `setVidaraUpload`.
- Verifikasi: `VIDARA BATCH TEST OK` offline (stub API Vidara, ffmpeg concat nyata + download via http lokal): 22 ep → 3 batch (01-10, 11-20, 21-22), semua ep share filecode batch, resume skip tanpa re-upload, workdir bersih, track + global terisi. `node --check` semua file OK.
- TINDAK LANJUT DEPLOY: bot perlu restart (tombol Run di Replit) agar memuat kode batch. Setelah itu user paste URL sama → batch 01-10..81-84 (±9 file merged). 8 file eps-1-8 dari run per-ep lama masih tersisa di account Vidara (yatim); berpotensi dibersihkan via `/video/delete` bila disetujui.