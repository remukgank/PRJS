'use strict';
// Regression test B+ link embed Vidara (2 Okt 2026 — proposal fomo-drama).
//
// Masalah: caption memakai bentuk /{code} → validator fomo-drama menolak
// (source_path kosong). /e/ teruji hidup di semua domain Vidara (4 URL 200).
// Scope B+ = ketiga pembentuk link diseragamkan ke /e/:
//   1. vidara.js:252        caption drama (saveDomain)
//   2. vidaraLinkFromRecord vidoy.js (episode di-skip)
//   3. buildVideoLink       vidara-uploader.js (apiLink / fallback / ref.url)
// Syarat: baris "Server :- VIDARA" tetap ikut di ketiga jalur.
//
// Run: node .tests/vidara-embed-link.js

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

(async () => {
  // ── toEmbedUrl ─────────────────────────────────────────────────────────
  await t('toEmbedUrl: URL tanpa /e/ → sisip /e/', () => {
    assert.strictEqual(
      V.toEmbedUrl('https://vidara.to/IIV7UjteaSEbx'),
      'https://vidara.to/e/IIV7UjteaSEbx');
  });

  await t('toEmbedUrl: sudah /e/ → tidak dobel', () => {
    assert.strictEqual(
      V.toEmbedUrl('https://vidara.to/e/IIV7UjteaSEbx'),
      'https://vidara.to/e/IIV7UjteaSEbx');
  });

  await t('toEmbedUrl: domain lain tetap dipertahankan', () => {
    assert.strictEqual(
      V.toEmbedUrl('https://sgoabjgio.com/abc123'),
      'https://sgoabjgio.com/e/abc123');
  });

  await t('toEmbedUrl: path multi-segmen TIDAK diutak-atik', () => {
    const u = 'https://vidara.to/api/v2/x';
    assert.strictEqual(V.toEmbedUrl(u), u);
  });

  await t('toEmbedUrl: bukan URL valid → dikembalikan apa adanya', () => {
    assert.strictEqual(V.toEmbedUrl('bukan-url'), 'bukan-url');
  });

  // ── buildVideoLink ─────────────────────────────────────────────────────
  await t('buildVideoLink: apiLink /video/info (tanpa /e/) → /e/', () => {
    const out = V.buildVideoLink({ code: 'X', host: 'vidara.to' },
      'https://vidara.to/IIV7UjteaSEbx');
    assert.strictEqual(out, 'https://vidara.to/e/IIV7UjteaSEbx');
  });

  await t('buildVideoLink: apiLink dgn /e/ → utuh', () => {
    const out = V.buildVideoLink(null, 'https://vidara.to/e/IIV7UjteaSEbx');
    assert.strictEqual(out, 'https://vidara.to/e/IIV7UjteaSEbx');
  });

  await t('buildVideoLink: fallback host+code → /e/', () => {
    const out = V.buildVideoLink({ code: 'IIV7UjteaSEbx', host: 'iosbgaigo.com', url: '' }, null);
    assert.strictEqual(out, 'https://iosbgaigo.com/e/IIV7UjteaSEbx');
  });

  await t('buildVideoLink: ref.url (respons upload, sudah /e/) → utuh', () => {
    const out = V.buildVideoLink({ code: 'c', host: '', url: 'https://vidara.to/e/c' }, null);
    assert.strictEqual(out, 'https://vidara.to/e/c');
  });

  await t('buildVideoLink: tanpa data apa pun → ""', () => {
    assert.strictEqual(V.buildVideoLink(null, null), '');
  });

  // ── ketiga titik: sumber + baris Server ────────────────────────────────
  const srcVidara = fs.readFileSync(path.join(__dirname, '../scraper/handlers/vidara.js'), 'utf8');
  const srcVidoy = fs.readFileSync(path.join(__dirname, '../scraper/handlers/vidoy.js'), 'utf8');

  await t('#1 caption drama memakai saveDomain/e/ (bukan /{code})', () => {
    assert.ok(/\$\{saveDomain\}\/e\/\$\{vidaraCode\}/.test(srcVidara),
      'vidara.js:252 harus https://${saveDomain}/e/${vidaraCode}');
    assert.ok(!/`\$\{saveDomain\}\/\$\{vidaraCode\}`/.test(srcVidara),
      'bentuk lama tanpa /e/ masih ada');
  });

  await t('#2 vidaraLinkFromRecord → /e/', () => {
    assert.ok(/return `https:\/\/\$\{host\}\/e\/\$\{code\}`;/.test(srcVidoy),
      'vidaraLinkFromRecord harus https://${host}/e/${code}');
    assert.ok(!/return `https:\/\/\$\{host\}\/\$\{code\}`;/.test(srcVidoy),
      'bentuk lama tanpa /e/ masih ada');
  });

  await t('#3 buildVideoLink tidak lagi menghasilkan host+code polos', () => {
    const srcUp = fs.readFileSync(path.join(__dirname, '../scraper/vidara-uploader.js'), 'utf8');
    assert.ok(!/return `https:\/\/\$\{ref\.host\}\/\$\{ref\.code\}`;/.test(srcUp),
      'fallback host+code tanpa /e/ masih ada');
    assert.ok(/ref\.host\}\/e\/\$\{ref\.code\}/.test(srcUp));
  });

  await t('syarat fomo-drama: baris Server VIDARA ikut di jalur drama', () => {
    assert.ok(srcVidara.includes('➧ Server :- VIDARA'),
      'vidara.js kehilangan baris Server :- VIDARA');
  });

  await t('syarat fomo-drama: baris Server ada di jalur anime (captionServer)', () => {
    assert.ok(/captionServer/.test(srcVidoy), 'vidoy.js kehilangan captionServer');
    assert.ok(srcVidara.includes('vidaraLink ?') || srcVidara.includes('vidaraLink?'),
      'baris Server drama harus tetap bersyarat vidaraLink (upload gagal → tanpa Server)');
  });

  // ── live: /video/info asli → buildVideoLink ────────────────────────────
  await t('LIVE /video/info IIV7UjteaSEbx → link hasil /e/', async () => {
    const info = await V.videoInfo('IIV7UjteaSEbx').catch(() => null);
    assert.ok(info && info.link, 'videoInfo tidak balik link');
    const out = V.buildVideoLink(null, info.link);
    assert.ok(/^https:\/\/[^/]+\/e\/[^/]+$/.test(out), `bukan bentuk /e/: ${out}`);
    console.log(`        input : ${info.link}`);
    console.log(`        output: ${out}`);
  });

  console.log(`\n${passed} pass, ${failed} fail`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
