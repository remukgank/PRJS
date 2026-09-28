# Fix: unduhan lambat → retry koneksi baru, dan "file sudah ada" berarti layak upload

**Tanggal**: 28 Sep 2026
**Status**: kode selesai + terverifikasi (test + probe produksi) + **sudah di-deploy** (bot start 17:01:29 UTC, pid 18161)

## 1. Insiden

Batch One Piece (target `vyt` = Vidoy + Telegram) dibiarkan user 28 Sep 2026
15:55–16:13. Enam episode hilang, dua sebab yang berbeda:

| ep | gejala | hilang dari |
|----|--------|-------------|
| 725, 727, 729, 730, 731 | speed floor → `NoResumeError` | Vidoy + Telegram + library |
| 733 | file parsial 0,8 MB lolos "skip download" → ditolak Vidoy | Vidoy + Telegram + library |
| 734 | upload Vidoy sukses, bot dihentikan sebelum kirim Telegram | Telegram + library |

Pola unduhan gagal (dari `logs/app.log`):

```
14:48:54  ep=713  mulai download  host=www.kamenime.com
14:49:04  ep=713  download progres  mb=0.3  kbps=28
   …      kbps turun ke 9–52 sepanjang 90 dtk
14:50:24  WARN ensureMp4 gagal — rata-rata 50.8 KiB/s di bawah ambang 70 KiB/s
14:50:41  WARN ensureMp4 berhenti — retry tidak menolong
14:50:41  ERROR Anime episode upload gagal
```

## 2. Akar masalah

### 2.1 "Ganti server" adalah diagnosis yang salah — dan stop-on-slow membuang episode

Speed floor killing unduhan itu benar sebagai **gejala**, tapi kode memperlakukannya
sebagai kondisi permanen: `ensureMp4` (vidaraService.js:472-480) memakai
`if (err.noRetry) break`, sehingga episode yang sebenarnya bisa didapat dalam 2 detik
langsung ditandai gagal permanen.

Bukti bahwa yang lambat adalah **koneksi TCP**, bukan file/server
(11 probe langsung ke `https://www.kamenime.com/storage/anime/One%20Piece/One%20Piece-episode-727.mp4`,
file yang sama, 28 Sep 2026 16:29–16:41):

```
ep736 polos      → 138 / 101 KiB/s  (2×)  ← nge-drip
ep736 polos      → 6.693 / 6.201 KiB/s     ← normal
ep727 polos      → 7.929 / 197.234 / 76 / 9.008 / 5.248 / 7.573 KiB/s
ep727 cachebust  → 5.278 / 5.395 / 5.197 / 13 / 5.214 / 6.012 KiB/s
```

7 dari 11 tembus 4–220 MB/s, 4 sisanya 34–85 KiB/s, tanpa pola per-file. Cachebust
query param tidak memperbaiki atau memperburuk secara konsisten.

Dua variabel yang diuji terpisah:

| variabel | hasil | kesimpulan |
|----------|-------|-----------|
| `?cb=<timestamp>` (cachebust) | tidak konsisten (4 dari 8 gagal) | bukan cache HIT/MISS |
| **agent baru per request** (`keepAlive:false`) | 3 dari 4 tembus >100 MB/s | **socket yang dipakai ulang ikut culpable** |

Node ≥19 mengaktifkan `keepAlive: true` pada `https.globalAgent` secara default,
jadi `downloadTo` (yang tidak menunjuk agent) memakai kembali socket yang sama
sepanjang runtime bot. Socket itulah yang "membeku".

Bukti pengonfirmasi — unduh ulang **episode yang tadi gagal**, host sama, tanpa
perubahan kode:

```
ep725 → SUKSES 189,1 MB dalam 2,0 s (98.789 KiB/s)
ep731 → SUKSES 211,6 MB dalam 38,7 s (5.601 KiB/s)
ep727 → GAGAL (deterministik di percobaan ini)
```

Kamenime memang tidak punya mirror lain — yang perlu adalah koneksi baru.

### 2.2 `fs.existsSync` ≠ file yang bisa dipakai (insiden Ep 733)

`handlers/vidoy.js:246` memakai `fs.existsSync(destPath)` sebagai kriteria "file sudah
ada". Proses yang di-SIGTERM di tengah unduhan menyisakan parsial 0,8 MB di
`downloads/anime/One_Piece/ep733/`. Setelah restart:

```
15:55:39  ep=733  mulai download
15:56:02  proses mati (SIGTERM) — parsial 0,8 MB tertinggal
16:12:16  ep=733  skip download — file sudah ada  (mb=0,8)
16:12:22  ERROR Vidoy CDN status invalid/HTTP 200: Warning: hash_file(thumbnail/…): No such file or directory
```

