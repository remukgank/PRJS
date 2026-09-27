# downloadTo: speed floor + fail-fast resume (retry sia-sia)

**Tanggal:** 27 Sep 2026
**File:** `scraper/services/vidaraService.js`, `scraper/lib/download-thresholds.js` (baru), `scraper/tests/test-downloadto-speed-floor.js` (baru)
**Status:** kode selesai + terverifikasi. **Belum di-deploy** (butuh restart pm2).

---

## 1. Insiden

Naruto Shippuuden ep 5, 26 Sep 2026 (`logs/app.log`). Server `download.yurae3jsy.autos`
(gdriveplayer, chunked, tanpa `Content-Length`):

| waktu | MB | kejadian |
|---|---|---|
| 23:46:55 | 43,7 | stall-kill → restart 0,9 MB (42,8 MB hilang) |
| 23:54:08 | 19,8 | stall-kill → restart 0,4 MB (19,4 MB hilang) |
| 23:56:02 | 2,5 | gagal total, duration 1103 s |

**65 MB terbuang, 0 byte hasil, 18 menit.**

## 2. Akar masalah (3, semuanya terverifikasi)

**1. Tidak ada speed floor.** Hanya stall 20 detik. Trailing 90 detik di 23:51–23:53
s ranged 19–34 KiB/s — jauh di bawah ambang 70 KiB/s — tapi tidak pernah dibatalkan.
Speed floor sudah ada, tapi hanya di jalur aria2c (`downloader.js`).

**2. Retry sia-sia.** `downloadTo` sudah pakai resume (`Range: bytes={have}-`), tapi
host chunked mengabaikannya → status 200 (bukan 206) → `have=0` → restart dari nol.
Karena stall-kill memicu retry, tiap retry membuang seluruh progres.

**3. Tiga jenis kematian, pesan tidak bisa dibedakan.** speed floor / stall / koneksi
batal semuanya muncul sebagai "gagal", jadi user tidak tahu harus ganti server atau
menunggu.

## 3. Perubahan

### 3.1 `scraper/lib/download-thresholds.js` (baru)
Sumber tunggal angka watchdog:

```js
SPEED_FLOOR_BPS:     70 * 1024
SPEED_WINDOW_MS:     90000
SPEED_MIN_RUN_MS:    90000
SPEED_MIN_BYTES:     5 * 1024 * 1024
STALL_MS:            20000
PROGRESS_MS:         10000
WATCHDOG_MS:         1000
```

`STALL_MS` **sengaja** tidak sama dengan aria2c (90 dtk) — stall berarti 0 byte, dan
menunggu 90 detik hanya memperpanjang waktu sia-sia. Angka `SPEED_*` di kunci test
agar sama dengan literal `downloader.js` (anti-drift, `downloader.js` tidak diubah).

### 3.2 Speed floor di `downloadTo`
Gate identik aria2c: evaluasi setelah ≥ `SPEED_MIN_RUN_MS` jalan **dan** ≥
`SPEED_MIN_BYTES` terkumpul, memakai rata-rata trailing `SPEED_WINDOW_MS`.

**Bug yang ketahuan saat menulis test (penting):** implementasi pertama memakai
anchor = sampel **pertama sesudah** `cutoff` plus syarat `spanMs >= SPEED_WINDOW_MS`.
Karena sampel terdekat selalu sedikit setelah cutoff, `spanMs` = 894 ms vs ambang
900 ms → **speed floor tidak akan pernah menyala, termasuk di produksi** (90 000 vs
89 900). Test (a) menangkapnya (16 detik, bukan 1 detik). Perbaikan: anchor = sampel
**terbaru yang sudah melewati** jendela (`t <= cutoff`), jadi rentang rata-rata
selalu ≥ window.

### 3.3 Fail-fast resume
`have > 0` tapi status bukan 206 (dan bukan 416) → `NoResumeError` (flag `noRetry`),
bukan diam-diam restart dari nol. `ensureMp4` menghormati `noRetry` → berhenti di
percobaan pertama.

