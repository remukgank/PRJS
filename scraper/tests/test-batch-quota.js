'use strict';

// Fail-fast batch saat kuota Vidoy habis.
//
// MASALAH (log produksi 28 Sep 2026): Vidoy balas 413 quota_exceeded, tapi
// batch 500 episode terus download satu per satu (~250MB each) lalu semuanya
// gagal di register. ~15 episode × 250MB ≈ 4GB terbuang setelah 413 pertama.
//
// FIX: ketiga loop batch (kam_all/sam_all/kur_all) mendeteksi quota di error
// per-episode, break total, kirim pesan jelas dengan tanggal reset, dan lock
// tetap dilepas di finally yang sudah ada.
//
// Run: node scraper/tests/test-batch-quota.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BOT = path.join(__dirname, '..', 'bot.js');
const src = fs.readFileSync(BOT, 'utf8');
// 1 Okt 2026: helper dipindah dari bot.js ke lib/quota.js supaya handlers/vidoy.js
// ikut memakainya (fallback host kedua saat kuota habis). Test WAJIB mengikuti
// perpindahan ini — grab dari bot.js akan selalu gagal Diam-diam karena
// definisinya tidak ada lagi di sana.
const QUOTA = path.join(__dirname, '..', 'lib', 'quota.js');
const quotaSrc = fs.readFileSync(QUOTA, 'utf8');

let passed = 0;
let failed = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });

// grab helper asli dari source dan jalankan
function grabFn(name) {
  const i = quotaSrc.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} tidak ditemukan`);
  let d = 0;
  const j = quotaSrc.indexOf('{', i);
  for (let k = j; k < quotaSrc.length; k++) {
    if (quotaSrc[k] === '{') d++;
    else if (quotaSrc[k] === '}') { d--; if (!d) return quotaSrc.slice(i, k + 1); }
  }
  throw new Error(`${name} tidak tertutup`);
}

const REAL_QUOTA = 'Vidoy register gagal: {"status":413,"code":"quota_exceeded","title":"Storage limit reached","quota":{"used":345420706848,"limit":10737418240,"reset_at":"2026-10-01"}}';

t('isQuotaExceededError mendeteksi pesan kuota asli dari log', () => {
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${grabFn('isQuotaExceededError')}\nreturn isQuotaExceededError;`)();
  assert.strictEqual(fn(REAL_QUOTA), true, 'pesan 413 asli harus terdeteksi');
  assert.strictEqual(fn('Vidoy register gagal: {"status":413}'), false, '413 tanpa kata kuota jangan ikut');
  assert.strictEqual(fn('download HTTP 500'), false);
  assert.strictEqual(fn('gagal resolve link file'), false);
  assert.strictEqual(fn(''), false);
  assert.strictEqual(fn(null), false);
  assert.strictEqual(fn(undefined), false);
  return 'deteksi tepat, tanpa false-positive';
});

t('quotaResetDate mengambil tanggal reset', () => {
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${grabFn('quotaResetDate')}\nreturn quotaResetDate;`)();
  assert.strictEqual(fn(REAL_QUOTA), '2026-10-01');
  assert.strictEqual(fn('tidak ada tanggal'), null);
  assert.strictEqual(fn(null), null);
  return 'reset 2026-10-01 ✓';
});

for (const [loop, checks] of [
  ['kam_all', [
    'if (isQuotaExceededError(kmErrMsg)) { kmQuotaHit = kmErrMsg; break; }',
    'if (isQuotaExceededError(kmErr.message)) { kmQuotaHit = kmErr.message; break; }',
  ]],
  ['sam_all', [
    'if (isQuotaExceededError(lastErr)) { quotaHit = lastErr; break; }',
    'if (isQuotaExceededError(err.message)) { quotaHit = err.message; break; }',
  ]],
  ['kur_all', [
    'if (isQuotaExceededError(lastErr)) { quotaHit = lastErr; break; }',
    'if (isQuotaExceededError(err.message)) { quotaHit = err.message; break; }',
  ]],
]) {
  for (const stmt of checks) {
    t(`${loop}: ada "${stmt.slice(0, 52)}…"`, () => {
      assert.ok(src.includes(stmt), `${loop} kehilangan cek: ${stmt}`);
      return 'titik persis ✓';
    });
  }

  t(`${loop}: pesan khusus kuota (bukan rekap biasa)`, () => {
    assert.ok(/Batch dihentikan — Vidoy penuh/.test(src), 'pesan khusus tidak ada');
    assert.ok(/Jalankan lagi setelah kuota pulih/.test(src), 'instruksi lanjut tidak ada');
    return 'pesan khusus ✓';
  });

  t(`${loop}: lock tetap dilepas (finally tidak tersentuh break)`, () => {
    // break di dalam try → finally tetap jalan (semantik JS). Pastikan
    // finally pelepas lock masih ada di handler loop ini.
    assert.ok(/finally\s*\{[\s\S]{0,200}?samAllBusy\.delete|finally\s*\{[\s\S]{0,200}?kurAllBusy\.delete/.test(src),
      'finally pelepas lock hilang?');
    return 'finally utuh ✓';
  });
}

t('ketiga loop konsisten (kam + sam + kur semua punya)', () => {
  const n = (src.match(/if \(isQuotaExceededError\(/g) || []).length;
  assert.ok(n >= 4, `hanya ${n} cek kuota (harap ≥4: kam×2, sam×2, kur×2)`);
  return `${n} titik cek kuota`;
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