`existsSync` hanya membuktikan **ada file**, bukan **file utuh**. Pesan galat dari
Vidoy (`hash_file(thumbnail/…)`) sama sekali tidak menunjuk penyebabnya.

## 3. Perubahan

### 3.1 `scraper/services/vidaraService.js` — koneksi baru + retry saat lambat

| lokasi | perubahan |
|--------|-----------|
| `downloadTo` (`:70-79`) | `new Agent({ keepAlive: false })` per request, dipakai lewat `lib.get(url, { headers, agent: reqAgent })`; `fail()` dan `ok()` memanggil `reqAgent.destroy()` supaya tidak ada socket menggantung |
| speed floor (`:139-149`) | galat ditandai `{ noRetry: true, slow: true }`; pesan diubah dari "ganti server, mengulang tidak menolong" → "koneksi ini lambat, coba koneksi baru (X MB terkumpul)" |
| `ensureMp4` (`:472-490`) | `if (err.noRetry && !err.slow) break` — `noRetry` tanpa `slow` (NoResumeError, MAX_RUN_MS) tetap berhenti; `slow` **hapus parsial** lalu lanjut retry |
| `ensureMp4` (`:451-456`) | `opts.thresholds` diteruskan ke `downloadTo` (lihat §5 — bug yang ditemukan lewat test) |

Menghapus parsial sebelum retry itu wajib, bukan kosmetik: tanpa itu `downloadTo`
mengirim `Range` dan host yang mendukung resume menyambungkan unduhan baru ke data
lama → file campur yang **tetap lolos** `assertLooksLikeVideo` (signature `ftyp`
masih ada di depan). Test (f3) mengunci ini.

### 3.2 `scraper/handlers/vidoy.js` — "sudah ada" berarti layak

Fungsi baru `isReusableVideo(destPath)` (`:33-70`), diekspor untuk test:

1. `statSync` gagal → `{ ok:false, why:'tidak ada' }`
2. `< 5 MB` → `{ ok:false, why:'parsial X MB' }`
3. `assertLooksLikeVideo` melempar (HTML/JSON/gambar) → `{ ok:false, why:<pesan> }`
4. `detectVideoContainer() === 'unknown'` → `{ ok:false, why:'signature bukan video' }`
5. selain itu `{ ok:true, why:'X MB' }`

`actionAnimeEpisode` (`:287-299`) memakai hasilnya; kalau tidak layak, file dihapus
lalu diunduh ulang dari nol, dengan log `file ada tapi tidak layak pakai — unduh
ulang dari nol` beserta alasannya.

Ambang 5 MB dipilih dari data, bukan tebakan: episode terkecil di `media_parts`
adalah 51,2 MB (One Piece), persentil-1 seluruh library 61,9 MB. Jadi 5 MB tidak
pernah menunda file yang sah. Signature tetap lebih otoritatif daripada ukuran
(AGENTS.md §4) — kontainer `mp4`/`mkv`/`ts` sah tidak ditolak hanya karena kecil,
kecuali lewat ambang eksplisit di atas yang jauh di bawah data nyata.

## 4. Verifikasi

### 4.1 Test suite

`test-downloadto-speed-floor.js` — **13 pass / 0 fail** (dari 9; +3 test baru, 1 diperketat):

| test | yang dikunci |
|------|-------------|
| a) speed floor | pesan menyebut "koneksi baru", bukan "ganti server" |
| a2) `noRetry` + `slow` | keduanya harus true |
| f) NoResumeError | **tetap** 1 percobaan (tidak berubah oleh fix ini) |
| f2) retry saat lambat | 2 percobaan, SUKSES, dan alasan gagalnya **harus** `terlalu lambat` |
| f3) parsial dibuang | retry tidak mengirim `Range`; ukuran hasil = ukuran payload server |

f2 sengaja dibuat ketat: versi pertama "lulus" karena `isIosCompatible()` melempar
`Parse Error` pada file terpotong — bukan karena speed floor. Sekarang test memeriksa
isi log `ensureMp4 koneksi lambat` dan mengesampingkan alasan lain.

Test baru `isReusableVideo` di `test-vidoy-uploader.js` — **7 pass**: MP4 penuh
layak; parsial 0,8 MB ditolak; 0 byte ditolak; HTML 6 MB ditolak; file absen
dibedakan dari parsial; MKV 6 MB layak (signature, bukan ekstensi); ambang 5 MB
di bawah data nyata.

