'use strict';

const BTN = require('./btn');

// Pembuat keyboard picker episode Samehadaku yang PAGED.
// Telegram memotong keyboard >100 tombol → default 20 ep/halaman (5 baris × 4)
// sehingga total tombol per halaman selalu ≤ 25 (batch 1 + ep 20 + nav) < 100.

function paginate({ total, page = 0, pageSize = 20 }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.max(0, Math.min(Math.floor(Number(page) || 0), totalPages - 1));
  const first = p * pageSize + 1;
  const last = Math.min((p + 1) * pageSize, total);
  return { page: p, totalPages, first, last };
}

// done: Set<Number ep>. mkEp(ep, page) → { text, callback_data } untuk tombol episode.
// prefix: awalan callback batch/navigasi ('sam' default; 'kur' utk kuronime).
// page: disisipkan di AKHIR callback_data (setiap tombol generated dari picker
// membawa halaman asal) supaya "Kembali" tidak selalu melompat ke page 0.
// Format lama tanpa page tetap valid — lihat pickPageFromData di bot.js.
function buildPicker(eps, { urlId, page = 0, pageSize = 20, done = new Set(), mkEp, prefix = 'sam' } = {}) {
  const { page: p, totalPages, first, last } = paginate({ total: eps.length, page, pageSize });
  const slice = eps.slice(p * pageSize, (p + 1) * pageSize);
  const doneCount = eps.filter((e) => done.has(Number(e.ep))).length;
  const missing = eps.length - doneCount;
  const keyboard = [];
  // Aksi utama layar ini (primary). Kalau semua episode sudah ada, tombolnya
  // mati (disabled) — bukan disembunyikan, supaya user paham statusnya.
  const allDone = missing <= 0;
  keyboard.push([allDone
    ? BTN.btnOff(`✅ Semua episode sudah ada`)   // bukan "di library": done = library ∪ Telegram
    : BTN.btn(`⬇️ Download Semua (${missing})`, `${prefix}_all:${urlId}:${p}`, 'primary')]);
  for (let i = 0; i < slice.length; i += 5) {
    keyboard.push(slice.slice(i, i + 5).map((e) => mkEp(e, p)));
  }
    if (totalPages > 1) {
      const nav = [];
      // Label nav WAJIB pendek (simbol/angka saja, tanpa kata "Prev"/"Next"/📄).
      // Bukti screenshot 28 Sep: 4 tombol berlabel kata ("⬅️ Prev", "📄 59/59")
      // sudah terpotong jadi "Pr..." / "59..." di layar user. Baris 7 tombol
      // berlabel kata tidak akan terbaca sama sekali. Callback_data tidak
      // berubah — hanya teks yang tampil.
      if (p > 0) nav.push({ text: '⏮', callback_data: `${prefix}_page:0:${urlId}` });
      if (p >= 10) nav.push({ text: '⏪', callback_data: `${prefix}_page:${p - 10}:${urlId}` });
      if (p > 0) nav.push({ text: '⬅️', callback_data: `${prefix}_page:${p - 1}:${urlId}` });
      nav.push({ text: `${p + 1}/${totalPages}`, callback_data: `${prefix}_page:${p}:${urlId}` });
      if (p < totalPages - 1) nav.push({ text: '➡️', callback_data: `${prefix}_page:${p + 1}:${urlId}` });
      if (p + 10 < totalPages) nav.push({ text: '⏩', callback_data: `${prefix}_page:${p + 10}:${urlId}` });
      if (p < totalPages - 1) nav.push({ text: '⏭', callback_data: `${prefix}_page:${totalPages - 1}:${urlId}` });
      keyboard.push(nav);
    }
  return { keyboard, meta: { page: p, totalPages, first, last, doneCount, missing } };
}

module.exports = { buildPicker, paginate };