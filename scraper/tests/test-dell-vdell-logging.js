'use strict';

// Verifikasi 5 titik log !dell / !vdell.
//
// PENTING: test ini TIDAK menulis ulang logikanya. Ia meng-ekstrak blok kode
// NYATA dari scraper/bot.js lalu menjalankannya dengan stub. Menyalin logika
// ke test = test yang hanya membuktikan salinannya benar, bukan aplikasinya
// (persis jebakan yang sudah menipu di commit c7572ff).
//
// Run: node scraper/tests/test-dell-vdell-logging.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BOT = path.join(__dirname, '..', 'bot.js');
const src = fs.readFileSync(BOT, 'utf8');

let passed = 0;
let failed = 0;
const queue = [];
// CATATAN: jangan buat t() yang langsung menjalankan. Versi pertama memakai
// try/catch sinkron, sehingga test yang balik Promise SELALU "PASS" walau
// assertion di dalam .then()-nya gagal — test paling penting lolos palsu.
const t = (name, fn) => queue.push({ name, fn });

const escHtml = (s) => String(s);

/** Potong blok kode nyata antara dua penanda.
 *  wholeStatement:false → potong balik ke baris sebelum penanda yang
 *  membuka blok ('{'), supaya hasil ekstraksi tetap bisa diparse. */
function extract(startMark, endMark, opts) {
  const s = src.indexOf(startMark);
  assert.ok(s >= 0, `penanda awal tidak ditemukan: ${startMark}`);
  const e = src.indexOf(endMark, s);
  assert.ok(e > s, `penanda akhir tidak ditemukan: ${endMark}`);
  let end = e + endMark.length;
  const opensBlock = endMark.trimEnd().endsWith('{');
  if (opensBlock && !(opts && opts.keepOpenBlock)) end = src.lastIndexOf('\n', e) + 1;
  return src.slice(s, end);
}

/** Jalankan blok kode nyata dengan stub yang disuntikkan. */
function run(block, scope) {
  const keys = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const factory = new Function(keys.join(','), `return (async () => {\n${block}\n})();`);
  return factory(...keys.map((k) => scope[k]));
}

/** Stub logger yang merekam setiap panggilan. */
function stubLogger() {
  const calls = [];
  return {
    calls,
    info: (obj, msg) => calls.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => calls.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => calls.push({ level: 'error', obj, msg }),
    find: (msg) => calls.find((c) => c.msg === msg),
  };
}

function stubBot() {
  const sent = [];
  return {
    sent,
    sendMessage: (chatId, text) => { sent.push(text); return Promise.resolve(); },
    editMessageText: (text) => { sent.push(text); return Promise.resolve(); },
    answerCallbackQuery: () => Promise.resolve(),
  };
}

// ── blok 1: !dell query (sebelum early return "Tidak ditemukan") ──────────────
const BLK_DELL_QUERY = extract(
  'const found = await findMediaByName(mediaName);',
  'if (found.length > 1 && isNaN(partNum)) {',
);

t('!dell query — gagal (0 hasil): q/hasil/slugs/part tercatat, pesan user tak berubah', () => {
  const logger = stubLogger();
  const bot = stubBot();
  return run(BLK_DELL_QUERY, {
    logger, bot, chatId: -100, mediaName: 'Judul Hilang', partNum: NaN,
    findMediaByName: async () => [],
  }).then(() => {
    const c = logger.find('!dell query');
    assert.ok(c, '!dell query tidak dipanggil');
    assert.strictEqual(c.obj.q, 'Judul Hilang');
    assert.strictEqual(c.obj.hasil, 0);
    assert.deepStrictEqual(c.obj.slugs, []);
    assert.strictEqual(c.obj.part, null, 'part harus null kalau bukan angka');
    assert.ok(bot.sent.join().includes('Tidak ditemukan'), 'pesan user harus tetap sama');
    return `gagal: ${JSON.stringify(c.obj)}`;
  });
});

t('!dell query — sukses (1 hasil): slugs tercatat', () => {
  const logger = stubLogger();
  const bot = stubBot();
  return run(BLK_DELL_QUERY, {
    logger, bot, chatId: -100, mediaName: 'Naruto Shippuuden', partNum: NaN,
    findMediaByName: async () => ([{ slug: 'anime:naruto', nama: 'Naruto Shippuuden' }]),
  }).then(() => {
    const c = logger.find('!dell query');
    assert.strictEqual(c.obj.hasil, 1);
    assert.deepStrictEqual(c.obj.slugs, ['anime:naruto']);
    return `sukses: ${JSON.stringify(c.obj)}`;
  });
});

t('!dell query — part angka ikut tercatat (bukan null)', () => {
  const logger = stubLogger();
  const bot = stubBot();
  return run(BLK_DELL_QUERY, {
    logger, bot, chatId: -100, mediaName: 'Naruto Shippuuden', partNum: 3,
    findMediaByName: async () => ([{ slug: 'anime:naruto', nama: 'Naruto Shippuuden' }]),
  }).then(() => {
    const c = logger.find('!dell query');
    assert.strictEqual(c.obj.part, 3);
    return `part=3: ${JSON.stringify(c.obj)}`;
  });
});

