'use strict';
// Deteksi kuota host penuh — dipakai bot.js (fail-fast batch) DAN
// handlers/vidoy.js (fallback Vidoy → Vidara).
//
// Dipisah ke lib supaya regex-nya hanya ada di SATU tempat. Dulu hanya di
// bot.js; sekarang handlers/vidoy.js butuh pola yang sama untuk deciding
// fallback, dan dua salinan regex adalah cara tercepat untuk membuat keduanya
// menyimpang diam-diam (satu berubah, satu tidak — bug yang tidak pernah
// ketahuan karena test hanya menyentuh satu jalur).
//
// Dua jenis "penuh" yang berbeda host, keduanya harus memicu fail-fast:
//   Vidoy   → 413 quota_exceeded, reset bulanan ("reset_at":"2026-11-01")
//   Vidara  → 200 file/hari, reset harian ("resets at 00:00 UTC")
// Tanpa yang kedua, batch target vt tetap mendownload episode yang pasti gagal
// (bukti 1 Okt 2026: ep 130–153, ~1,7 GB terbuang sebelum batch berhenti).

// Pola batas harian upload. SENGAJA spesifik: pola bebas "limit reached" juga
// cocok dengan "Rate limit reached, retry in 30s" (429 sementara) — salah
// klasifikasi akan menghentikan batch demi error yang hilang dalam hitungan
// detik. Test negatifnya dikunci di test-batch-quota.js.
const VIDARA_DAILY_RE = /daily upload limit|upload limit reached|files per day/i;

/**
 * Apakah pesan error menyatakan kuota storage/bandwidth/batas harian host penuh?
 *
 * Penting: deteksi dari TEKS pesan, bukan HTTP status. Error sudah dibungkus
 * jadi string sebelum sampai ke loop batch, dan host berbeda memakai kode
 * berbeda (Vidoy: `quota_exceeded` + "Storage limit reached"; Vidara: pesan
 * teks "Daily upload limit reached").
 *
 * @param {string|Error} msg
 * @returns {boolean}
 */
function isQuotaExceededError(msg) {
  const s = String((msg && msg.message) || msg || '');
  return /quota_exceeded|storage[ _]limit|limit[ _]storage|insufficient storage|out of storage|exceeded your storage|storage quota|quota reached|quota exceeded/i.test(s)
    || VIDARA_DAILY_RE.test(s);
}

/**
 * Apakah ini batas harian upload Vidara (200 file/hari)?
 *
 * Terpisah dari isQuotaExceededError supaya caller bisa membedakan HOST:
 * isQuotaExceededError = "berhenti", vidaraDailyLimitError = "berhenti KARENA
 * Vidara" (menentukan apakah perlu menyalakan flag agar batch berikutnya tidak
 * mengulang percobaan yang pasti gagal).
 *
 * @param {string|Error} msg
 * @returns {boolean}
 */
function vidaraDailyLimitError(msg) {
  const s = String((msg && msg.message) || msg || '');
  return VIDARA_DAILY_RE.test(s);
}

/**
 * Epoch ms 00:00 UTC berikutnya (reset harian Vidara).
 *
 * Pesan error hanya bilang "resets at 00:00 UTC" tanpa tanggal, jadi satu
 * -satunya penafsiran yang benar adalah tengah malam UTC berikutnya.
 *
 * @returns {number}
 */
function nextUtcMidnightMs() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * Ambil waktu reset kuota dari pesan error.
 *
 * Dua bentuk, keduanya dikembalikan sebagai YYYY-MM-DD:
 *   - bulanan (Vidoy):   "reset_at":"2026-11-01" → tanggalnya sendiri
 *   - harian  (Vidara):  "resets at 00:00 UTC"   → 00:00 UTC berikutnya
 *
 * @param {string|Error} msg
 * @returns {string|null} tanggal YYYY-MM-DD, atau null
 */
function quotaResetDate(msg) {
  const s = String((msg && msg.message) || msg || '');
  const m = s.match(/reset_at["']?\s*:\s*["']([^"']+)/);
  if (m) return m[1].slice(0, 10);
  if (VIDARA_DAILY_RE.test(s) && /resets at/i.test(s)) {
    return new Date(nextUtcMidnightMs()).toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Ringkasan kenapa batch berhenti + teks pesan yang layak ditampilkan.
 *
 * Sebelum fungsi ini ada, ketiga loop batch menulis "Batch dihentikan — Vidoy
 * penuh." untuk SEMUA jenis kegagalan termasuk limit harian Vidara → pesan
 * menunjuk host yang salah dan tanggal resetnya juga salah.
 *
 * @param {string|Error} msg
 * @returns {{host: 'vidoy'|'vidara', headline: string, detail: string, reset: string|null}}
 */
function quotaStopInfo(msg) {
  const s = String((msg && msg.message) || msg || '');
  const vidara = VIDARA_DAILY_RE.test(s);
  return {
    host: vidara ? 'vidara' : 'vidoy',
    headline: vidara ? 'Limit harian Vidara penuh' : 'Vidoy penuh',
    detail: vidara
      ? 'Vidara mengizinkan 200 file/hari'
      : 'Kuota Vidoy habis',
    reset: quotaResetDate(s),
  };
}

module.exports = {
  isQuotaExceededError,
  vidaraDailyLimitError,
  quotaResetDate,
  quotaStopInfo,
  nextUtcMidnightMs,
};
