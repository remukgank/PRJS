/**
 * test-failfast-provider-down.js — Fail-fast batch saat provider down global.
 *
 * Tanpa network/live provider: resolveVideoUrl di-mock.
 * Usage: node scraper/tests/test-failfast-provider-down.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  providerDownSig, providerDownVerdict, providerDownSerialMsg, pushStreak, downloadChunk,
} = require('../services/vidaraService');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

(async () => {
  console.log('== providerDownSig ==');
  ok(providerDownSig('Request failed with status code 502') === 'HTTP 502', '502');
  ok(providerDownSig('HTTP 503 Service Unavailable') === 'HTTP 503', '503');
  ok(providerDownSig('504 gateway timeout') === 'HTTP 504', '504');
  ok(providerDownSig('ReelFren API: invalid response') === 'invalid response', 'invalid response');
  ok(providerDownSig('video URL kosong Ep 7') === 'video URL kosong', 'kosong + strip nomor ep');
  ok(providerDownSig('timeout of 20000ms exceeded') === 'timeout/jaringan', 'timeout');
  ok(providerDownSig('HLS→mp4 gagal: boom') === null, 'HLS gagal bukan sinyal down');
  ok(providerDownSig('ffmpeg concat gagal (copy & re-encode)') === null, 'ffmpeg bukan sinyal down');
  ok(providerDownSig('File di-takedown DMCA (HTTP 451)') === null, '451 bukan 502/503/504');
  ok(providerDownSig('') === null && providerDownSig(null) === null, 'kosong -> null');

  console.log('== pushStreak ==');
  ok(JSON.stringify(pushStreak([], 'HTTP 502')) === '["HTTP 502"]', 'start streak');
  ok(pushStreak(['HTTP 502', 'HTTP 502'], 'HTTP 502').length === 3, 'lanjut streak -> 3 (vonis)');
  ok(JSON.stringify(pushStreak(['HTTP 502'], 'timeout/jaringan')) === '["timeout/jaringan"]', 'reset bila beda');
  ok(pushStreak(['HTTP 502'], null).length === 0, 'reset bila null');
  ok(pushStreak([], null).length === 0, 'null dari kosong');

  console.log('== providerDownVerdict (T1-T3) ==');
  const mkErrs = (arr) => arr.map((error) => ({ error }));
  // T1: 10/10 identik -> vonis
  const t1 = providerDownVerdict(mkErrs(Array(10).fill('video URL kosong')), 10, 'dramanova');
  ok(t1 instanceof Error && /Provider dramanova down \(10\/10:URL kosong\), coba lagi nanti/.test(t1.message), 'T1 vonis 10/10 identik');
  ok(t1 && t1.message.length <= 60, `T1 pesan <=60 char (${t1.message.length})`);
  // T2: 9/10 -> jalur lama (null)
  const t2errs = mkErrs(Array(9).fill('video URL kosong'));
  ok(providerDownVerdict(t2errs, 10, 'dramanova') === null, 'T2 9/10 -> null (jalur lama)');
  // T3: 10/10 campuran -> null
  const t3errs = mkErrs([...Array(9).fill('video URL kosong'), 'timeout of 20000ms exceeded']);
  ok(providerDownVerdict(t3errs, 10, 'dramanova') === null, 'T3 campuran -> null (jalur lama)');
  // Tepi: error non-down semua-identik -> null; kosong -> null
  ok(providerDownVerdict(mkErrs(Array(10).fill('HLS→mp4 gagal: x')), 10, 'dramanova') === null, 'non-down identik -> null');
  ok(providerDownVerdict([], 0, 'dramanova') === null, 'kosong -> null');

  console.log('== providerDownSerialMsg ==');
  const sm = providerDownSerialMsg('dramanova', 'HTTP 502');
  ok(/Provider dramanova down \(3 ep berurutan gagal: HTTP 502\)/.test(sm), 'format serial');
  ok(sm.length <= 80, `serial <=80 char (${sm.length})`);

  console.log('== downloadChunk T1-integration (mock resolve null x10) ==');
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-t1-'));
  let resolveCalls = 0;
  const chunk = Array.from({ length: 10 }, (_, i) => ({ ep: i + 1 }));
  const results = await downloadChunk(chunk, async () => { resolveCalls++; return null; }, stubDir, 10);
  const errors = results.filter((f) => typeof f !== 'string');
  ok(resolveCalls === 10, `resolve tepat 10x tanpa attempt ekstra (${resolveCalls})`);
  ok(errors.length === 10 && errors.every((e) => e.error === 'video URL kosong'), 'semua gagal identik');
  const v = providerDownVerdict(errors, chunk.length, 'dramanova');
  ok(v instanceof Error && v.message.includes('Provider dramanova down'), 'hook vonis di ujung fase paralel');
  fs.rmSync(stubDir, { recursive: true, force: true });

  console.log(`\nHASIL: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
