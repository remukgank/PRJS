'use strict';

// Verifikasi terminalKeys logger (proposal 2026-09-27-logger-terminalkeys-test-summary.md).
//
// MASALAH: scraper/logger.js hanya mencetak field whitelisted ke terminal. Semua
// field baru dari commit f4428ca (query & hasil !dell/!vdell) tidak ada di
// whitelist, jadi di `pm2 logs` yang terlihat cuma `msg` + `chatId`. Informasi
// paling berguna (berapa baris ketemu, berapa record tersisa setelah delete)
// hanya ada di logs/app.log — padahal itu yang perlu dibaca cepat saat debug.
//
// Test ini menjalankan logger ASLI (bukan replika) sambil menangkap
// process.stdout.write, lalu memeriksa baris terminal yang benar-benar dicetak.
//
// Run: node scraper/tests/test-logger-terminal-keys.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const LOG_JS = path.join(__dirname, '..', 'logger.js');
const logSrc = fs.readFileSync(LOG_JS, 'utf8');

let passed = 0;
let failed = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });

/** Jalankan satu skenario log sungguhan, tangkap apa yang ditulis ke terminal. */
function emit(obj, msg) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  let logger;
  try {
    // logger dimuat sekali; multistream menulis saat pemanggilan, bukan saat require
    if (!emit._logger) {
      // eslint-disable-next-line global-require
      const mod = require(LOG_JS);
      emit._logger = mod.logger;
    }
    logger = emit._logger;
    logger[obj.__level || 'info'](obj, msg);
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

/** Ambil daftar field yang benar-benar tercetak di baris terminal. */
function fieldsIn(line) {
  const out = {};
  const tail = line.slice(line.indexOf('  ·  ') + 4);
  if (!tail.trim()) return out;
  for (const tok of tail.split(/\s+(?=[a-zA-Z_$][\w$]*=)/)) {
    const i = tok.indexOf('=');
    if (i > 0) out[tok.slice(0, i)] = tok.slice(i + 1);
  }
  return out;
}

const REQUIRED = ['q', 'hasil', 'slugs', 'rows', 'keys', 'media_key', 'terhapus',
  'sisa', 'dari', 'fileTerhapus', 'gagal', 'part', 'ep'];

t('semua field wajib ada di array terminalKeys logger.js', () => {
  const m = /const terminalKeys = \[([\s\S]*?)\];/.exec(logSrc);
  assert.ok(m, 'terminalKeys tidak ditemukan di logger.js');
  const declared = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const missing = REQUIRED.filter((k) => !declared.includes(k));
  assert.deepStrictEqual(missing, [],
    `field wajib belum masuk whitelist: ${missing.join(', ')}`);
  return `${REQUIRED.length} field wajib ada (total whitelist ${declared.length})`;
});

t('!dell query — q/hasil/slugs/part/ep MUNCUL di baris terminal', () => {
  const line = emit({ chatId: -100, ep: 1, part: 1, q: 'Naruto Shippuuden', hasil: 0, slugs: [] }, '!dell query');
  assert.ok(line.includes('!dell query'), `baris terminal salah: ${JSON.stringify(line)}`);
  const f = fieldsIn(line);
  for (const k of ['q', 'hasil', 'slugs', 'part', 'ep']) {
    assert.ok(k in f, `${k} tidak tercetak di terminal — baris: ${line.trim()}`);
  }
  assert.strictEqual(f.q, 'Naruto Shippuuden');
  assert.strictEqual(f.hasil, '0');
  assert.strictEqual(f.slugs, '[]', 'array kosong harus tampil jelas sebagai []');
  assert.ok(!line.includes('{'), 'baris terminal tidak boleh berisi JSON');
  return line.trim();
});

t('!vdell query — rows/keys/ep MUNCUL di baris terminal', () => {
  // !vdell query memang TIDAK mengirim `part` (yang punya part = !vdell hapus
  // record)..Assert `part` di sini dulu salah dan sempat FAIL.
  const line = emit({ chatId: -100, ep: 2, rows: 2, keys: ['Naruto Shippuuden'] }, '!vdell query');
  const f = fieldsIn(line);
  for (const k of ['rows', 'keys', 'ep']) {
    assert.ok(k in f, `${k} tidak tercetak di terminal — baris: ${line.trim()}`);
  }
  assert.strictEqual(f.rows, '2');
  assert.strictEqual(f.keys, '[Naruto Shippuuden]');
  return line.trim();
});

t('!vdell selesai — terhapus/sisa/dari/fileTerhapus/gagal MUNCUL', () => {
  const line = emit({ chatId: -100, terhapus: 2, sisa: 0, dari: 2, fileTerhapus: 2, gagal: 0 }, '!vdell selesai');
  const f = fieldsIn(line);
  for (const k of ['terhapus', 'sisa', 'dari', 'fileTerhapus', 'gagal']) {
    assert.ok(k in f, `${k} tidak tercetak di terminal — baris: ${line.trim()}`);
  }
  // nilai 0 WAJIB tampil — ini justru kasus yang paling perlu terlihat
  assert.strictEqual(f.sisa, '0', 'sisa=0 harus tampil, bukan disembunyikan');
  assert.strictEqual(f.gagal, '0');
  return line.trim();
});

t('!vdell hapus record — media_key/part MUNCUL', () => {
  const line = emit({ chatId: -100, media_key: 'Naruto Shippuuden', part: 1 }, '!vdell hapus record');
  const f = fieldsIn(line);
  for (const k of ['media_key', 'part']) {
    assert.ok(k in f, `${k} tidak tercetak di terminal — baris: ${line.trim()}`);
  }
  return line.trim();
});

t('field yang TIDAK di whitelist tidak bocor ke terminal', () => {
  const line = emit({ chatId: -100, q: 'X', BOCOR_PNG: 'jangan tampil', secretToken: 'rahasia123' }, 'uji bocor');
  assert.ok(!line.includes('BOCOR_PNG'), 'field di luar whitelist bocor ke terminal');
  assert.ok(!line.includes('rahasia123'), 'nilai field di luar whitelist bocor ke terminal');
  assert.ok(!line.includes('secretToken'), 'nama field di luar whitelist bocor ke terminal');
  assert.ok(line.includes('q=X'), 'field whitelist tetap harus tampil');
  return line.trim();
});

t('progres unduhan tetap tampil (whitelist lama tidak rusak)', () => {
  const line = emit({ chatId: -100, ep: 5, title: 'Naruto Shippuuden', mb: 43.7, kbps: 0 }, 'download progres');
  const f = fieldsIn(line);
  for (const k of ['mb', 'kbps', 'ep', 'title']) {
    assert.ok(k in f, `${k} hilang — whitelist lama rusak: ${line.trim()}`);
  }
  return line.trim();
});

t('err tetap tampil sebagai "!" dan tidak jadi key=value', () => {
  const line = emit({ chatId: -100, q: 'X', err: 'download macet' }, 'ensureMp4 gagal');
  assert.ok(line.includes('! download macet'), `err tidak tampil: ${line.trim()}`);
  const f = fieldsIn(line);
  assert.ok(!('err' in f), 'err tidak boleh muncul sebagai key=value (sudah dipakai "!" )');
  return line.trim();
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
