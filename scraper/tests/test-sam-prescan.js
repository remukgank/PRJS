'use strict';

// Unit test: pre-flight server scan (sam_all) — skip ep tanpa host didukung + reuse hasil scan.

const assert = require('assert');
const { scanSupportedServers, viableFromScanned } = require('../lib/samPrescan');
const { pickBestServerList } = require('../handlers/download');

let failed = 0;
const t = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
};

const queue = Array.from({ length: 10 }, (_, i) => ({ ep: i + 1, url: `https://v2.samehadaku.how/x-episode-${i + 1}/` }));

t('scan: ep dgn server didukung lolos, sisanya skip', async () => {
  const resolveFn = async (url) => {
    const ep = Number(url.match(/episode-(\d+)/)[1]);
    if (ep === 1) return { servers: { gofile: 'g', filedon: 'f' }, quality: '4K' };
    if (ep === 5) return { servers: { pixeldrain: 'p' }, quality: '720p' };
    if (ep === 10) return { servers: { filedon: 'x' }, quality: 'FULLHD' };
    if (ep === 7) throw new Error('no FULLHD/4K servers found'); // worker error -> skip
    return { servers: { reupload: 'r', acefile: 'a' }, quality: '360p' }; // tak didukung
  };
  const scanned = await scanSupportedServers(queue, resolveFn, { concurrency: 4 });
  assert.strictEqual(scanned.size, 10);
  const viable = viableFromScanned(queue, scanned, pickBestServerList);
  assert.deepStrictEqual(viable.map((e) => e.ep), [1, 5, 10]);
});

t('scan: concurrency membatasi resolve paralel', async () => {
  let active = 0, peak = 0;
  const resolveFn = async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 3)); active--; return { servers: {} }; };
  await scanSupportedServers(queue, resolveFn, { concurrency: 3 });
  assert.ok(peak <= 3, `puncak paralel ${peak} > 3`);
});

t('queue kosong / concurrency 0 aman', async () => {
  const s0 = await scanSupportedServers([], async () => ({}), { concurrency: 5 });
  assert.strictEqual(s0.size, 0);
  const s1 = await scanSupportedServers(queue, async () => ({}), { concurrency: 0 });
  assert.strictEqual(s1.size, 0);
});

console.log(process.exitCode = failed, '\n');
console.log(process.exitCode ? 'ADA YANG GAGAL' : 'Semua test OK');
process.exit(failed ? 1 : 0);