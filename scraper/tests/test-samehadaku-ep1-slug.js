/**
 * test-samehadaku-ep1-slug.js — Ep 1 samehadaku yang href-nya = halaman <slug>/ (bukan -episode-1/).
 *
 * Kasus nyata: Isekai Mokushiroku Mynoghra — halaman anime me-list ep 1 dengan URL <slug>/
 * tanpa pola -episode-1 (yang umum untuk ep 2+). Worker lama melewatkannya; worker baru harus
 * menambahkannya TANPA merusak judul normal (ep1 = -episode-1/).
 *
 * Tanpa network: fixtures HTML kaptur di tests/fixtures/samehadaku/ disajikan ke worker
 * via global.fetch mock. Memuat worker sebagai ESM melalui salinan .mjs sementara.
 *
 * Usage: node scraper/tests/test-samehadaku-ep1-slug.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures', 'samehadaku');
const WORKER = path.join(__dirname, '..', '..', 'gofile-worker.js');

function loadFixture(name) {
  return fs.readFileSync(path.join(FIX, name), 'utf8');
}

// Muat worker ESM (export default { fetch }) sebagai modul lewat salinan .mjs.
async function loadWorker() {
  const tmp = path.join(os.tmpdir(), `gofile-worker-test-${Date.now()}.mjs`);
  fs.copyFileSync(WORKER, tmp);
  const mod = await import('file://' + tmp);
  return mod.default;
}

function makeWorkerFetch(fixtureRoutes) {
  return async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    const route = fixtureRoutes.find(([needle]) => url.includes(needle));
    if (!route) throw new Error(`fetch tak dimock: ${url}`);
    return new Response(route[1], { status: 200, headers: { 'content-type': 'text/html' } });
  };
}

function curried(worker, fixtureRoutes) {
  const prev = global.fetch;
  global.fetch = makeWorkerFetch(fixtureRoutes);
  try {
    return worker.fetch(new Request('https://worker-test.local/samehadaku?url=' + encodeURIComponent('https://v2.samehadaku.how/x')), {});
  } finally {
    global.fetch = prev;
  }
}

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}
function freshWorkerFetch(worker, html, target = 'https://v2.samehadaku.how/dummy') {
  const prev = global.fetch;
  global.fetch = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  try {
    return worker.fetch(new Request('https://worker-test.local/samehadaku?url=' + encodeURIComponent(target)), {});
  } finally {
    global.fetch = prev;
  }
}

(async () => {
  console.log('== load worker ==');
  const worker = await loadWorker();
  ok(!!worker && typeof worker.fetch === 'function', 'worker load ESM');

  console.log('== A. mynoghra (ep1 = /slug/, bug asli) ==');
  const rA = await freshWorkerFetch(worker, loadFixture('mynoghra-anime.html'), 'https://v2.samehadaku.how/anime/isekai-mokushiroku-mynoghra/');
  const a = await rA.json();
  ok(a.ok === true && a.type === 'anime', 'type=anime');
  const epsA = a.episodes || [];
  ok(epsA.some((e) => e.ep === 1), 'ep 1 MUNCUL');
  const ep1A = epsA.find((e) => e.ep === 1);
  ok(ep1A?.url === 'https://v2.samehadaku.how/isekai-mokushiroku-mynoghra/', `ep1 url = /slug/ (${ep1A?.url})`);
  ok(epsA.length === 13, `total 13 (${epsA.length})`);
  ok(!epsA.some((e) => e.ep === 0 || e.ep > 13), 'tanpa ep aneh');
  ok(epsA.every((e) => e.url && e.url.startsWith('http')), 'semua url absolut');

  console.log('== B. mynoghra ep1-page = /slug/ resolve episode ==');
  const rB = await freshWorkerFetch(worker, loadFixture('mynoghra-ep1.html'), 'https://v2.samehadaku.how/isekai-mokushiroku-mynoghra/');
  const b = await rB.json();
  ok(b.ok === true && b.type === 'episode', 'type=episode untuk halaman /slug/');
  ok(b.servers && !!b.servers.gofile, 'gofile ada');
  ok(b.servers && !!b.servers.krakenfiles, 'krakenfiles ada');
  ok(b.quality === 'FULLHD', 'quality FULLHD');

  console.log('== C. regresi: black-torch (ep1 normal = -episode-1/) ==');
  const rC = await freshWorkerFetch(worker, loadFixture('blacktorch-anime.html'), 'https://v2.samehadaku.how/anime/black-torch/');
  const c = await rC.json();
  const epsC = c.episodes || [];
  ok(epsC.some((e) => e.ep === 1), 'ep 1 tetap ada');
  ok(epsC.find((e) => e.ep === 1)?.url.includes('-episode-1/'), 'ep1 url tetap -episode-1/ (tak diduplikasi)');
  ok(epsC.length === (epsC[epsC.length - 1]?.ep || 0), 'jumlah = ep tertinggi (tak ada ep dobel)');

  console.log('== D. regresi: tensura S4 (ep1 normal) ==');
  const rD = await freshWorkerFetch(worker, loadFixture('tensei-anime.html'), 'https://v2.samehadaku.how/anime/tensei-shitara-slime-datta-ken-season-4/');
  const d = await rD.json();
  const epsD = d.episodes || [];
  ok(epsD.some((e) => e.ep === 1) && epsD.find((e) => e.ep === 1)?.url.includes('-episode-1/'), 'tensura ep1 normal utuh');
  ok(epsD.length === 22, `tensura total 22 (${epsD.length})`);
  ok(new Set(epsD.map((e) => e.ep)).size === epsD.length, 'tanpa duplikat ep');

  console.log('== E. movie/single: halaman ep-list semua -episode-N = movie tanpa link ==');
  // Halaman yg TIDAK memuat `-episode-N` sama sekali (single/movie) harus tetap jatuh ke
  // cabang download blocks (bukan menambahkan ep 1 palsu).
  const movieHtml = `
<html><body>
<div class="content-post">
<div class="download-eps" id="downloadb">
<ul>
<li><strong>FULLHD</strong> <span><a href="https://gofile.io/d/FAKESINGLE" target="_blank" rel="nofollow noopener noreferrer">Gofile</a></span></li>
</ul>
</div>
</div>
</body></html>`;
  const dummyMovieUrl = 'https://v2.samehadaku.how/anime/example-movie/';
  const rE = await freshWorkerFetch(worker, movieHtml, dummyMovieUrl);
  const e = await rE.json();
  ok(e.ok === true && e.type === 'episode', 'movie/single tetap episode (bukan anime)');
  ok(e.servers && !!e.servers.gofile, 'gofile single terbaca');
  ok(!e.episodes, 'tanpa daftar episode');

  console.log('== F. anti-false-positive: judul multi-ep ep1=/slug/ tanpa lchx Episode 1 ==');
  // pastikan fixture nyata tetap menghasilkan ep 2..13 dan TIDAK ada ep 1 duplikat dari cabang baru
  const epsSet = new Set(epsA.map((e) => e.ep));
  ok(epsSet.size === epsA.length, 'mynoghra tanpa duplikat ep');
  ok(epsA.filter((e) => e.ep === 1).length === 1, 'ep1 tepat 1 entri');

  console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('ERROR:', err && err.stack || err);
  process.exit(1);
});