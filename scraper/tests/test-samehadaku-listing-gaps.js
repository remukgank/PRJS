'use strict';

// Regression test: kelengkapan listing episode Samehadaku (Cloudflare Worker).
//
// Insiden 26 Sep 2026 — listing Naruto Shippuden hanya menghasilkan 474 dari 500
// episode. Tiga penyebab terverifikasi dari HTML asli:
//   A. Halaman batch 2 episode: "-episode-N-M/" tidak ditangkap regex lama
//      (hanya "-episode-N/"), padahal halamannya berisi server.
//   B. Episode yang tidak di-link: ep 24 & 500 (500 hanya muncul di dalam
//      HTML comment) — ditutup dengan gap healing.
//   C. Slug beda ejaan per rentang: naruto-shippuuden (ep 1-250) vs
//      naruto-shippuden (ep 251-500).
//
// Dua jebakan yang WAJIB tidak ikut ter-expand (kalau regex longgar, worker
// mengarang episode yang tidak ada):
//   naruto-shippuuden-episode-23-2   (selisih -21)
//   naruto-shippuden-episode-467-2  (selisih -465)
//
// Tiga episode memang tidak pernah di-upload Samehadaku: 82, 465*, 466.
//   * 465 ternyata HIDUP (server 360p/480p/720p) dan memang sudah ada di listing,
//     jadi tidak termasuk bolong. Bolong sebenarnya hanya 82 & 466 → target 498.
//
// Worker diimpor sebagai modul (bukan dijalankan sebagai Worker) dengan
// global.fetch di-stub: listing memakai HTML sintetis, probe memakai
// halaman yang meniru ada/tidaknya server.
//
// Run: node scraper/tests/test-samehadaku-listing-gaps.js

const assert = require('assert');
const fs = require('fs');
const WORKER_PATH = require.resolve('../../gofile-worker');

const ORIGIN = 'https://v2.samehadaku.how';
const TARGET = `${ORIGIN}/anime/naruto-shippuden/`;

// 11 halaman batch 2 episode (N, N+1) — persis seperti HTML asli.
const BATCH = [[57, 58], [64, 65], [68, 69], [76, 77], [78, 79], [86, 87], [101, 102], [119, 120], [127, 128], [129, 130], [152, 153]];
// Pola yang menyerupai batch tapi BUKAN batch.
const TRAPS = ['naruto-shippuuden-episode-23-2', 'naruto-shippuden-episode-467-2'];
// Episode yang sengaja tidak di-link di listing.
const ABSENT_FROM_LISTING = [24, 82, 465, 466, 500];
// Episode yang URL-nya diganti pola jebakan (di listing asli tidak ada
// "/episode-23/" polos — yang ada hanya "episode-23-2").
const TRAP_ONLY = new Set([23, 467]);
// Episode yang ada di situs (untuk stub probe). 465 memang hidup (server
// 360p/480p/720p) — sempat disangka bolong karena tidak punya FULLHD/4K.
const EXISTS_ON_SITE = new Set([24, 465, 500]);
// Episode yang memang tidak pernah di-upload (semua varian slug → placeholder).
const NEVER_UPLOADED = [82, 466];

function slugFor(n) {
  return n <= 250 ? 'naruto-shippuuden' : 'naruto-shippuden';
}

function buildListingHtml() {
  const batchNums = new Set();
  for (const [a, b] of BATCH) {
    batchNums.add(a);
    batchNums.add(b);
  }
  const parts = ['<html><body><div class="lstepsiode"><ul>'];
  // Anchor memakai format judul seperti listing asli (bukan angka), supaya
  // logika "prefer anchor judul" ikut teruji.
  for (let n = 1; n <= 500; n++) {
    if (batchNums.has(n) || TRAP_ONLY.has(n) || ABSENT_FROM_LISTING.includes(n)) continue;
    parts.push(`<a href="${ORIGIN}/${slugFor(n)}-episode-${n}/">Naruto: Shippuuden Episode ${n}</a>`);
  }
  for (const [a, b] of BATCH) {
    parts.push(`<a href="${ORIGIN}/${slugFor(a)}-episode-${a}-${b}/">Naruto: Shippuuden Episode ${a}-${b}</a>`);
  }
  // Jebakan: slug standalone BUKAN episode, jadi tidak ikut ter-parse.
  for (const t of TRAPS) parts.push(`<a href="${ORIGIN}/${t}/">Naruto: Shippuuden OVA</a>`);
  parts.push('</ul></div>');
  // ep 500 hanya muncul di dalam HTML comment — tidak boleh ikut ter-parse.
  parts.push(`<!-- <div class="all-eps-btn"><a href="${ORIGIN}/naruto-shippuden-episode-500-selesai/">Naruto: Shippuden Episode 500 [Selesai]</a></div> -->`);
  parts.push('</body></html>');
  return parts.join('');
}

// Halaman episode palsu: ada server (FULLHD) bila episode hidup, placeholder bila tidak.
function episodePageHtml(exists) {
  if (!exists) return '<html><head><title>@samehadaku.care Facebook</title></head><body>placeholder</body></html>';
  return '<html><body><ul><li><strong>FULLHD</strong> <span><a href="https://gofile.io/d/abc123">Gofile</a></span></li>'
    + '<li><strong>720p</strong> <span><a href="https://reupload.com/v/xyz">Reupload</a></span></li></ul></body></html>';
}

