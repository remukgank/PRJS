'use strict';

// Ack cepat di handler navigasi picker (anti "macet saat ditekan").
//
// MASALAH: sam_page/kam_page/kur_page tidak memanggil answerCallbackQuery di
// awal — ack hanya ada di jalur gagal (bukan admin / link kadaluarsa). Yang
// dikerjakan pertama malah editMessageText + fetch provider + query DB.
// Spinner Telegram muter terus → user mengira tap tidak masuk → tap berulang
// → tiap tap antre full render baru → makin lambat. Terbukti di log 28 Sep:
// 12 tap `sam_page:16:19` dalam 27 detik tanpa perubahan terlihat.
//
// FIX: `bot.answerCallbackQuery(query.id).catch(() => {});` segera setelah cek
// admin, sebelum kerja lambat. Fire-and-forget (tidak di-await).
//
// Run: node scraper/tests/test-picker-ack.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BOT = path.join(__dirname, '..', 'bot.js');
const src = fs.readFileSync(BOT, 'utf8');

let passed = 0;
let failed = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });

/** Ambil body handler `if (data.startsWith('X:')) { ... }` dengan depth. */
function handlerBody(prefix) {
  const marker = `if (data.startsWith('${prefix}:')) {`;
  const s = src.indexOf(marker);
  assert.ok(s >= 0, `handler ${prefix}: tidak ditemukan`);
  let depth = 0;
  for (let k = s; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(s, k + 1); }
  }
  throw new Error(`handler ${prefix}: tidak tertutup`);
}

for (const prefix of ['sam_page', 'kam_page', 'kur_page']) {
  t(`${prefix}: answerCallbackQuery SEBELUM kerja lambat`, () => {
    const body = handlerBody(prefix);
    const iAck = body.search(/bot\.answerCallbackQuery\(query\.id\)\.catch\(\(\) => \{\}\)/);
    assert.ok(iAck > 0, 'tidak ada ack cepat tanpa teks');
    // kerja lambat = fetch provider / resolve / DB / render pertama
    const slow = ['resolveSamehadakuFullhd', 'listKamenimeEpisodes', 'listKuronimeEpisodes',
      'episodeStatusMap', 'buildSamehadakuEpisodePicker', 'buildKuronimeEpisodePicker',
      'editMessageText'];
    for (const kw of slow) {
      const i = body.indexOf(kw);
      if (i > 0) assert.ok(iAck < i, `ack harus SEBELUM ${kw}`);
    }
    return 'ack dulu, kerja kemudian ✓';
  });

  t(`${prefix}: ack tidak di-await (fire-and-forget)`, () => {
    const body = handlerBody(prefix);
    assert.ok(!/await bot\.answerCallbackQuery\(query\.id\)\.catch/.test(body),
      'ack cepat tidak boleh di-await — itu menambah latensi');
    return 'fire-and-forget ✓';
  });
}

t('penjaga: ack cepat tidak mengubah alur gagal (admin/link tetap ditolak dulu)', () => {
  for (const prefix of ['sam_page', 'kam_page', 'kur_page']) {
    const body = handlerBody(prefix);
    const iAdmin = body.indexOf('Hanya admin');
    const iAck = body.search(/bot\.answerCallbackQuery\(query\.id\)\.catch\(\(\) => \{\}\);/);
    assert.ok(iAdmin > 0 && iAck > iAdmin,
      `${prefix}: cek admin harus tetap pertama, ack cepat sesudahnya`);
  }
  return 'urutan: admin → ack → kerja ✓';
});

(async () => {
  for (const { name, fn } of queue) {
    try {
      const extra = await fn();
      console.log(`PASS  ${name}`);
      if (extra) console.log(`      ${extra}`);
      passed++;
    } catch (e) {
      failed++;
      console.error(`FAIL  ${name}: ${e.message}`);
    }
  }
  console.log(`\n${passed} pass / ${failed} fail`);
  process.exit(failed ? 1 : 0);
})();
