'use strict';
// Regression test domain aktif Vidara (2 Okt 2026 — approve owner).
//
// Masalah: UI "🌐 Domain Vidara" janjikan "Domain akan dipakai untuk generate
// link embed https://<domain>/e/<filecode>", tapi implementasi mengutamakan
// respons API: caption anime & domain record = vidara.to, padahal
// bot_settings.vidara_active_domain = iosbgaigo.com (milik user).
//
// Fix (approve): activeDomain DIPRIORITASKAN di vidoy.js —
//   1. upload branch: out.vidaraLink = buildVideoLink({code, host: activeDomain})
//   2. host record    : activeDomain || v.host || …
//   3. rekonstruksi   : vidaraLinkFromRecord(rec, activeDomain)
// Jalur drama (vidara.js saveDomain) sudah benar sejak awal — tidak disentuh.
// Record DB tidak diubah (tetap bukti domain saat upload).
//
// Bukti aman: filecode sama hidup di kedua domain (HEAD 200 — LIVE bawah).
//
// Run: node .tests/vidara-active-domain.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const V = require('../scraper/vidara-uploader');

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); passed++; }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
}

function extractFn(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `fungsi ${name} tidak ditemukan di sumber`);
  let depth = 0; let started = false;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error(`gagal mengekstrak ${name}`);
}

(async () => {
  const srcVidoy = fs.readFileSync(path.join(__dirname, '../scraper/handlers/vidoy.js'), 'utf8');
  const srcVidara = fs.readFileSync(path.join(__dirname, '../scraper/handlers/vidara.js'), 'utf8');

  // ── sumber statis: 3 titik prioritas activeDomain ───────────────────────
  await t('#1 upload branch: link dibentuk dari activeDomain (bukan v.link)', () => {
    assert.ok(/activeDomain && v\.filecode/.test(srcVidoy), 'guard activeDomain && v.filecode hilang');
    assert.ok(/buildVideoLink\(\{ code: v\.filecode, host: activeDomain \}\)/.test(srcVidoy),
      'out.vidaraLink harus buildVideoLink({code, host: activeDomain})');
    assert.ok(!/out\.vidaraLink = v\.link;/.test(srcVidoy),
      'out.vidaraLink masih langsung v.link (domain API menang)');
  });

  await t('#2 host record: activeDomain prioritas atas v.host', () => {
    const m = /const host = ([^;]+);/.exec(srcVidoy.slice(srcVidoy.indexOf('const activeDomain')));
    assert.ok(m, 'deklarasi host tidak ditemukan setelah activeDomain');
    assert.ok(/^\(await getVidaraActiveDomain\(\)\) \|\| v\.host/.test(m[1].trim()) ||
      m[1].includes('activeDomain || v.host'),
      `host record harus activeDomain dulu, dapat: ${m[1]}`);
  });

  await t('#3 dua pemanggil rekonstruksi kirim activeDomain', () => {
    const calls = srcVidoy.match(/vidaraLinkFromRecord\(preVidara[^)]*\)/g) || [];
    assert.strictEqual(calls.length, 2, `expected 2 pemanggil, dapat ${calls.length}`);
    for (const c of calls) {
      assert.ok(/getVidaraActiveDomain/.test(c), `pemanggil tidak membawa activeDomain: ${c}`);
    }
  });

  await t('#4 jalur drama tetap memakai saveDomain (tidak rusak)', () => {
    assert.ok(/\$\{saveDomain\}\/e\/\$\{vidaraCode\}/.test(srcVidara), 'vidara.js caption berubah?');
    assert.ok(/getVidaraActiveDomain/.test(srcVidara), 'vidara.js kehilangan activeDomain');
  });

  // ── fungsi asli: vidaraLinkFromRecord (extract dari sumber, tanpa mock) ──
  const fn = new Function(`${extractFn(srcVidoy, 'vidaraLinkFromRecord')}\nreturn vidaraLinkFromRecord;`)();

  await t('#5 rekonstruksi: activeDomain MENANG atas domain record', () => {
    const got = fn({ filecode: 'zLxZ993QBiY4e', domain: 'vidara.to' }, 'iosbgaigo.com');
    assert.strictEqual(got, 'https://iosbgaigo.com/e/zLxZ993QBiY4e', `dapat: ${got}`);
  });

  await t('#6 rekonstruksi: tanpa activeDomain → domain record (fallback lama)', () => {
    const got = fn({ filecode: 'zLxZ993QBiY4e', domain: 'vidara.to' });
    assert.strictEqual(got, 'https://vidara.to/e/zLxZ993QBiY4e', `dapat: ${got}`);
    assert.strictEqual(fn({ filecode: 'ABC', domain: 'vidara.so' }, ''), 'https://vidara.so/e/ABC');
  });

  await t('#7 rekonstruksi: activeDomain dgn protokol/trailing → dinormalisasi', () => {
    const got = fn({ filecode: 'ABC', domain: 'vidara.to' }, 'https://iosbgaigo.com/');
    assert.strictEqual(got, 'https://iosbgaigo.com/e/ABC', `dapat: ${got}`);
  });

  await t('#8 rekonstruksi: record tanpa domain TANPA activeDomain → "" (tidak fabricate)', () => {
    assert.strictEqual(fn({ filecode: 'ABC', domain: '' }), '');
    assert.strictEqual(fn(null, 'iosbgaigo.com'), '');
    assert.strictEqual(fn({ filecode: '', domain: 'vidara.to' }, 'iosbgaigo.com'), '');
  });

  // ── pembentuk link upload + LIVE ────────────────────────────────────────
  await t('#9 buildVideoLink utk domain aktif → bentuk /e/ kanonik', () => {
    const got = V.buildVideoLink({ code: 'zLxZ993QBiY4e', host: 'iosbgaigo.com' }, null);
    assert.strictEqual(got, 'https://iosbgaigo.com/e/zLxZ993QBiY4e');
  });

  await t('#10 LIVE: domain aktif melayani filecode record lama (HEAD 200)', async () => {
    const url = 'https://iosbgaigo.com/e/zLxZ993QBiY4e';
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
    assert.strictEqual(res.status, 200, `HEAD ${url} = ${res.status}`);
    return `200 ✓ ${url}`;
  });

  console.log(`\nRESULT: ${passed} pass, ${failed} fail`);
  process.exit(failed ? 1 : 0);
})();