async function main() {
  const worker = (await import(WORKER_PATH)).default;
  const listingHtml = buildListingHtml();

  let probeCount = 0;
  const probed = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, opts) => {
    const s = String(u);
    if (s === TARGET) return Promise.resolve({ ok: true, status: 200, text: async () => listingHtml });
    probeCount++;
    probed.push(s);
    const m = s.match(/-episode-(\d+)\/$/);
    const exists = m && EXISTS_ON_SITE.has(parseInt(m[1], 10));
    return Promise.resolve({ ok: true, status: 200, text: async () => episodePageHtml(exists) });
  };

  let passed = 0;
  let failed = 0;
  const t = (name, fn) => {
    try {
      fn();
      console.log(`PASS  ${name}`);
      passed++;
    } catch (e) {
      failed++;
      console.error(`FAIL  ${name}: ${e.message}`);
    }
  };

  const call = async () => {
    const res = await worker.fetch(
      { url: `https://w.example/samehadaku?url=${encodeURIComponent(TARGET)}` },
      { CF_CLEARANCE: '' },
    );
    return (await res.json()).episodes;
  };

  const eps = await call();
  const by = (n) => eps.find((e) => e.ep === n);
  const has = (n) => !!by(n);

  t('total episode = 498 (500 - 2 yang memang tidak ada)', () => {
    assert.strictEqual(eps.length, 498, `dapat ${eps.length}`);
  });

  t('batch 2 episode ter-expand (57 & 58, URL sama)', () => {
    assert.ok(has(57) && has(58));
    assert.strictEqual(by(57).url, by(58).url);
    assert.strictEqual(by(57).url, `${ORIGIN}/naruto-shippuuden-episode-57-58/`);
  });

  t('judul tiap episode batch dibedakan', () => {
    assert.strictEqual(by(57).title, 'Naruto: Shippuuden Episode 57');
    assert.strictEqual(by(58).title, 'Naruto: Shippuuden Episode 58');
    assert.notStrictEqual(by(57).title, by(58).title);
  });

  t('jebakan episode-23-2 TIDAK mengarang ep lain', () => {
    assert.ok(by(23), 'ep 23 harus ada');
    assert.ok(by(23).url.includes('episode-23-2'), 'ep 23 memakai URL aslinya');
    const from23 = eps.filter((e) => e.url.includes('episode-23-2'));
    assert.deepStrictEqual(from23.map((e) => e.ep), [23], `URL 23-2 dipakai ep lain: ${from23.map((e) => e.ep)}`);
  });

  t('jebakan episode-467-2 TIDAK mengarang ep lain', () => {
    assert.ok(by(467), 'ep 467 harus ada');
    const from467 = eps.filter((e) => e.url.includes('episode-467-2'));
    assert.deepStrictEqual(from467.map((e) => e.ep), [467], `URL 467-2 dipakai ep lain: ${from467.map((e) => e.ep)}`);
  });

  t('ep 500 TIDAK diambil dari HTML comment', () => {
    const e500 = by(500);
    assert.ok(e500, 'ep 500 harus ada');
    assert.ok(!/selesai/i.test(e500.url), `ep 500 tidak boleh dari comment: ${e500.url}`);
    assert.strictEqual(e500.url, `${ORIGIN}/naruto-shippuden-episode-500/`);
  });

  t('gap healing menemukan ep 24 (ejaan double-u)', () => {
    assert.ok(by(24));
    assert.strictEqual(by(24).url, `${ORIGIN}/naruto-shippuuden-episode-24/`);
  });

  t('episode yang tidak pernah di-upload TIDAK muncul', () => {
    for (const n of NEVER_UPLOADED) assert.ok(!has(n), `ep ${n} tidak boleh ada`);
  });

  // Batas user: maksimal 5 NOMOR per listing (bukan 5 request — satu nomor
  // boleh sampai 2 request bila ejaan slug-nya perlu dicoba).
  const probedNums = new Set(probed.map((u) => parseInt((u.match(/-episode-(\d+)\/$/) || [])[1], 10)));
  t('guard expand: hanya bila M == N+1 (anti mengarang episode)', () => {
    const src = fs.readFileSync(WORKER_PATH, 'utf8');
    assert.ok(/numPair\s*!==\s*null\s*&&\s*numPair\s*===\s*num\s*\+/.test(src),
      'worker harus hanya meng-expand batch bila M == N+1 — tanpa ini, episode-23-2 / episode-467-2 ikut ter-expand');
  });

  t('budget probe ≤ 5 nomor per listing', () => {
    assert.ok(probedNums.size <= 5, `probe ${probedNums.size} nomor > 5: ${[...probedNums].join(',')}`);
  });

  t('probe memakai ejaan slug yang benar (dari episode terdekat)', () => {
    const p24 = probed.find((u) => u.includes('-episode-24/'));
    const p500 = probed.find((u) => u.includes('-episode-500/'));
    assert.ok(p24 && p24.includes('naruto-shippuuden-episode-24/'), `probe 24: ${p24}`);
    assert.ok(p500 && p500.includes('naruto-shippuden-episode-500/'), `probe 500: ${p500}`);
  });

  // ── cache: panggil ulang, probe tidak boleh diulang ──
  const before = probeCount;
  const eps2 = await call();
  t('cache per listing: panggil ulang tidak probe ulang', () => {
    assert.strictEqual(probeCount, before, `probe naik ${before} → ${probeCount}`);
    assert.strictEqual(eps2.length, eps.length);
  });

  globalThis.fetch = realFetch;

  console.log(`\n  (info) ${probeCount} probe request: ${probed.join(' | ')}`);
  console.log(`\n${passed} pass / ${failed} fail`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
