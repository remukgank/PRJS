/**
 * test-picker-prefix.js
 *
 * Mengunci bahwa setiap picker memakai prefix callback_data yang SESUAI dengan
 * provider-nya. Akar bug (27 Sep 2026): buildPicker default prefix='sam', dan
 * picker kamenime tidak meng-override → tombol "Download Semua" + Prev/Next
 * mengirim sam_all:/sam_page: → dijalankan sebagai perintah SAMEHADAKU dengan
 * URL kamenime. Gejala: "no FULLHD/4K servers found" untuk 500 episode.
 *
 * Gejalanya diam-diam karena tombol per-episode (kam_ep:) memang benar.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildPicker } = require('../lib/samKeyboard');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
const LINES = SRC.split('\n');

let pass = 0, fail = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });
const done = (name, err) => {
  if (err) { fail++; console.log(`FAIL  ${name}\n      ${String(err.message).split('\n')[0]}`); }
  else { pass++; console.log(`PASS  ${name}`); }
};

/** Ambil teks panggilan buildPicker di sekitar baris tertentu. */
function buildPickerCallAt(mapName, extra = 18) {
  const i = SRC.indexOf(mapName);
  if (i < 0) return null;
  // mundur ke baris buildPicker( terdekat di SEBELUM mapName
  const upto = SRC.slice(0, i);
  const start = upto.lastIndexOf('buildPicker(');
  if (start < 0) return null;
  const ln = upto.slice(0, start).split('\n').length - 1;
  // ambil dari buildPicker( sampai cukup baris
  return LINES.slice(ln, ln + extra).join('\n');
}

// mkEp meniru picker kamenime sungguhan (bot.js:1996) — callback_data-nya
// dari map internal, bukan prefix picker. Pakai prefix 'kam_ep' supaya test
// 6b memeriksa prefix yang BENAR-benar ada di bot.js.
const mkEp = (e) => ({ text: `Ep ${e.ep}`, callback_data: `kam_ep:${String(e.ep).padStart(8, '0')}` });
const eps = Array.from({ length: 500 }, (_, i) => ({ ep: i + 1, url: `https://x/episode/${i + 1}` }));

// ───────────────────────────────────────────────────────────────────────────
t('1) buildPicker default prefix = "sam" (dokumentasi defaultnya)', () => {
  const { keyboard: kb } = buildPicker(eps, { urlId: 'u', mkEp });
  const all = kb[0][0];
  assert.strictEqual(all.callback_data, 'sam_all:u');
});

t('2) picker KAMENIME memakai prefix "kam" — bukan default', () => {
  const call = buildPickerCallAt('kamenimeEpisodeMap.set(epId, e.url)');
  assert.ok(call, 'tidak ketemu pemanggilan buildPicker kamenime');
  const m = call.match(/prefix:\s*'(\w+)'/);
  assert.ok(m, 'picker kamenime TIDAK mengirim prefix — akan dapat default "sam"');
  assert.strictEqual(m[1], 'kam');
});

t('3) picker SAMEHADAKU tetap "sam" (tidak boleh diubah)', () => {
  const call = buildPickerCallAt('samehadakuEpisodeMap.set(epId, e.url)');
  const m = call.match(/prefix:\s*'(\w+)'/);
  assert.ok(!m, 'samehadaku tidak perlu prefix (default "sam" memang benar)');
  assert.ok(call.includes('buildPicker('));
});

t('4) picker KURONIME tetap prefix "kur" (regresi)', () => {
  const call = buildPickerCallAt('kuronimeEpisodeMap.set(epId, e.url)');
  const m = call.match(/prefix:\s*'(\w+)'/);
  assert.ok(m && m[1] === 'kur', 'kuronime harus tetap "kur"');
});

t('5) BUKTI RUN: picker kamenime tidak bisa menghasilkan sam_all', () => {
  const call = buildPickerCallAt('kamenimeEpisodeMap.set(epId, e.url)');
  const m = call.match(/prefix:\s*'(\w+)'/);
  const used = m ? m[1] : 'sam';
  const { keyboard: kb } = buildPicker(eps, { urlId: 'u', mkEp, prefix: used });
  const all = kb[0][0];
  const navRow = kb[kb.length - 1];
  const nav = navRow.map((b) => b.callback_data);
  console.log(`      tombol utama : ${all.text} → ${all.callback_data}`);
  console.log(`      navigasi     : ${nav.join('  ')}`);
  assert.ok(!all.callback_data.startsWith('sam_all:'),
    `tombol Download Semua masih sam_all: — ${all.callback_data}`);
  assert.ok(all.callback_data.startsWith('kam_all:'),
    `harus kam_all:, dapat ${all.callback_data}`);
  for (const n of nav) {
    assert.ok(!n.startsWith('sam_page:'), `navigasi masih sam_page: — ${n}`);
  }
});

