'use strict';
// Regression test skip batch per-target (3 Okt 2026 — approve owner).
//
// BUG: animeDoneMap hanya baca vidoy_uploads → batch target vt/v (Vidara)
// tidak pernah skip → 144 episode DBZ di-download + dikirim ulang padahal
// record vidara_uploads + pointer TG sudah lengkap (kemarin selesai 144).
// Data produksi dipakai langsung (fungsi asli + DB asli — tanpa mock).
//
// Run: node .tests/batch-skip-vt.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const db = require('../scraper/db');

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); passed++; }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
}

function extractFull(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `fungsi ${name} tidak ditemukan`);
  const start = src.lastIndexOf('async ', i) >= 0 && src.lastIndexOf('async ', i) < i ? src.lastIndexOf('async ', i) : i;
  let depth = 0; let started = false;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`gagal mengekstrak ${name}`);
}

(async () => {
  const src = fs.readFileSync(path.join(__dirname, '../scraper/bot.js'), 'utf8');

  // ── sumber statis ───────────────────────────────────────────────────────
  await t('#1 animeDoneMap union ketiga sumber bukti (§6)', () => {
    assert.ok(/listVidoyUploads/.test(src), 'vidoy_uploads hilang');
    assert.ok(/listVidaraUploads/.test(src), 'vidara_uploads hilang — itu akar bug');
    assert.ok(/listPartsWithFile/.test(src), 'media_parts.file_id hilang');
    const body = src.slice(src.indexOf('async function animeDoneMap'), src.indexOf('function episodeBatchDone'));
    assert.ok(/vidara/.test(body) && /hasTg/.test(body), 'set() tidak menggabungkan vidara/hasTg');
  });

  await t('#2 listVidaraUploads ter-import di bot.js (jebakan §4)', () => {
    const imp = src.split('\n').find((l) => l.includes("require('./db')"));
    assert.ok(imp && imp.includes('listVidaraUploads'),
      'ReferenceError: listVidaraUploads tidak ada di destructuring import');
  });

  await t('#3 ketiga loop batch memakai episodeBatchDone (bukan syarat lama)', () => {
    const calls = (src.match(/episodeBatchDone\(st,/g) || []).length;
    assert.strictEqual(calls, 4, `expected 3 loop + 1 definisi, dapat ${calls}`);
    const old = (src.match(/if \(st && st\.link && st\.hasTg\) \{/g) || []).length;
    assert.strictEqual(old, 0, `syarat lama masih ada ${old}×`);
  });

  await t('#4 helper: syarat per target', () => {
    const fn = new Function(`${extractFull(src, 'episodeBatchDone')}\nreturn episodeBatchDone;`)();
    const lengkap = { link: null, vidara: true, hasTg: true };
    const vidaraTanpaTg = { link: null, vidara: true, hasTg: false };
    const vidoyLengkap = { link: 'https://vidoy/x', vidara: false, hasTg: true };
    assert.strictEqual(fn(lengkap, 'vt'), true, 'vt + record + TG harus skip');
    assert.strictEqual(fn(lengkap, 'v'), true, 'v + record harus skip');
    assert.strictEqual(fn(vidaraTanpaTg, 'vt'), false, 'vt tanpa bukti TG harus jalan (perlu download utk kirim)');
    assert.strictEqual(fn(vidaraTanpaTg, 'v'), true, 'v tanpa TG tetap skip (v tidak kirim TG)');
    assert.strictEqual(fn(vidoyLengkap, 'vyt'), true, 'vyt perilaku lama');
    assert.strictEqual(fn({ link: null, vidara: false, hasTg: false }, 'vt'), false, 'tanpa data harus jalan');
    assert.strictEqual(fn(undefined, 'vt'), false, 'st undefined aman');
  });

  // ── DB ASLI: data produksi DBZ ──────────────────────────────────────────
  const animeDoneMap = new Function(
    'listVidoyUploads', 'listVidaraUploads', 'listPartsWithFile',
    `${extractFull(src, 'animeDoneMap')}\nreturn animeDoneMap;`,
  )(db.listVidoyUploads, db.listVidaraUploads, db.listPartsWithFile);
  const episodeBatchDone = new Function(
    `${extractFull(src, 'episodeBatchDone')}\nreturn episodeBatchDone;`,
  )();

  await t('#5 DB nyata: animeDoneMap baca record + pointer vidara (DBZ)', async () => {
    const map = await animeDoneMap('Dragon Ball Z', 'anime:dragon-ball-z');
    assert.ok(map.size >= 100, `map terlalu kecil: ${map.size}`);
    const ep1 = map.get(1);
    assert.ok(ep1, 'ep1 tidak ada di map');
    assert.strictEqual(ep1.vidara, true, 'ep1 harus punya record vidara');
    assert.strictEqual(ep1.hasTg, true, 'ep1 harus punya bukti TG (data 144 terkirim)');
  });

  await t('#6 DB nyata: semua record DBZ terkirim → vt/v SKIP (bug utama)', async () => {
    const map = await animeDoneMap('Dragon Ball Z', 'anime:dragon-ball-z');
    let vidara = 0; let belumTg = 0;
    for (const [, st] of map) {
      if (st.vidara) { vidara++; if (!st.hasTg) belumTg++; }
      if (st.vidara && !st.hasTg && episodeBatchDone(st, 'vt')) {
        throw new Error('record tanpa pointer tidak boleh skip utk vt');
      }
    }
    assert.ok(vidara >= 100, `record vidara ${vidara} < 100`);
    console.log(`      (record vidara=${vidara}, belum terkirim=${belumTg})`);
    // ep1-…: dulu diulang; kini harus skip
    assert.strictEqual(episodeBatchDone(map.get(1), 'vt'), true, 'ep1 harus skip utk vt');
    assert.strictEqual(episodeBatchDone(map.get(1), 'v'), true, 'ep1 harus skip utk v');
    assert.strictEqual(episodeBatchDone(map.get(1), 'vyt'), false, 'vyt tetap jalan (link vidoy kosong)');
  });

  await t('#7 DB nyata: ep TANPA record vidara → tetap jalan (perlu dikerjakan)', async () => {
    const map = await animeDoneMap('Dragon Ball Z', 'anime:dragon-ball-z');
    const maxEp = Math.max(...map.keys());
    const adaTanpaRecord = [...map.keys()].find((ep) => !map.get(ep).vidara);
    if (adaTanpaRecord !== undefined) {
      assert.strictEqual(episodeBatchDone(map.get(adaTanpaRecord), 'vt'), false,
        `ep ${adaTanpaRecord} tanpa record harus tetap jalan`);
      console.log(`      (ep tanpa record vidara pertama: ${adaTanpaRecord})`);
    } else {
      // Semua ep di map punya record — ep di luar map tidak ada di doneMap → jalan.
      assert.strictEqual(episodeBatchDone(undefined, 'vt'), false, 'st undefined harus jalan');
      console.log('      (semua ep dalam map punya record — ep baru di luar map tetap jalan)');
    }
    assert.ok(maxEp >= 100, `maxEp aneh: ${maxEp}`);
  });

  await t('#8 mock terkontrol: pointer separuh / tanpa link (kasus tak ada di DB nyata)', async () => {
    const f = new Function(
      'listVidoyUploads', 'listVidaraUploads', 'listPartsWithFile',
      `${extractFull(src, 'animeDoneMap')}\nreturn animeDoneMap;`,
    )(
      async () => ([
        { part: 1, link: 'https://x/e/a', tg_chat_id: -100, tg_message_id: 5 },
        { part: 2, link: 'https://x/e/b', tg_chat_id: null, tg_message_id: null },
        { part: 3, link: null, tg_chat_id: -100, tg_message_id: 7 },
        { part: 4, link: 'https://x/e/d', tg_chat_id: -100, tg_message_id: null },
      ]),
      async () => [],
      async () => [],
    );
    const map = await f('Naruto Kecil');
    assert.strictEqual(map.get(1).link, 'https://x/e/a');
    assert.strictEqual(map.get(1).hasTg, true, 'Ep 1 link+pointer → sudah lengkap');
    assert.strictEqual(map.get(2).hasTg, false, 'Ep 2 link tanpa pointer → perlu dikirim');
    assert.strictEqual(map.get(3).hasTg, true, 'Ep 3 file_id-less pointer → ya');
    assert.strictEqual(map.get(3).link, null, 'Ep 3 tanpa link → bukan duplikat');
    assert.strictEqual(map.get(4).hasTg, false, 'pointer separuh (chat ada, msg null) → belum lengkap');
    assert.strictEqual(map.size, 4);
  });

  console.log(`\nRESULT: ${passed} pass, ${failed} fail`);
  process.exit(failed ? 1 : 0);
})();
