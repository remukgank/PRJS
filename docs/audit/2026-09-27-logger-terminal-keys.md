# 2026-09-27 — terminalKeys logger + ringkasan test yang menipu

Proposal: `docs/proposals/2026-09-27-logger-terminalkeys-test-summary.md`
Status awal: `f4428ca` (log `!dell`/`!vdell`) sudah deployed, suite 371 pass.

---

## Item 1 — `terminalKeys` logger

### Masalah (verified)

`scraper/logger.js` mencetak ke terminal hanya field yang ada di
`terminalKeys`. Semua field baru dari `f4428ca` tidak ada di whitelist, jadi
di `pm2 logs` yang terlihat hanya `msg` + `chatId` — sementara informasi yang
paling berguna (`hasil`, `rows`, `keys`, `terhapus`, `sisa`) hanya ada di
`logs/app.log` (JSON). Padahal itu yang perlu dibaca cepat saat debug
`!dell`/`!vdell`.

### Perubahan (1 file: `scraper/logger.js`, hanya `terminalKeys`)

Ditambahkan: `q`, `hasil`, `slugs`, `rows`, `keys`, `media_key`, `terhapus`,
`sisa`, `dari`, `fileTerhapus`, `gagal`, `part` (`ep` sudah ada).
Whitelist lama (`mb`, `kbps`, `etaSec`, `target`, `title`, `file`, `chatId`,
`server`, `quality`, `container`, `sizeMb`, `source`, `attempt`, `err`) tetap
utuh; whitelist disusun ulang per kelompok dan diberi komentar.

Ditambah `fmtVal()` supaya array tampil sebagai `[a,b]` dan array kosong
sebagai `[]` — sebelumnya `slugs=[]` tercetak sebagai `slugs=` (kosong) yang
tidak bisa dibedakan dari `null`.

### Bukti output terminal (bukan JSON)

```
09:45:08 INFO  !dell query  ·  ep=1 part=1 q=Naruto Shippuuden hasil=0 slugs=[] chatId=-100
09:45:08 INFO  !vdell query  ·  ep=2 rows=2 keys=[Naruto Shippuuden,Naruto Shippuuden] chatId=-100
09:45:08 INFO  !vdell hapus record  ·  part=1 media_key=Naruto Shippuuden chatId=-100
09:45:08 INFO  !vdell selesai  ·  terhapus=2 sisa=0 dari=2 fileTerhapus=2 gagal=0 chatId=-100
09:45:08 INFO  download progres  ·  mb=43.7 kbps=0 ep=5 title=Naruto Shippuuden
```

Nilai `0` tetap tampil (`sisa=0`, `gagal=0`) — justru kasus yang paling perlu
dilihat..only `undefined`/`null` yang dilewati.

### Test: `scraper/tests/test-logger-terminal-keys.js` (baru, 8 pass)

Menjalankan logger **asli** sambil menangkap `process.stdout.write`, lalu
memeriksa baris terminal yang benar-benar dicetak — bukan JSON `app.log`.

- `!dell query` → `q`, `hasil`, `slugs`, `part`, `ep` muncul; array kosong
  tampil `[]`
- `!vdell query` → `rows`, `keys`, `ep`
- `!vdell selesai` → `terhapus`, `sisa`, `dari`, `fileTerhapus`, `gagal`,
  termasuk nilai `0`
- `!vdell hapus record` → `media_key`, `part`
- field di luar whitelist **tidak bocor** (`BOCOR_PNG`, `secretToken`)
- whitelist lama tidak rusak (`mb`, `kbps`, `ep`, `title`)
- `err` tetap tampil sebagai `! …` dan tidak jadi `key=value`
- test penjaga: daftar `terminalKeys` di `logger.js` sendiri harus memuat
  13 field wajib

### Mutasi

| Field yang dicabut dari `terminalKeys` | Hasil |
|---|---|
| `terhapus` | 6 pass / **2 fail** |
| `sisa` | 6 pass / **2 fail** |
| `media_key` | 6 pass / **2 fail** |
| `part` | 5 pass / **3 fail** |

