'use strict';

// Uji pagination picker episode Samehadaku: batas 100 tombol Telegram,
// tombol "Download Semua" selalu muncul di posisi pertama, navigasi halaman valid.

const assert = require('assert');
const { buildPicker, paginate } = require('../lib/samKeyboard');

const N = 220;
const eps = Array.from({ length: N }, (_, i) => ({ ep: i + 1, url: `https://v2.samehadaku.how/anime-x-episode-${i + 1}/` }));
const mkEpFor = (done) => (e) => ({ text: done.has(Number(e.ep)) ? `✅ ${e.ep}` : `Ep ${e.ep}`, callback_data: `sam_ep:h${e.ep}` });
const mkEp = mkEpFor(new Set());

function totalButtons(keyboard) {
  return keyboard.reduce((n, row) => n + row.length, 0);
}

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

// 1) Pagination kelipatan (220/20 = 11 halaman)
t('paginate 220 ep → 11 halaman', () => {
  const m = paginate({ total: 220, page: 0, pageSize: 20 });
  assert.strictEqual(m.totalPages, 11);
  assert.strictEqual(m.first, 1);
  assert.strictEqual(m.last, 20);
});

// 2) Halaman 0: tombol Download Semua PERTAMA, ep 1-20, <100 tombol, hanya Next
t('page 0: batch pertama + ep 1-20 + nav Next', () => {
  const { keyboard, meta } = buildPicker(eps, { urlId: 'a42', page: 0, mkEp });
  assert.strictEqual(keyboard[0][0].text, '⬇️ Download Semua (220)');
  assert.strictEqual(keyboard[0][0].callback_data, 'sam_all:a42');
  assert.strictEqual(meta.first, 1);
  assert.strictEqual(meta.last, 20);
  assert.ok(totalButtons(keyboard) <= 100, `too many buttons: ${totalButtons(keyboard)}`);
  const flatCb = keyboard.flat().map((b) => b.callback_data);
  assert.ok(flatCb.includes('sam_ep:h1'));
  assert.ok(flatCb.includes('sam_ep:h20'));
  assert.ok(!flatCb.some((c) => c.startsWith('sam_page:0:')) === false); // tombol "hal" ada
  assert.ok(flatCb.includes('sam_page:0:a42')); // label halaman 1/11
  assert.ok(flatCb.includes('sam_page:1:a42')); // Next
  assert.ok(!flatCb.includes('sam_page:-1:a42')); // tidak ada Prev
});

// 3) Halaman tengah (5): ep 101-120, Prev + Next ada
t('page 5: ep 101-120 + Prev + Next', () => {
  const { keyboard, meta } = buildPicker(eps, { urlId: 'a42', page: 5, mkEp });
  assert.strictEqual(meta.first, 101);
  assert.strictEqual(meta.last, 120);
  const flatCb = keyboard.flat().map((b) => b.callback_data);
  assert.ok(flatCb.includes('sam_ep:h101'));
  assert.ok(flatCb.includes('sam_ep:h120'));
  assert.ok(flatCb.includes('sam_page:4:a42')); // Prev
  assert.ok(flatCb.includes('sam_page:6:a42')); // Next
});

// 4) Halaman terakhir (10): ep 201-220, tidak ada Next
t('page terakhir: ep 201-220 + tanpa Next', () => {
  const { keyboard, meta } = buildPicker(eps, { urlId: 'a42', page: 10, mkEp });
  assert.strictEqual(meta.first, 201);
  assert.strictEqual(meta.last, 220);
  const flatCb = keyboard.flat().map((b) => b.callback_data);
  assert.ok(flatCb.includes('sam_ep:h201'));
  assert.ok(flatCb.includes('sam_page:9:a42')); // Prev
  assert.ok(!flatCb.includes('sam_page:11:a42')); // tidak ada Next
});

// 5) Page di luar rentang → clamp ke halaman valid
t('page 999 → clamp ke halaman terakhir', () => {
  const { meta } = buildPicker(eps, { urlId: 'a42', page: 999, mkEp });
  assert.strictEqual(meta.page, 10);
  assert.strictEqual(meta.last, 220);
});

// 6) Episode yang sudah ada di library → tombol ✅ + count benar + tombol batch dikurangi
t('done state & missing count', () => {
  const done = new Set([1, 2, 3, 10, 100]);
  const { keyboard, meta } = buildPicker(eps, { urlId: 'a42', page: 0, done, mkEp: mkEpFor(done) });
  assert.ok(keyboard[0][0].text.includes('⬇️ Download Semua (215)'));
  assert.strictEqual(meta.doneCount, 5); // 1,2,3,10,100 (global, bukan hanya halaman 1)
  const row0texts = keyboard[1].map((b) => b.text);
  assert.ok(row0texts.includes('✅ 1'));
  assert.ok(row0texts.includes('✅ 2'));
});

// 7) Semua halaman: setiap keyboard <100 tombol & baris ≤5 ep
t('>100 button safety di semua halaman', () => {
  for (let page = 0; page < paginate({ total: N, pageSize: 20 }).totalPages; page++) {
    const { keyboard } = buildPicker(eps, { urlId: 'a42', page, mkEp });
    assert.ok(totalButtons(keyboard) <= 100, `page ${page}: ${totalButtons(keyboard)}`);
    for (const row of keyboard.slice(1, -1)) assert.ok(row.length <= 5);
  }
});

console.log(`\n${passed} tests passed`);