// ── blok 2: !dell hapus library (sebelum deleteMedia) ─────────────────────────
const BLK_DELL_DELETE = extract(
  'const libPtrs = await listPartTelegramPointers(pending.slug);',
  'await deleteMedia(pending.slug);',
);

t('!dell hapus library — log SEBELUM deleteMedia (urutan dibuktikan)', () => {
  const order = [];
  // logger ikut mencatat ke array urutan supaya bisaDibuktikan log mendahului delete
  const logger = { info: (obj, msg) => { order.push(`log:${msg}`); calls.push({ obj, msg }); }, warn() {}, error() {} };
  const calls = [];
  return run(BLK_DELL_DELETE, {
    logger,
    chatId: -100, msgId: 1,
    pending: { slug: 'anime:naruto', part: null, name: 'Naruto Shippuuden' },
    listPartTelegramPointers: async () => { order.push('libPtrs'); return []; },
    listVidoyTelegramPointers: async () => { order.push('vidPtrs'); return []; },
    deleteTelegramMessagesRaw: async () => { order.push('delMsg'); return { deleted: 3, missing: 1 }; },
    clearVidoyTelegramPointers: async () => { order.push('clear'); return 4; },
    deleteMedia: async () => { order.push('deleteMedia'); return true; },
    bot: stubBot(),
  }).then(() => {
    const c = calls.find((x) => x.msg === '!dell hapus library');
    assert.ok(c, '!dell hapus library tidak dipanggil');
    assert.strictEqual(c.obj.slug, 'anime:naruto');
    assert.strictEqual(c.obj.part, null);
    assert.strictEqual(c.obj.name, 'Naruto Shippuuden');
    const iLog = order.indexOf('log:!dell hapus library');
    const iDel = order.indexOf('deleteMedia');
    assert.ok(iLog >= 0 && iDel >= 0, `urutan tidak lengkap: ${order.join(' → ')}`);
    assert.ok(iLog < iDel,
      `log harus SEBELUM deleteMedia — sekarang: ${order.join(' → ')}`);
    return `terbukti: ${order.join(' → ')}`;
  });
});

// ── blok 3: !vdell query ─────────────────────────────────────────────────────
const BLK_VDELL_QUERY = extract(
  'const rows = await findVidoyRecords(titleQ, hasEp ? epNum : null);',
  'const kinds = [...new Set(rows.map((r) => r.kind))];',
);

t('!vdell query — gagal (0 row): rows/keys/ep tercatat, pesan user tak berubah', () => {
  const logger = stubLogger();
  const bot = stubBot();
  return run(BLK_VDELL_QUERY, {
    logger, bot, chatId: -100, escHtml, titleQ: 'Judul Hilang', hasEp: false, epNum: NaN,
    findVidoyRecords: async () => [],
  }).then(() => {
    const c = logger.find('!vdell query');
    assert.ok(c, '!vdell query tidak dipanggil');
    assert.strictEqual(c.obj.q, 'Judul Hilang');
    assert.strictEqual(c.obj.rows, 0);
    assert.deepStrictEqual(c.obj.keys, []);
    assert.strictEqual(c.obj.ep, null);
    assert.ok(bot.sent.join().includes('Tidak ada file Vidoy cocok'), 'pesan user harus tetap sama');
    return `gagal: ${JSON.stringify(c.obj)}`;
  });
});

t('!vdell query — sukses: media_key tiap row tercatat', () => {
  const logger = stubLogger();
  const bot = stubBot();
  return run(BLK_VDELL_QUERY, {
    logger, bot, chatId: -100, escHtml, titleQ: 'Naruto Shippuuden', hasEp: true, epNum: 2,
    findVidoyRecords: async () => ([
      { media_key: 'Naruto Shippuuden', kind: 'anime', part: 2 },
      { media_key: 'Naruto Shippuuden', kind: 'anime', part: 3 },
    ]),
  }).then(() => {
    const c = logger.find('!vdell query');
    assert.strictEqual(c.obj.rows, 2);
    assert.strictEqual(c.obj.ep, 2);
    assert.deepStrictEqual(c.obj.keys, ['Naruto Shippuuden', 'Naruto Shippuuden']);
    return `sukses: ${JSON.stringify(c.obj)}`;
  });
});

// ── blok 4+5: vdel_confirm (log per-record + rekap sisa) ────────────────────
// WAJIB mulai dari require-nya: `VidoyUploader` dipakai di dalam loop. Kalau
// baris ini tidak ikut terekstrak, hasilnya ReferenceError yang tertangkap
// `catch` → okDel selalu false → titik log tidak pernah tercapai, dan test
// justru terlihat hijau.
const BLK_VDEL_CONFIRM = extract(
  "const VidoyUploader = require('./vidoy-uploader');",
  "}, '!vdell selesai');",
);