Suite penuh: **48 file dijalankan, 0 gagal** (4 file dikecualikan karena alasan
pre-existing: `test-all-subdomains` butuh jaringan dramafren, `test-rich*` butuh env
token, `test-watchdog-aria2c` >300 dtk).

### 4.2 Probe produksi (path yang sama dengan bot)

`ensureMp4` dengan `resolveFresh`, ke episode yang **tadi gagal**:

```
HASIL ep727: SUKSES 211,6 MB dalam 7,5 s  (28.877 KiB/s)
HASIL ep933: SUKSES 298,0 MB dalam 3,8 s  (79.661 KiB/s)
HASIL ep725: SUKSES 189,8 MB dalam 4,8 s  (40.628 KiB/s)
HASIL ep731: SUKSES 212,3 MB dalam 5,6 s  (39.070 KiB/s)
```

Keempatnya lolos `assertLooksLikeVideo`, kontainer `mp4` setelah remux dari `mkv`.

### 4.3 Deploy

Bot **tidak** dikelola pm2 (pm2 list kosong); dijalankan dari Replit workflow
(ppid 28). Restart dilakukan: env diambil dari `/proc/<pid>/environ` (NUL-separated,
karena `source` merusak nilai ber-spasi seperti `CMAKE_LIBRARY_PATH`), lalu SIGTERM
→ start ulang. Replit workflow ikut spawn instance kedua (ppid 1) sehingga sempat
`409 Conflict` 6×; instance manual dimatikan. Keadaan akhir:

```
pid 18161  ppid 28  uptime 15s
17:01:29  Bot running
17:01:29  Polling started, waiting for messages...
17:01:29  Database tables initialized
409 Conflict setelah 17:01:45 → 0
```

Kode aktif = source di disk (mtime `vidaraService.js` 16:53:04, `vidoy.js` 16:53:39;
bot start 17:01:29).

## 5. Bug yang ditemukan SEMENTARA menulis test (bukanscope proposal)

`ensureMp4` tidak meneruskan `opts.thresholds` ke `downloadTo` (`vidaraService.js:451`).
Dampaknya ada dua:

1. Test `ensureMp4` dengan ambang kecil mustahil dibuat — window produksi 90 dtk
   berarti setiap test ≥ 2 menit.
2. Yang menyalakan di test adalah `STALL_MS` produksi 20 dtk, bukan speed floor —
   test jadi lulus untuk alasan yang salah, persis kelas kegagalan yang AGENTS.md
  Peringatkan.

Diperbaiki dengan pass-through bersyarat (`...(opts.thresholds ? { thresholds } : {})`).
Produksi tidak mengirim `thresholds` (undefined), jadi perilaku produksi tidak berubah.
Setelah diperbaiki, log test menunjukkan speed floor yang benar-benar menyalakan:
`server terlalu lambat — rata-rata 36.0 KiB/s di bawah ambang 70 KiB/s selama 1 dtk`.

## 6. Catatan & follow-up (di luar scope, belum dikerjakan)

- **Ep 734 masih di disk tapi tak terpakai**: `downloads/anime/One_Piece/ep734/`
  (185,0 MB, kontainer `mp4`, sudah diselamatkan ke
  `.hermes/cache/scratch/ep734-salvage/`). Punya link Vidoy, tidak punya
  `tg_message_id` dan tidak ada di `media_parts`. `finally` di `vidoy.js:370`
  membersihkan `outDir` tiap episode, jadi file tidak akan terpakai otomatis.
  Butuh dikirim manual sekali. User memilih biarkan.
- **`isReusableVideo` hanya dipakai di `actionAnimeEpisode`.** Jalur drama
  (`uploadBatches` → `downloadChunk`) tidak punya gate "sudah ada" yang sama, jadi
  tidak terkena insiden Ep 733. Kalau nanti masuk gate serupa di sana, pakai fungsi
  yang sama.
- **`MAX_RUN_MS` masih pesan "ganti server"** (`vidaraService.js:127`) dan tidak
  ditandai `slow`. Episode yang lewat 25 menit juga sebenarnya bisa sukses dengan
  koneksi baru (ep727 butuh 7,5 s di percobaan kedua). Tidak diubah — batas waktu
  mutlak punya makna berbeda dari speed floor, dan mengubahnya butuh data panjang.
- **Kecepatan baseline turun?** Semua episode sukses pada log sebelum fix berada di
  7.355–10.415 KiB/s dengan `globalAgent` keep-alive. Setelah diubah ke `keepAlive: false`,
  tiap file membuka koneksi baru (TLS handshake ~100 ms). Untuk file 185 MB itu
  tidak terukur secara signifikan, tapi belum diukur panjang — belum ada data
  kecocokan bandwidth setelah deploy.
