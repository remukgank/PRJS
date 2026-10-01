# 2026-09-28 — Fail-fast batch saat kuota Vidoy habis

## Masalah (log produksi)

```
10:17:22  quota_exceeded — Storage limit reached (10 GB → 5 GB, reset 2026-10-01)
10:18 → 11:00  batch TETAP JALAN: download ~250MB → 413 → gagal, per episode
                ep 1126, 1128, 1148, 1152, 1153, 1163, 1164, 1168, 1169, 1170...
```

~15 episode × 250MB ≈ 4GB bandwidth terbuang setelah 413 pertama. Tidak ada
mekanisme berhenti — setiap episode download penuh lalu gagal di register.

## Perbaikan (`scraper/bot.js` saja + test)

Helper (di sebelah `batchTargetLabel`):

```js
function isQuotaExceededError(msg) {
  return /quota_exceeded|storage limit reached|storage_limit/i.test(String(msg || ''));
}
function quotaResetDate(msg) {  // "reset_at":"2026-10-01" → "2026-10-01"
  const m = String(msg || '').match(/reset_at["']?\s*:\s*["']([^"']+)/);
  return m ? m[1].slice(0, 10) : null;
}
```

Ketiga loop (`kam_all`/`sam_all`/`kur_all`, konsisten sesuai tuntutan user):

- cek di DUA titik per loop (cabang `res.error` + `catch`) → set flag → `break`
- setelah loop: pesan khusus `🛑 Batch dihentikan — Vidoy penuh` + tanggal reset
  (kalau terparse) + episode sukses tetap tercatat; yang belum dicoba TIDAK
  dihitung gagal
- `finally` pelepas lock tidak tersentuh — `break` di dalam `try` tetap
  menjalankan `finally` (semantik JS)

`kur_all` ikut diperbaiki walau tidak ada di proposal awal — strukturnya
identik, dan membiarkannya tanpa fail-fast akan inkonsisten antar provider.

## Test: `scraper/tests/test-batch-quota.js` (baru, 15 pass)

- `isQuotaExceededError` dengan pesan 413 ASLI dari log → true; `{"status":413}`
  tanpa kata kuota, HTTP 500, "gagal resolve" → false (tanpa false-positive)
- `quotaResetDate` → "2026-10-01"; tanpa tanggal → null
- 6 titik cek spesifik (kam×2, sam×2, kur×2) — string persis, bukan hitungan total
- pesan khusus + finally utuh per loop

### Mutasi wajib

Hapus 1 cek spesifik → 14 pass / 1 fail (tepat test titik itu).

### Pelajaran test: hitungan total tidak menangkap mutasi tunggal

Versi pertama menghitung `if (isQuotaExceededError(` ≥ 4 — hapus satu masih
lolos (5 ≥ 4). Diganti 6 assertion string persis. Sama seperti pelajaran
"test yang mengunci format vs perilaku": test yang terlalu longgar sama
bahayanya dengan yang terlalu ketat.

## Test existing yang disesuaikan (2× allowlist kata Indonesia)

`test-vidoy-uploader.js` memindai source sebagai teks untuk identifier tak
terdefinisi — termasuk isi string literal. Pesan baru `'...dihentikan (kuota
Vidoy)'` mengandung `dihentikan (` yang cocok regex pemanggilan fungsi.
Solusi mengikuti pola yang SUDAH ADA di file itu (allowlist 'dilewati',
'didukung', …): tambah `'dihentikan'` di kedua METHODS set. Bukan melemahkan
test — pola yang sama untuk kata yang sama masalahnya.

## Suite

```
TOTAL 543+ pass / 3 fail
test-batch-quota   15 pass / 0 fail   (baru)
test-vidoy-uploader 164 pass / 0 fail
```

Tiga FAIL hanya `test-kamenime-batch.js` (5, 6, 11) — test merah user yang
sudah diketahui. Tidak terkait.

## Tidak dilakukan (instruksi user)

Restart (Workflows) dan commit (user setelah verifikasi manual).
Batch yang sedang jalan (jika masih ada) tetap memakai kode lama sampai restart.