### 3.4 Tiga pesan berbeda

| kondisi | pesan |
|---|---|
| host lambat | `server terlalu lambat — rata-rata X KiB/s di bawah ambang 70 KiB/s …` |
| macet | `download macet — 0 byte selama N dtk` |
| tanpa resume | `server tidak mendukung resume (HTTP 200 untuk Range) — mengulang akan mengulang dari nol, ganti server` |

## 4. Verifikasi

`test-downloadto-speed-floor.js` — **8 pass / 0 fail**. Semua pakai server HTTP
lokal sungguhan; `opts.thresholds` dipakai agar ambang produksi (90 dtk) bisa diuji
dalam hitungan detik, sedangkan angka produksinya dikunci terpisah oleh test
anti-drift.

| kasus | hasil |
|---|---|
| a) < ambang > window, > min bytes | kill `terlalu lambat` (1001 ms) |
| b) > ambang | tidak di-kill (tidak false-positive) |
| c) stall | tetap di-kill `macet` |
| d) Range diabaikan (200 ≠ 206) | `tidak mendukung resume` + `noRetry=true` |
| e) 416 | **KNOWN BUG** — lihat §5 |
| f) `ensureMp4` | **1 percobaan, bukan 4** |
| anti-drift `SPEED_*` vs `downloader.js` | 4/4 cocok |
| anti-drift tanpa angka magic | watchdog bebas literal |

Bukti mutasi (test harus gagal kalau perbaikannya dibatalkan):

| mutasi | hasil |
|---|---|
| anchor `find(>=cutoff)` + gate `spanMs>=window` (bug asli) | 7 pass / **1 fail** (a) |
| fail-fast resume dibatalkan | 6 pass / **1 fail** (d) |
| `noRetry` tidak dihormati | 7 pass / **1 fail** (f) |

`test-download-stall.js` diperbarui: kasus "server mengabaikan Range" sebelumnya
**meng-assert perilaku lama** (restart dari nol); sekarang meng-assert fail-fast +
file parsial tidak berubah.

Suite penuh: **217 pass / 0 fail** (4 file pre-existing dikecualikan: `test-rich*`
butuh env token, `test-all-subdomains` jaringan dramafren, `test-watchdog-aria2c`
>300 dtk).

## 5. Known bug ditemukan — belum diperbaiki (di luar scope proposal)

Cabang `if (have > 0 && res.statusCode === 416)` di `downloadTo` **tidak terjangkau**:
`if (res.statusCode >= 400)` menutup duluan. Jadi 416 ("file sudah lengkap") jatuh ke
`download HTTP 416` yang **retryable** — persis retry sia-sia yang item 2 intends
hilangkan. Sudah ada di HEAD sebelum perubahan ini, bukan regresi baru.

Test (e) mengunci perilaku saat ini + membuktikan cabang tidak terjangkau di sumber.
**Perbaikannya** = pindahkan cek 416 ke sebelum `>= 400`. Tidak dikerjakan karena
di luar 4 item proposal — menunggu keputusan.

## 6. Catatan

- Dampak: `tg` dan `vyt` sama-sama memakai `ensureMp4` → `downloadTo`, jadi keduanya
  mendapat speed floor + fail-fast yang sama. Yang dibedakan hanya upload Vidoy
  (`target === 'vyt'`), bukan kecepatan unduhan.
- Speed floor **tidak** ditandai `noRetry`: host lambat masih dicoba ulang dengan URL
  fresh (URL baru mungkin-host lebih baik). Hanya "tidak mendukung resume" yang
  berhenti total, karena di situ retry dijamin mengulang dari nol.
- Untuk Naruto Shippuuden ep 1–40 hanya ada `gdriveplayer` dan `reupload`; gofile
  tidak tersedia. Yang lambat adalah `gdriveplayer`.
- Download yang sedang berjalan **tidak** disentuh; tidak ada proses yang di-restart.
