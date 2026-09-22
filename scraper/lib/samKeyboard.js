'use strict';

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

// done: Set<Number ep>. mkEp(ep) → { text, callback_data } untuk tombol episode.
function buildPicker(eps, { urlId, page = 0, pageSize = 20, done = new Set(), mkEp } = {}) {
  const { page: p, totalPages, first, last } = paginate({ total: eps.length, page, pageSize });
  const slice = eps.slice(p * pageSize, (p + 1) * pageSize);
  const doneCount = eps.filter((e) => done.has(Number(e.ep))).length;
  const missing = eps.length - doneCount;
  const keyboard = [];
  keyboard.push([{
    text: missing > 0 ? `⬇️ Download Semua (${missing})` : '✅ Semua episode sudah di library',
    callback_data: `sam_all:${urlId}`,
  }]);
  for (let i = 0; i < slice.length; i += 5) {
    keyboard.push(slice.slice(i, i + 5).map((e) => mkEp(e)));
  }
  if (totalPages > 1) {
    const nav = [];
    if (p > 0) nav.push({ text: '⬅️ Prev', callback_data: `sam_page:${p - 1}:${urlId}` });
    nav.push({ text: `📄 ${p + 1}/${totalPages}`, callback_data: `sam_page:${p}:${urlId}` });
    if (p < totalPages - 1) nav.push({ text: 'Next ➡️', callback_data: `sam_page:${p + 1}:${urlId}` });
    keyboard.push(nav);
  }
  return { keyboard, meta: { page: p, totalPages, first, last, doneCount, missing } };
}

module.exports = { buildPicker, paginate };