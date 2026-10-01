# 2026-10-01 — Vidara sebagai host kedua (dual-host Vidoy + Vidara)

Proposal: `docs/proposals/2026-10-01-vidara-vidoy-dual-host.md` (disetujui user,
4 keputusan di §3)

## Masalah

Kuota storage Vidoy habis di hari pertama window bulanan (413
`quota_exceeded`, `reset_at 2026-11-01`, sisa 36 MB < 1 episode). Registrasi
akun baru 404, remote upload 500 → tidak ada cara menambah kapasitas. Semua
batch ke `vyt`/`vv` berhenti di episode pertama, backfill 833 episode One
Piece mustahil.

## Perbaikan (6 file inti + test baru)

| file | perubahan |
|---|---|
| `scraper/lib/quota.js` (baru) | `isQuotaExceededError` + `quotaResetDate` jadi satu sumber kebenaran. `bot.js` **dan** `handlers/vidoy.js` kini mengimpor dari sini — dua salinan regex akan menyimpang diam-diam. |
| `scraper/handlers/vidoy.js` | `needVidara = target === 'vt' \|\| target === 'v'`; `needTg` + `vt`. Pre-check **sebelum** download (record Vidoy ada → skip total; record Vidara ada → skip upload, pakai link tersimpan). Key record = `vidoyTitle` (ber-suffix musim) agar S1 ≠ S3. Fallback `uploadSingle` gagal `quota_exceeded` → Vidara, `out.vidaraFallback = true`, tetap kirim TG. Auto-hapus record Vidara setelah Vidoy sukses (server dulu, baru DB). |
| `scraper/vidara-uploader.js` | `extractUploadRef(raw)` → `{code, url, host}` — **host diambil dari respons API**, tidak dipatok `vidara.so` (aturan domain §AGENTS). `deleteVideo(filecode)` → `GET /v1/video/delete`. |
| `scraper/db.js` | `deleteVidaraUpload(key, ep)`. Tidak ada migrasi (tabel masih 0 baris). |
| `scraper/lib/episode-status.js` | `episodeStatusMap` menandai `vidara: true` dari `vidara_uploads` **tanpa** menyentuh `tg`/`link`. `statusBreakdown` menambah `🗜 N Vidara saja` — tidak masuk hitungan "sudah ada" (Telegram tetap butuh `tg_message_id`). Tombol `episodeButton` tidak berubah: episode ber-Vidara tetap merah. |
| `scraper/bot.js` | `animeTargetKeyboard(tg, vyt, vv, vt, v)` + tombol baru, `vidaraOk` dari `VIDARA_KEY`; semua call site (kamenime/samehadaku/kuronime/dl_go, single & batch); daftar validasi target; `targetLabel`/`batchTargetLabel`; caption memakai link Vidoy, atau link Vidara sebagai pengganti (tetap 4 baris §5). |

## Test: `scraper/tests/test-vidara-anime.js` (baru, 25 pass / 0 fail)

Mencakup: wiring target vt/v, `needTg` tanpa `v`, keyboard mundur kompatibel,
pre-check sebelum download, dedupe (Vidara tidak memblokir target Vidoy),
caption 4 baris + label = domain asli URL, host dinamis, auto-hapus dengan
urutan server→DB, `vidaraLinkFromRecord`, `statusBreakdown`,
`episodeStatusMap`, deteksi kuota.

**Mutation test — 13 mutasi, semuanya gagal ditemukan test:**
`needVidara = false`, pre-check dipindah setelah download, fallback tanpa
cek kuota, auto-hapus urutan terbalik, key record pakai `title` polos, satu
call site kehilangan tombol `vt`, label `bot.js` menyimpang, regex kuota
dilemahkan (`/quota/i` dan `/limit reached/i`), `statusBreakdown` menghitung
Vidara sebagai terkirim, `episodeStatusMap` tidak menandai vidara,
`extractUploadRef` mematok domain.

### Bug regex yang ditemukan saat mutation test

`isQuotaExceededError` sempat memuat pola `limit reached`. Pola itu juga cocok
dengan `"Rate limit reached"` (429 sementara) → salah klasifikasi membuat bot
menyalin file ke host kedua karena error yang hilang dalam hitungan detik.
Dihapus; test `14b` kini mengunci 5 varian positif (tanpa kata "quota") dan 6
varian negatif termasuk `"Rate limit reached, retry in 30s"`.

## Test suite penuh (verifikasi 1 Okt 2026)

- **932 pass / 0 fail** di 41 suite yang mencetak ringkasan.
- 15 suite tersisa tidak memakai format `N pass, N fail`: sebagian besar
  menulis `Semua test OK` / `N/N passed` (lolos), `test-watchdog-aria2c.js`
  dijalankan ulang penuh → exit 0, semua PASS. `test-rich*.js` butuh
  `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`; `test-kuronime.js` skip tanpa
  `KURONIME_LIVE=1`; `test-all-subdomains.js` = live test ke 18 host eksternal
  (diinterupsi karena lama, bukan gagal).
- `node --check` semua file `.js` yang berubah → lolos.

### 14 fail awal ternyata test usang, bukan regresi kode

| suite | akar masalah |
|---|---|
| `test-batch-quota.js` (2) | masih meng-grab helper dari `bot.js` setelah dipindah ke `lib/quota.js`; loop potongannya juga masih membaca `src` (bukan `quotaSrc`). |
| `test-kamenime-batch.js` (4) | `vidBlock()` memakai `len = 9000` fixed. `actionAnimeEpisode` tumbuh jadi ~13 KB karena jalur Vidara → 4 tes gagal buta. Diganti memotong pada deklarasi fungsi berikutnya. |
| `test-kamenime-provider.js` (2) | anchor `// target = vyt atau vv` dihapus saat menambah kalimat fallback. Teks anchor dipulihkan. |
| `test-vidoy-uploader.js` (5) | mengunci kontrak **lama** "Vidara dihapus total" (`needVidara = false`, `vt tidak boleh ada`, 3 target). Disesuaikan ke 5 target. Satu di antaranya bug extractor asli: `batchTargetLabel` ada di dalam fungsi berindent sehingga `indexOf('\n}')` meleset dan menangkap kode lain → `require is not defined`. Diganti hitung kurung. |

Kontrak yang tetap dijaga setelah penyesuaian: pilihan target wajib muncul,
`dl_go` tidak boleh memfilter `vt`, semua target tervalidasi, caption 4 baris.

## Bukti jalannya fitur (dari log produksi, bukan klaim kode)

```
2026-10-01T17:18:32.310Z RichProgress done   done:129 fail:24
2026-10-01T17:18:32.857Z kam_all batch selesai  target:"vt" ok:129 fail:24 skip:0
```

Batch kamenime berjalan ke target `vt` (Vidara + TG) dengan 129 episode sukses.
Belum diverifikasi dari sesi ini: penghapusan record Vidara setelah Vidoy
sukses dan fallback kuota `413` sungguhan (butuh kuota Vidoy terisi penuh).

## Status deploy

Belum. `pm2 list` **kosong** — bot jalan sebagai proses lepas (pid 204, PPid
infrastruktur Replit), bukan di bawah pm2. Karena itu `pm2 restart prjs-bot`
tidak akan menyentuh apa pun, dan menambah instance baru saat instance lama
masih hidup = `409 Conflict` (§3). Perlu konfirmasi user untuk mematikan
proses lama dan menjalankan ulang lewat start standar.

## Catatan versi

Fitur baru tanpa kontrak yang patah (caption 4 baris, `supports_streaming`,
topic Anime, format `callback_data` lama tetap ada) → **minor**.