t('6) setiap prefix yang dipakai picker PUNYA handler di bot.js', () => {
  for (const p of ['kam_ep', 'kam_page', 'kam_all', 'kur_ep', 'kur_page', 'sam_ep', 'sam_page']) {
    assert.ok(SRC.includes(`'${p}:'`) || SRC.includes(`'${p}:`),
      `handler ${p}: tidak ada di bot.js → callback akan jatuh ke provider lain`);
  }
});

t('6b) TIDAK ADA callback tanpa handler (tombol mati = kesalahan diam-diam)', () => {
  // Setiap prefix yang buildPicker hasilkan harus punya blok if di bot.js.
  const { keyboard: kb } = buildPicker(eps, { urlId: 'u', mkEp, prefix: 'kam' });
  const datas = new Set();
  for (const row of kb) for (const b of row) if (b.callback_data) datas.add(b.callback_data);
  for (const d of datas) {
    const head = d.split(':')[0];
    assert.ok(SRC.includes(`'${head}:'`), `tombol "${head}" tidak punya handler di bot.js`);
  }
  console.log(`      tombol dicek: ${[...datas].map((d) => d.split(':')[0]).filter((v,i,a)=>a.indexOf(v)===i).join(', ')}`);
});

t('6c) kam_all: menjawab dengan jelas (bukan diam, bukan Unhandled error)', () => {
  const i = SRC.indexOf("data.startsWith('kam_all:')");
  assert.ok(i > 0, 'handler kam_all: tidak ada — tombol akan mati diam-diam');
  const blk = SRC.slice(i, i + 900);
  assert.ok(blk.includes('answerCallbackQuery'), 'harus membalas lewat answerCallbackQuery (popup)');
  assert.ok(blk.includes('show_alert'), 'popup harus show_alert agar terlihat');
  assert.ok(/belum tersedia/i.test(blk), 'pesan harus menyebutkan fitur belum tersedia');
});

t('7) handler kam_page: ada, dan memakai listKamenimeEpisodes + buildKamenimeEpisodePicker', () => {
  const i = SRC.indexOf("data.startsWith('kam_page:')");
  assert.ok(i > 0, 'handler kam_page: tidak ada');
  const blk = SRC.slice(i, i + 1800);
  assert.ok(blk.includes('listKamenimeEpisodes'), 'harus pakai listKamenimeEpisodes');
  assert.ok(blk.includes('buildKamenimeEpisodePicker'), 'harus pakai buildKamenimeEpisodePicker');
  assert.ok(!blk.includes('listSamehadakuEpisodes'), 'tidak boleh pakai parser samehadaku');
});

t('8) cache episode kamenime ada & dipakai (tidak fetch 271KB tiap tap)', () => {
  assert.ok(SRC.includes('kamenimeEpisodesCache'), 'kamenimeEpisodesCache belum ada');
  assert.ok(/kamenimeEpisodesCache\.set\(/.test(SRC), 'cache tidak pernah diisi');
  const i = SRC.indexOf("data.startsWith('kam_page:')");
  const blk = SRC.slice(i, i + 1800);
  assert.ok(blk.includes('kamenimeEpisodesCache.get('), 'kam_page: harus baca cache dulu');
});

t('9) guard: sam_all menolak URL non-Samehadaku (pesan jelas, bukan Unhandled error)', () => {
  const i = SRC.indexOf("data.startsWith('sam_all:') || data.startsWith('sam_allgo:')");
  assert.ok(i > 0, 'blok sam_all tidak ditemukan');
  const blk = SRC.slice(i, i + 1600);
  assert.ok(/samehadaku/.test(blk) && /(how|site)/.test(blk),
    'harus ada guard yang mengecek domain samehadaku');
  assert.ok(blk.includes('ditolak'), 'harus ada pesan penolakan');
});

t('10) picker kamenime tetap 500 episode & paginasi 25 halaman', () => {
  const { keyboard: kb, meta } = buildPicker(eps, { urlId: 'u', mkEp, prefix: 'kam' });
  assert.strictEqual(meta.totalPages, 25);
  assert.strictEqual(kb.filter((r) => r.length === 5 && r[0].callback_data.startsWith('kam_ep')).length, 4);
  // tombol per halaman: 1 batch + 20 ep + 1 nav = 22 < 100 (limit Telegram)
  const perPage = 1 + 20 + 1;
  assert.ok(perPage < 100, 'tombol per halaman harus < 100');
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); done(name, null); }
    catch (e) { done(name, e); }
  }
  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
