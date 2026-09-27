# Tiga fix speed floor setelah E2E Re:Zero — dan bot mati karena salah cara restart

**Tanggal**: 2026-09-27
**Tag**: v3.3.1 (patch — tiga fix bug, tidak ada kontrak yang berubah)
**Sebelumnya**: v3.3.0

## Kejadian pemicu

E2E `kam_all:` pertama di v3.3.0 — Re:Zero kara Hajimeru Isekai Seikatsu,
25 episode, target `vyt`. Hasil akhir **23 sukses · 2 gagal**, sesuai rekap.

v3.3.0 sendiri bekerja: `media` 1 baris, `media_parts` 23 baris, `vidoy_uploads`
23 baris. Koreksi #3 (library tersimpan untuk `provider === 'hokireceh'`) terbukti
dari run nyata — episode yang hanya dikirim via Vidoy mengisi `media_parts`.

## Akar bug: speed floor membatalkan dirinya sendiri

`vidaraService.js:117` (sebelum fix):

```js
if (now - startedAt >= th.SPEED_MIN_RUN_MS && got - have >= th.SPEED_MIN_BYTES) {
```

dengan `SPEED_MIN_BYTES = 5 * 1024 * 1024` (5 MiB).

Dua dari dua episode yang gagal **tidak pernah bisa dievaluasi**:

| Episode | Window | Terkumpul | Laju | Hasil |
|---------|--------|-----------|------|-------|
| Ep 7 | 13:51:48 → 14:03:17 (11 menit) | 3,3 MB dari ~115 MB | 1-14 KiB/detik | gagal |
| Ep 16 | 14:07:31 → ~14:12 (~5 menit) |mulai 33 lalu 8 KiB/detik | gagal |

`3,3 MB < 5 MiB` → syarat kedua tidak pernah terpenuhi → blok floor tidak pernah
dievaluasi, **meski 90 detik sudah lewat**. Server makin lambat, ambang byte makin
tak tercapai — jadi justru kasus yang paling perlu ditangkap yang lolos.

Yang menyelamatkan hanya `STALL_MS` 20 detik, dan itu hanya menyala kalau byte
**benar-benar 0**. Pada Ep 7 byte merangkak selama 11 menit sebelum akhirnya
berhenti. Kalau server nge-drip terus tanpa pernah 0 byte, tidak ada yang
memutuskan gagal — dan karena loop berurutan, 18 episode berikutnya ikut tertunda.

Ini **default di fix saya sendiri** (`e632358`), bukan kode lama.

## Tiga fix

### 1. `SPEED_MIN_BYTES` → 0

```js
// lib/download-thresholds.js
SPEED_MIN_BYTES: 0,
```

Peninggal pengaman yang sia-sia: `SPEED_MIN_RUN_MS` (90 detik). Cukup untuk
menghindari vonis false-positive di detik-detik awal. Bytes bukan ukuran
kecepatan.

Aman untuk unduhan sehat: episode sehat selesai dalam 10-20 detik, jadi unduhannya
**selesai sebelum gate 90 detik menyala** — tidak ada risiko false-positive.

Harus diubah **bersamaan** di `downloader.js` (`ARIA2C_SPEED_MIN_BYTES`), karena
`test-downloadto-speed-floor.js` mengunci kedua angka itu agar tidak melenceng.

### 2. Batas absolut per unduhan (`MAX_RUN_MS`)

Menutup kelas "hampir tidak jalan": stall tidak menyala (byte merangkak) dan speed
floor juga tidak (rata-rata masih di atas ambang) — tapi unduhan tetap tidak akan
selesai.

```js
MAX_RUN_MS: 25 * 60 * 1000,   // vidaraService (downloadTo)
const ARIA2C_MAX_RUN_MS = 20 * 60 * 1000;   // downloader.js (aria2c)
```

Pasang **sebelum** cek stall di kedua watchdog, dan masing-masing menghentikan
prosesnya:

```js
if (now - startedAt >= th.MAX_RUN_MS) {
  return fail(new Error(
    `melebihi batas waktu ${Math.round(th.MAX_RUN_MS / 60000)} menit `
    + `(${(got / 1048576).toFixed(1)} MB terkumpul) — ganti server`,
  ));
}
```

25 menit untuk `downloadTo`: episode sehat 10-20 detik, jadi ini hanya menyala
untuk unduhan yang memang rusak. Dipakai batas atas supaya unduhan besar yang
sah tidak ikut terpotong.

### 3. `finally` di `tick()` — dua kelas, bukan satu

`lib/progress.js` punya **dua** kelas dengan method `tick()`: `Progress` (kelas
lama, `_bot.editMessageText` langsung) dan `RichProgress` (Local API). Keduanya
punya flag `this.editing` yang di-reset **tanpa `finally`**:

```js
} catch {}
this.editing = false;   // kalau render() melempar di luar catch → editing = true PERMANEN
```

Kalau `editing` menggantung `true`, `tick()` berikutnya selalu return di baris
awal → **progres beku diam-diam sampai bot di-restart**. Violasi `AGENTS.md §4`
("kegagalan diam-diam").

Keduanya sekarang `try { … } catch { } finally { this.editing = false; }`.

## Verifikasi

