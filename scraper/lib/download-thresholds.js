'use strict';

/**
 * Ambang watchdog unduhan — sumber tunggal untuk jalur `downloadTo`
 * (scraper/services/vidaraService.js).
 *
 * Kenapa modul terpisah: `downloader.js` punya angka yang sama persis untuk
 * jalur aria2c, TAPI_CONSTANTA-nya tidak di-export dan file itu di luar scope
 * perubahan. Supaya tidak ada angka 70 yang ditulis dua kali, modul ini jadi
 * pemilik angka; `test-downloadto-speed-floor.js` mengunci bahwa literal di
 * `downloader.js` masih sama dengan sini (anti-drift). Kalau aria2c diubah,
 * test gagal — bukan diam-diam melenceng.
 *
 * Gate speed floor DIBUAT SAMA dengan aria2c (downloader.js):
 *   - hanya dievaluasi setelah unduhan berjalan >= SPEED_MIN_RUN_MS
 *   - hanya kalau sudah terkumpul >= SPEED_MIN_BYTES (hindari vonis
 *     false-positive di detik-detik awal yang masih lambat)
 *   - memakai rata-rata trailing SPEED_WINDOW_MS, bukan sesaat — host yang
 *     sesaat melambat tidak langsung divonis
 *   - di bawah SPEED_FLOOR_BPS selama jendela itu → batalkan
 *
 * STALL_MS sengaja TIDAK sama dengan aria2c: aria2c memakai 90 dtk
 * (ARIA2C_STALL_FREEZE_MS), sedangkan jalur ini 20 dtk. Itu pilihan yang
 * disengaja — stall berarti 0 byte, dan menunggu 90 detik hanya memperpanjang
 * waktu sia-sia. Jangan disamakan tanpa data baru.
 */
module.exports = {
  /** Batas bawah kecepatan rata-rata: 70 KiB/s (identik ARIA2C_SPEED_FLOOR_BPS). */
  SPEED_FLOOR_BPS: 70 * 1024,
  /** Jendela trailing untuk menghitung rata-rata: 90 dtk. */
  SPEED_WINDOW_MS: 90000,
  /** Evaluasi speed floor baru setelah unduhan berjalan 90 dtk. */
  SPEED_MIN_RUN_MS: 90000,
  /** Minimal bytes terkumpul sebelum speed floor bolehmenvonis: 5 MiB. */
  SPEED_MIN_BYTES: 5 * 1024 * 1024,
  /** 0 byte selama ini → anggap mati (TIDAK sama dengan aria2c, lihat catatan). */
  STALL_MS: 20000,
  /** Interval log progres. */
  PROGRESS_MS: 10000,
  /** Interval cek watchdog. */
  WATCHDOG_MS: 1000,
};
