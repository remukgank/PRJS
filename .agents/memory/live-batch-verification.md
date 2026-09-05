---
name: Live batch verification
description: Evidence pattern for validating a multi-part Vidara and Telegram batch end to end.
---

Untuk retest batch gabungan, anggap sukses hanya bila beberapa bukti independen selaras: progress final menunjukkan seluruh part selesai tanpa gagal, setiap part menghasilkan pengiriman Telegram, database memiliki satu filecode Vidara untuk setiap episode, dan direktori kerja sementara sudah hilang.

**Why:** Log aplikasi tidak selalu mencetak tahap upload Vidara atau pelepasan lock secara eksplisit; satu indikator saja bisa terlihat sukses walau tahap lain gagal.

**How to apply:** Cocokkan progress/log dengan data upload dan filesystem setelah proses selesai. Pelepasan `vidaraBusy` dapat diverifikasi melalui jalur `finally` yang selalu menghapus key dan kondisi pascarun tanpa proses batch aktif; tambahkan instrumentation bila bukti runtime langsung diperlukan.

Validasi dengan bukti lintas-sumber seperti ini diterima sebagai kriteria penutupan batch: angka episode, filecode upload, timestamp pengiriman, hasil progress, dan kondisi pascarun harus konsisten.

**Why:** Persetujuan penutupan datang setelah setiap checklist ditautkan ke bukti konkret, termasuk pemisahan error historis dari run final.

**How to apply:** Jangan menutup batch hanya dari pesan sukses tunggal atau klaim handler; kumpulkan bukti end-to-end yang dapat dicocokkan.