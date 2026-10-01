# Vidara sebagai host cadangan sementara (dual-host Vidoy + Vidara)

Tanggal: 2026-10-01
Status: **disetujui user** (4 keputusan di §3)

## 1. Root cause

Kuota storage Vidoy habis di **hari pertama** window bulanan:

```
08:59:39 ERROR Vidoy register gagal: {"status":413,"code":"quota_exceeded",
  "quota":{"views":0,"used":5332339036,"limit":5368709120,"limit_label":"5 GB",
  "remaining":36370084,"exceeded":false,"percent":99.3,
  "next_tier":{"views_needed":100,"label":"10 GB"},"reset_at":"2026-11-01"}}
```

`views: 0` → window baru (mulai 1 Okt), `reset_at 2026-11-01` → **baru bisa
dipakai lagi sebulan lagi**, bukan besok. Sisa 36 MB tidak cukup untuk satu
episode (Super Dragon Ball Heroes Ep 3 = 63 MB). Registrasi akun baru **404**,
remote upload `POST /remote/upload` **500 kosong** — tidak ada jalan menambah
kapasitas di Vidoy.

Dampak: batch apa pun ke target `vyt`/`vv` berhenti di episode pertama, dan
backfill 833 episode One Piece tidak mungkin jalan.

## 2. Bukti bahwa Vidara layak (diuji live 1 Okt 2026, bukan asumsi)

| uji | hasil |
|---|---|
| `GET /v1/upload/server` | ✅ `upl1.s1q2105.com/api/upload` |
| upload lokal 2 KB (`curl -F api_key -F file`) | ✅ `{"filecode":"https://vidara.to/e/0ijmPKLZqPCMr"}` |
| `GET /v1/video/info?filecode=` | ✅ `status: active`, `file_active: 1`, `link: https://vidara.to/<code>` |
| halaman `https://vidara.to/<code>` dan `https://vidara.so/e/<code>` | ✅ keduanya 200 + `<title>` = judul file |
| `POST /v1/video/delete` | ✅ `{"deleted":true}` (kedua file tes dihapus) |
| `GET /v1/upload/url` (remote) | ❌ 200 + filecode tapi `status: error` |
| `GET /v1/video/download` | ❌ 404 — file **tidak bisa diambil balik** |
| endpoint kuota (`/quota`, `/account`, `/stats`, …) | ❌ semua 404 |

Artinya: **manfaat Vidara = pool storage terpisah, bukan hemat bandwidth.**
Bot tetap harus download dulu (`/upload/url` tidak bisa dipakai).

## 3. Keputusan yang disetujui user

1. **Fallback otomatis** — target Vidoy kena `quota_exceeded` → langsung coba
   Vidara, tetap kirim Telegram.
2. **Target baru** di picker: `🗜 Vidara + TG` (`vt`) dan `🗜 Vidara` (`v`),
   sejajar dengan `vyt`/`vv`.
3. **Label status picker**: `🗜 N Vidara saja`, tidak memblokir (pola sama
   dengan `📨 N Telegram saja`).
4. **Auto-hapus di Vidara** setelah upload Vidoy sukses → supaya benar-benar
   "backup sementara" dan kuota Vidara tidak penuh.

Plus aturan dedupe yang diminta user:

| Record Vidoy | Record Vidara | Aksi |
|---|---|---|
| ada | ada / tidak | **skip total** (jangan upload ke host mana pun) |
| tidak | ada | **boleh** download + upload ke Vidoy (Vidara tidak menghalangi) |
| tidak | tidak | upload ke host tujuan |

Peran host: **Vidoy = kanonik** (penyimpanan tetap). **Vidara = cadangan
sementara** (isilah selagi Vidoy penuh, lalu dihapus setelah masuk Vidoy).

## 4. Rencana implementasi

### 4.1 `scraper/db.js`
- `deleteVidaraUpload(key, ep)` — hapus baris record (dipakai setelah file dihapus).
- Tidak ada migrasi: `vidara_uploads` masih 0 baris, jadi format `drama_key`
  untuk anime bebas diubah ke judul ber-suffix musim (`vidoyTitle`).

