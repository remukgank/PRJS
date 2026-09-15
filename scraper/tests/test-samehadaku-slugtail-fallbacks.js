/**
 * test-samehadaku-slugtail-fallbacks.js — dua perbaikan worker /samehadaku:
 *
 * 1. Slug-tail: samehadaku kadang me-list episode dengan href /<slug>-<N>/ TANPA -episode-,
 *    mis. Dragon Ball Heroes ep 20-42 = /super-dragon-ball-heroes-<N>/. Pagar #1: pola
 *    slug-angka hanya diambil dari dalam blok <div class="lstepsiode"> (bukan link lain di
 *    halaman). Dulu worker cuma menangkap 27/50 ep.
 * 2. Fallback kualitas: halaman episode lama (mis. ep 1 DB Heroes, 2019) tidak punya
 *    FULLHD/4K — hanya 360p/720p. Pagar #2: scan qualityOrder penuh, dan label kualitas
 *    yang dikembalikan JUJUR (dari tag <strong>), bukan asumsi "FULLHD".
 *
 * Tanpa network: fixture HTML asli (kaptur curl) disajikan via global.fetch mock.
 *
 * Usage: node scraper/tests/test-samehadaku-slugtail-fallbacks.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures', 'samehadaku');
const WORKER = path.join(__dirname, '..', '..', 'gofile-worker.js');

function loadFixture(name) {
  return fs.readFileSync(path.join(FIX, name), 'utf8');
}

async function loadWorker() {
  const tmp = path.join(os.tmpdir(), `gofile-worker-test-${Date.now()}.mjs`);
  fs.copyFileSync(WORKER, tmp);
  const mod = await import('file://' + tmp);
  return mod.default;
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

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

(async () => {
  console.log('== load worker ==');
  const worker = await loadWorker();
  ok(!!worker && typeof worker.fetch === 'function', 'worker load ESM');

  console.log('== A. Dragon Ball Heroes anime: slug-tail ep 20-42 tertangkap (total 50) ==');
  const rA = await freshWorkerFetch(worker, loadFixture('dbheros-anime.html'), 'https://v2.samehadaku.how/anime/dragon-ball-heroes/');
  const a = await rA.json();
  ok(a.ok === true && a.type === 'anime', 'type=anime');
  const epsA = a.episodes || [];
  ok(epsA.length === 50, `total 50 ep (${epsA.length})`);
  const numsA = epsA.map((e) => e.ep);
  ok(new Set(numsA).size === 50, 'tanpa duplikat ep');
  ok(numsA.every((n) => n >= 1 && n <= 50), 'semua ep dalam 1..50');
  const ep20 = epsA.find((e) => e.ep === 20);
  ok(ep20?.url.includes('super-dragon-ball-heroes-20/'), `ep20 url slug-tail (${ep20?.url})`);
  const ep31 = epsA.find((e) => e.ep === 31);
  ok(/super-dragon-ball-heroes-31\/$/.test(ep31?.url || ''), `ep31 url slug-tail (${ep31?.url})`);
  const ep42 = epsA.find((e) => e.ep === 42);
  ok(/super-dragon-ball-heroes-42\/$/.test(ep42?.url || ''), `ep42 url slug-tail (${ep42?.url})`);
  const ep1 = epsA.find((e) => e.ep === 1);
  ok(/dragon-ball-heroes-episode-1\/$/.test(ep1?.url || ''), `ep1 tetap -episode-1/ (${ep1?.url})`);
  const ep50 = epsA.find((e) => e.ep === 50);
  ok(/super-dragon-ball-heroes-episode-50\/$/.test(ep50?.url || ''), `ep50 tetap -episode-50/ (${ep50?.url})`);
  ok(epsA.every((e) => e.url && e.url.startsWith('http')), 'semua url absolut');
  ok(epsA.every((e) => e.title && /[A-Za-z]/.test(e.title)), 'title non-numerik (pilih anchor judul)');
  const missing = [];
  for (let n = 1; n <= 50; n++) if (!epsA.find((e) => e.ep === n)) missing.push(n);
  ok(missing.length === 0, `semua ep 1..50 ada (hilang: ${missing.join(',') || '-'})`);

  console.log('== B. DB Heroes ep1 (2019, tanpa FULLHD/4K): fallback 720p + label jujur ==');
  const rB = await freshWorkerFetch(worker, loadFixture('dbheros-ep1.html'), 'https://v2.samehadaku.how/dragon-ball-heroes-episode-1/');
  const b = await rB.json();
  ok(b.ok === true && b.type === 'episode', 'type=episode untuk halaman ep1');
  ok(b.quality === '720p', `quality jujur = 720p (${b.quality}) — bukan FULLHD bohongan`);
  ok(b.servers && Object.keys(b.servers).length >= 2, `servers non-empty (${Object.keys(b.servers || {}).join(',')})`);
  ok(b.blocks?.['720p'] && Object.keys(b.blocks['720p']).length, 'blocks[720p] terisi');
  ok(b.blocks?.['360p'] && Object.keys(b.blocks['360p']).length, 'blocks[360p] terisi');
  ok(b.servers?.zippyshare || Object.keys(b.servers || {}).some((k) => k.includes('zippy')), 'zippyshare tertangkap (hostname slug)');

  console.log('== C. regresi: FULLHD tetap diprioritaskan saat ada ==');
  const rC = await freshWorkerFetch(worker, loadFixture('mynoghra-ep1.html'), 'https://v2.samehadaku.how/dragon-ball-heroes-episode-1/');
  const c = await rC.json();
  ok(c.ok === true && c.type === 'episode', 'type=episode');
  ok(c.quality === 'FULLHD', `FULLHD tetap jadi pilihan utama (${c.quality})`);
  ok(!!c.servers.gofile && !!c.servers.krakenfiles, 'gofile+krakenfiles terbaca');

  console.log('== D. regresi: anime normal (tensura) tak terpengaruh slug-tail ==');
  const rD = await freshWorkerFetch(worker, loadFixture('tensei-anime.html'), 'https://v2.samehadaku.how/anime/tensei-shitara-slime-datta-ken-season-4/');
  const d = await rD.json();
  const epsD = d.episodes || [];
  ok(d.ok === true && d.type === 'anime', 'type=anime');
  ok(epsD.length === 22, `tensura tetap 22 (${epsD.length})`);
  ok(new Set(epsD.map((e) => e.ep)).size === epsD.length, 'tanpa duplikat (slug -season-4/-part tak ikut tertangkap)');
  ok(epsD.every((e) => e.ep >= 1 && e.ep <= 22), 'ep dalam 1..22');

  console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('ERROR:', err && err.stack || err);
  process.exit(1);
});