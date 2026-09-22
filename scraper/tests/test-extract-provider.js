'use strict';

// Unit test: extractProvider — bug "Provider :- unknown" utk file Samehadaku *.CARE/*.VIP.

const assert = require('assert');
const { extractProvider } = require('../lib/parser');

let failed = 0;
const t = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
};

t('SAMEHADAKU.CARE / .VIP dikenali', () => {
  assert.strictEqual(extractProvider('OP-1124-4K-SAMEHADAKU.CARE.mp4'), 'samehadaku');
  assert.strictEqual(extractProvider('Naruto-70-360p-SAMEHADAKU.CARE.mp4'), 'samehadaku');
  assert.strictEqual(extractProvider('TSSDK-S2-1-FULLHD-SAMEHADAKU.VIP.mp4'), 'samehadaku');
  assert.strictEqual(extractProvider('x-samehadaku.how.mp4'), 'samehadaku');
});

t('provider lain tetap terdeteksi seperti biasa', () => {
  assert.strictEqual(extractProvider('a-1080p-nIVJp5U-kuronime-blcktrch04.mp4'), 'kuronime');
  assert.strictEqual(extractProvider('shows-WINBU.ORG.mp4'), 'wibu.tv');
});

t('yang tidak dikenal tetap unknown', () => {
  assert.strictEqual(extractProvider('1080p-xk123x.mp4'), 'unknown');
  assert.strictEqual(extractProvider(''), 'unknown');
});

console.log(process.exitCode = failed, '\n');
console.log(process.exitCode ? 'ADA YANG GAGAL' : 'Semua test OK');
process.exit(failed ? 1 : 0);