### 4.2 `scraper/vidara-uploader.js`
- `extractFilecode` kini hanya mengembalikan kode. Tambahkan
  `extractUploadRef(raw)` → `{ code, url, host }` supaya **host diambil dari
  respons API**, bukan dipatok `vidara.so` (pelanggaran aturan domain §AGENTS).
- `deleteVideo(filecode)` → `GET /v1/video/delete?api_key=&filecode=`.

### 4.3 `scraper/handlers/vidoy.js` (`actionAnimeEpisode`)
- `needVidara = target === 'vt' || target === 'v'`;
  `needTg = target === 'tg' || target === 'vyt' || target === 'vt'`.
- **Pre-check sebelum download** (hanya untuk target Vidara): record Vidoy ada
  → skip total; record Vidara ada → skip upload (pakai link yang tersimpan).
  Key = `vidoyTitle` (ber-suffix musim) supaya S1 ≠ S3.
- Branch Vidara memakai key `vidoyTitle` (perbaiki pemakaian `title` polos yang
  sekarang bisa menabrak antar musim).
- **Fallback**: `vidoyService.uploadSingle` gagal dengan `quota_exceeded` →
  upload ke Vidara, catat `out.vidaraFallback = true`, tetap kirim TG.
- **Auto-hapus**: setelah Vidoy sukses, kalau ada record Vidara untuk ep itu →
  `deleteVideo()` + `deleteVidaraUpload()`. Kegagalan hapus = warning, tidak
  menggagalkan episode.
- Caption: `link` = `out.vidoy.link` (kalau ada) sonst link Vidara dari host
  respons API → tetap 4 baris sesuai kontrak §5.

### 4.4 `scraper/lib/episode-status.js` + picker
- `episodeStatusMap` menambahkan flag `vidara: true` dari
  `listVidaraUploads(vidoyTitle)` — **tidak** masuk penghitung "sudah ada"
  (status Telegram tetap butuh pointer `tg_message_id`).
- `statusBreakdown` menambah `🗜 N Vidara saja`; `episodeButton` tidak
  berubah (tombol tidak boleh menipu: episode ber-Vidara tetap merah/perlu).

### 4.5 `scraper/bot.js`
- `animeTargetKeyboard(tg, vyt, vv, vt, v)` + tombol baru; `vidaraOk` dari
  `VIDARA_KEY`.
- Semua call site (kamenime/samehadaku/kuronime/dl_go, single & batch).
- Daftar validasi target `['tg','vyt','vv']` → tambah `'vt','v'`.
- `targetLabel`/`batchTargetLabel`: `vt` → "Vidara + Telegram", `v` → "Vidara".
- Fail-fast tetap berlaku: kalau **Vidara juga** kena kuota, error naik ke loop
  batch → `isQuotaExceededError` menghentikan batch (perlindungan bandwidth).

## 5. File yang disentuh

- `scraper/db.js`
- `scraper/vidara-uploader.js`
- `scraper/handlers/vidoy.js`
- `scraper/lib/episode-status.js`
- `scraper/bot.js`
- `scraper/tests/test-vidara-anime.js` (baru)

## 6. Yang TIDAKDoing

- Tidak mengubah kontrak caption 4 baris / `supports_streaming` / topic Anime.
- Tidak mengubah format `callback_data` yang sudah dipakai (token target baru
  hanya tambahan).
- Tidak menyentuh `fomo-drama/` atau `cs-hokireceh/`.
- Tidak pakai Vidara untuk backfill 833 episode One Piece: karena tidak ada
  `/video/download`, file harus diunduh **dua kali** (sekarang untuk Vidara,
  lagi bulan depan untuk Vidoy). Untuk itu: Telegram dulu, Vidoy setelah reset.

## 7. Verifikasi wajib

- `node --check` untuk setiap file `.js` yang berubah.
- Test baru `test-vidara-anime.js`: dedupe (Vidoy menang / Vidara tidak
  menghalangi), target wiring, caption 4 baris + link dari host API,
  auto-hapus, fallback.
- Jalankan test suite penuh; 3 test merah milik user (`test-kamenime-batch.js`
  5/6/11) tetap merah — bukan regresi.
- **Uji nyata**: upload 1 episode sungguhan ke Vidara (Super Dragon Ball
  Heroes Ep 3) dan laporkan angka nyata (filecode, link, status encoding),
  bukan klaim.
- Restart lewat Workflows oleh user (agen tidak me-restart).