`test-speed-floor-batas.js` **15 pass / 0 fail** (baru), mencakup:
- `SPEED_MIN_BYTES === 0` dan gate waktu tetap ada
- `MAX_RUN_MS >= 5 menit` (tidak terlalu agresif) dan dipakai **sebelum** stall
- pesan batas absolut menyebut menit + MB terkumpul
- **kedua** `tick()` punya `finally` — bukan cuma yang pertama
- anti-regresi: stall tetap 20 detik, floor/window/run tidak berubah, angka aria2c
  masih sama, tidak ada angka magic di watchdog, `disableSpeedFloor` masih ada

### Mutasi wajib (7, semua tertangkap)

| # | Mutasi | Hasil |
|---|--------|-------|
| M1 | `SPEED_MIN_BYTES` balik ke 5 MiB | 13 pass / 2 fail |
| M2 | hapus blok `MAX_RUN_MS` di vidaraService | 13 pass / 2 fail |
| M3 | hapus `ARIA2C_MAX_RUN_MS` beserta penggunanya | 14 pass / 1 fail |
| M4 | `finally` di `tick()` dikembalikan | 14 pass / 1 fail |
| M5 | `MAX_RUN_MS` jadi 30 detik (terlalu agresif) | 14 pass / 1 fail |
| M6 | anti-drift dilanggar (hanya `downloader.js`) | 14 pass / 1 fail |
| M7 | `STALL_MS` diubah (harus tertangkap sebagai regresi) | 14 pass / 1 fail |
| — | dipulihkan | 15 pass / 0 fail |

⚠️ **Bug nyata ditemukan oleh mutasi/test, bukan oleh baca kode:** test 3a
awalnya hanya memeriksa `tick()` yang pertama ditemukan, sehingga
`Progress.tick` (kelas lama) yang belum diperbaiki **terlewat**. Test ditulis ulang
untuk memindai *semua* `tick()` dan menyebut nama kelasnya. Bug kedua ditemukan
karena test itu, bukan karena saya mencari.

### Regresi

```
test-speed-floor-batas      15 pass  0 fail   (BARU)
test-downloadto-speed-floor 10 pass  0 fail
test-ensure-mp4-path         7 pass  0 fail
test-download-stall          7 pass  0 fail
test-kamenime-batch         11 pass  0 fail
test-media-contract         10 pass  0 fail
test-vidoy-uploader        157 pass  0 fail
test-kamenime-provider      26 pass  0 fail
test-picker-prefix          12 pass  0 fail
test-preview-judul-resolusi 11 pass  0 fail
test-dell-vdell-logging     11 pass  0 fail
```

## Insiden: bot mati 4 menit karena saya restart salah

Ini **kelalaian saya**, bukan restart browser dan bukan restart Replit. Kronologi
dari `logs/app.log` + `~/.pm2/logs/prjs-bot-error.log`:

```
14:34:4x  pm2 restart prjs-bot      ← restart SAYA, untuk deploy 3 fix
14:35:09  download progres          ← download MASIH jalan setelah restart
14:35:26  download progres (totalMb 2, belum selesai)
14:35:3x  app.log berhenti           ← proses mati
14:36-14:39  pm2 restart otomatis 17×, gagal terus:
            ERROR: TELEGRAM_BOT_TOKEN tidak ditemukan!
14:39:31  Bot running                ← baru hidup setelah env di-source manual
```

### Kesalahan 1: salah cara cek download aktif

§3a berbunyi "cek `logs/app.log` untuk `download progres` / `Kamenime download`
yang masih berjalan (< 2 menit lalu)". Saya justru menjalankan:

```bash
ps -eo pid,cmd | grep -E "aria2c|ffmpeg" | grep -v grep | wc -l   # → 0
```

Pemeriksaan itu **tidak mungkin menangkap apa pun**: unduhan batch `kam_all:`
lewat `downloadTo` (HTTP), bukan `aria2c`/`ffmpeg`. Log membuktikan ada unduhan
aktif. Kalau saya mengikuti §3a apa adanya, download itu tidak akan terpotong.

### Kesalahan 2: tidak tahu cara menghidupkan ulang bot

`TELEGRAM_BOT_TOKEN` hanya ada di environment Replit, bukan di shell. Perintah
start pm2 yang saya jalankan tidak menyertakannya, jadi bot crash-loop 17 kali
selama 4 menit. Start yang benar:

```bash
set -a; . /run/replit/env/latest; set +a
pm2 start scraper/bot.js --name prjs-bot --cwd /home/runner/workspace --max-memory-restart 700M
pm2 save
```

Keduanya sudah dicatat di memori. Bot online lagi 14:39:31 (PID 2821) dan link
Re:Zero yang dikirim user selama downtime **belum diproses** — perlu dikirim ulang.

## Yang belum diuji

Belum ada E2E untuk ketiga fix. Yang terverifikasi: angka dan penempatan guard,
anti-drift, dan regresi suite penuh. Effectiveness `MAX_RUN_MS` hanya bisa
dibuktikan dengan server yang benar-benar nge-drip lebih dari 25 menit — dan pada
run Re:Zero, stall menyala duluan (11 menit), jadi batas absolut tidak sempat
teruji. Itu tidak apa-apa: tujuannya menutup kelas yang *tidak* Tertangkap stall.