### Dua kegagalan yang benar-benar terjadi saat pengerjaan

1. **Satu assertion salah di test saya sendiri.** `!vdell query` tidak pernah
   mengirim `part` (yang punya `part` adalah `!vdell hapus record`), tapi test
   sempat menuntut `part` di baris itu → FAIL. Diperbaiki setelah dicek ke
   `bot.js`.
2. **Putusan mutasi pertama salah.** `sed` dengan pola `^  'terhapus', $` tidak
   cocok karena field tersebar di beberapa baris → mutasi diam-diam tidak
   mengubah apa pun dan test tetap hijau. Diulang dengan pola
   `s/'terhapus', //` yang benar; baru hasilnya bermakna.

### Field yang MASIH tidak terlihat di terminal (dilaporkan, belum diubah)

`slug`, `name`, `link`, `kind` — dipakai oleh titik log
`!dell hapus library` dan `!vdell hapus record`, tapi tidak ada di daftar
proposal. Konsekuensinya baris `!dell hapus library` untuk "hapus semua part"
(`part: null`) tampil **hanya `chatId`** — tidak ada informasi sama sekali.
Perlu keputusan: tambahkan atau biarkan.

---

## Item 2 — ringkasan `test-vidoy-uploader.js` tercetak di tengah file

### Masalah (verified, dilaporkan oleh agent danuser)

`tests/test-vidoy-uploader.js` mencetak `RESULT: 46 pass, 0 fail` di
baris 479, sementara ~80 test lagi jalan **setelahnya**. Ringkasan yang
terlanjur dicetak selalu hijau walau ada `FAIL` di bawahnya. User sendiri
terkena: ia grep baris ringkasan itu dan menyimpulkan suite ini "46 pass",
padahal sebenarnya 157.

### Keputusan: PINDAH ke akhir, bukan hapus

Dicek dulu: tidak ada runner yang memanggil file ini (tidak ada di
`package.json` scripts; dijalankan standalone `node …`). `exit code` sudah
jadi satu-satunya kontrak, jadi menghapus ringkasan **tidak** akan merusak
deteksi — tapi memindahkannya lebih aman karena informasinya tetap ada dan
sekarang berada setelah semua test. `process.exit(failed ? 1 : 0)` tidak
disentuh.

### Before / after (mutasi: 1 test yang pasti FAIL disisipkan)

**SEBELUM** (ringkasan di tengah):

```
RESULT: 46 pass, 0 fail
FAIL  MUTASI: test ini harus FAIL: mutasi sengaja: …
```

Ringkasan hijau palsu tercetak **lebih dulu**. Anyone yang scroll atau grep
tertipu.

**SESUDAH** (ringkasan di akhir):

```
FAIL  MUTASI: test ini harus FAIL: mutasi sengaja: …
RESULT: 157 pass, 1 fail
exit code: 1
```

Angka dan urutan benar. Setelah mutasi dicabut: `157 pass, 0 fail`, exit 0.

Demonstrasi "sebelum" dijalankan pada **salinan** (`tests/.tmp-sebelum.js`)
yang dihapus setelahnya — file test asli tidak pernah dalam kondisi rusak.

---

## Suite

```
TOTAL 379 pass / 0 fail   (semua file exit 0)
test-logger-terminal-keys    8 pass / 0 fail   (baru)
test-vidoy-uploader        157 pass / 0 fail
test-dell-vdell-logging     11 pass / 0 fail
test-kamenime-provider      26 pass / 0 fail
```

Naik dari 371 → 379 = +8 test baru, tanpa ada test lama yang jadi gagal.

Dicualikan (butuh network/aria2c, tidak terkait):
`test-rich.js`, `test-rich-direct.js`, `test-all-subdomains.js`,
`test-watchdog-aria2c.js`.

## Di luar scope (tidak disentuh)

`bot.js`, `handlers/`, `providers/`, `downloader.js`, `vidaraService.js`,
`gofile-worker.js`. Perintah `!dell`/`!vdell` tidak diubah perilakunya — hanya
penampilan log.