/** Baris Vidoy yang punya filecode valid supaya deleteItem terpanggil. */
function vidoyRow(part, extra) {
  return Object.assign({
    media_key: 'Naruto Shippuuden', kind: 'anime', part,
    link: 'https://vski.cc/e/abc123', dashboard: 'https://vidoy.asia/view/abc123',
    tg_chat_id: -100, tg_message_id: 500 + part, tg_message_id_present: true,
  }, extra || {});
}

function vdelScope(over) {
  return Object.assign({
    logger: stubLogger(),
    bot: stubBot(),
    escHtml, chatId: -100, msgId: 1,
    pend: { titleQ: 'Naruto Shippuuden', ep: null, adminId: 1 },
    require: () => ({ deleteItem: async () => ({ ok: true }) }),
    findVidoyRecords: async () => [],
    deleteVidoyRecord: async () => 1,
  }, over || {});
}

t('!vdell hapus record — media_key/part/link/pointer tercatat sebelum delete', () => {
  const sc = vdelScope({ findVidoyRecords: async () => ([vidoyRow(1)]) });
  return run(BLK_VDEL_CONFIRM, sc).then(() => {
    const c = sc.logger.find('!vdell hapus record');
    assert.ok(c, '!vdell hapus record tidak dipanggil');
    assert.strictEqual(c.obj.media_key, 'Naruto Shippuuden');
    assert.strictEqual(c.obj.kind, 'anime');
    assert.strictEqual(c.obj.part, 1);
    assert.strictEqual(c.obj.link, 'https://vski.cc/e/abc123');
    assert.strictEqual(c.obj.tg_message_id, 501);
    return `record: ${JSON.stringify(c.obj)}`;
  });
});

t('!vdell hapus record — TIDAK dilog kalau file fisik gagal dihapus', () => {
  const sc = vdelScope({
    require: () => ({ deleteItem: async () => ({ ok: false, error: '404 not found' }) }),
    findVidoyRecords: async () => ([vidoyRow(1)]),
  });
  return run(BLK_VDEL_CONFIRM, sc).then(() => {
    assert.strictEqual(sc.logger.find('!vdell hapus record'), undefined,
      'record tidak boleh dihapus/dilog kalau file fisik gagal');
    const c = sc.logger.find('!vdell selesai');
    assert.strictEqual(c.obj.terhapus, 0, 'terhapus harus 0');
    assert.strictEqual(c.obj.gagal, 1);
    return `file gagal → ${JSON.stringify(c.obj)}`;
  });
});

t('!vdell selesai — sisa=0 membuktikan record benar-benar hilang', () => {
  let call = 0;
  const sc = vdelScope({
    findVidoyRecords: async () => {
      call++;
      return call === 1 ? [vidoyRow(1), vidoyRow(2)] : [];
    },
  });
  return run(BLK_VDEL_CONFIRM, sc).then(() => {
    const c = sc.logger.find('!vdell selesai');
    assert.ok(c, '!vdell selesai tidak dipanggil');
    assert.strictEqual(c.obj.terhapus, 2, 'dua record harus terhapus');
    assert.strictEqual(c.obj.sisa, 0, 'sisa harus 0');
    assert.strictEqual(c.obj.dari, 2);
    assert.ok(call >= 2, 'harus query ulang SETELAH delete (call ke-2)');
    return `rekap: ${JSON.stringify(c.obj)} (query ${call}×)`;
  });
});

t('!vdell selesai — sisa>0 terekspos (record ternyata tidak hilang)', () => {
  let call = 0;
  const sc = vdelScope({
    // delete selalu sukses tapi record tidak benar hilang → sisa harus 1
    findVidoyRecords: async () => { call++; return [vidoyRow(1)]; },
    deleteVidoyRecord: async () => 0,
  });
  return run(BLK_VDEL_CONFIRM, sc).then(() => {
    const c = sc.logger.find('!vdell selesai');
    assert.strictEqual(c.obj.terhapus, 0, 'tidak ada record yang terhapus');
    assert.strictEqual(c.obj.sisa, 1, 'sisa harus 1 — inilah yang tak terlihat sebelumnya');
    assert.strictEqual(c.obj.fileTerhapus, 1, 'file fisik terhapus tapi record tidak');
    return `kondisi bermasalah jadi terlihat: ${JSON.stringify(c.obj)}`;
  });
});

t('blok yang diuji benar-benar berasal dari bot.js (bukan salinan)', () => {
  assert.ok(BLK_DELL_QUERY.includes("'!dell query'"), 'blok !dell query tidak sinkron');
  assert.ok(BLK_DELL_QUERY.includes('findMediaByName(mediaName)'), 'blok !dell query berubah');
  assert.ok(BLK_DELL_DELETE.includes('await deleteMedia(pending.slug);'), 'blok !dell delete tidak sinkron');
  assert.ok(BLK_VDELL_QUERY.includes("'!vdell query'"), 'blok !vdell query tidak sinkron');
  assert.ok(BLK_VDEL_CONFIRM.includes("'!vdell selesai'"), 'blok vdel_confirm tidak sinkron');
  assert.ok(BLK_VDEL_CONFIRM.includes("require('./vidoy-uploader')"), 'require VidoyUploader hilang dari blok');
  return `5 blok diekstrak langsung dari bot.js`;
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
