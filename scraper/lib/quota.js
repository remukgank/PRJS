'use strict';
// Deteksi kuota host penuh — dipakai bot.js (fail-fast batch) DAN
// handlers/vidoy.js (fallback Vidoy → Vidara).
//
// Dipisah ke lib supaya regex-nya hanya ada di SATU tempat. Dulu hanya di
// bot.js; sekarang handlers/vidoy.js butuh pola yang sama untuk deciding
// fallback, dan dua salinan regex adalah cara tercepat untuk membuat keduanya
// menyimpang diam-diam (satu berubah, satu tidak — bug yang tidak pernah
// ketahuan karena test hanya menyentuh satu jalur).

/**
 * Apakah pesan error menyatakan kuota storage/bandwidth host sudah habis?
 *
 * Penting: deteksi dari TEKS pesan, bukan HTTP status. Error sudah dibungkus
 * jadi string sebelum sampai ke loop batch, dan host berbeda memakai kode
 * berbeda (Vidoy: `quota_exceeded` + "Storage limit reached").
 *
 * SENGAJA TIDAK memakai pola bebas "limit reached": itu juga cocok dengan
 * "Rate limit reached" (429 sementara), dan salah klasifikasi akan membuat
 * bot menyalin file ke host kedua karena error rate-limit yang akan hilang
 * dalam hitungan detik.
 *
 * @param {string|Error} msg
 * @returns {boolean}
 */
function isQuotaExceededError(msg) {
  const s = String((msg && msg.message) || msg || '');
  return /quota_exceeded|storage[ _]limit|limit[ _]storage|insufficient storage|out of storage|exceeded your storage|storage quota|quota reached|quota exceeded/i.test(s);
}

/**
 * Ambil tanggal reset kuota dari pesan error ("reset_at":"2026-10-01") kalau ada.
 *
 * @param {string|Error} msg
 * @returns {string|null} tanggal YYYY-MM-DD, atau null
 */
function quotaResetDate(msg) {
  const m = String((msg && msg.message) || msg || '').match(/reset_at["']?\s*:\s*["']([^"']+)/);
  return m ? m[1].slice(0, 10) : null;
}

module.exports = { isQuotaExceededError, quotaResetDate };