---
name: Live batch verification
description: Evidence pattern for validating a multi-part Vidara and Telegram batch end to end.
---

Untuk retest batch gabungan, anggap sukses hanya bila beberapa bukti independen selaras: progress final menunjukkan seluruh part selesai tanpa gagal, setiap part menghasilkan pengiriman Telegram, database memiliki satu filecode Vidara untuk setiap episode, dan direktori kerja sementara sudah hilang.

**Why:** Log aplikasi tidak selalu mencetak tahap upload Vidara atau pelepasan lock secara eksplisit; satu indikator saja bisa terlihat sukses walau tahap lain gagal.

**How to apply:** Cocokkan progress/log dengan data upload dan filesystem setelah proses selesai. Pelepasan `vidaraBusy` dapat diverifikasi melalui jalur `finally` yang selalu menghapus key dan kondisi pascarun tanpa proses batch aktif; tambahkan instrumentation bila bukti runtime langsung diperlukan.