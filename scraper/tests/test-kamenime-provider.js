'use strict';

// Regression test: provider kamenime (MP4 direct).
//
// 27 Sep 2026 — muncul karena server gdriveplayer (Samehadaku) macet di
// 20–120 KB/s: 43,7 MB dalam 18 menit, 3× retry sia-sia, 65 MB terbuang.
// Kamenime serves MP4 langsung di 3–9 MB/s tanpa perlu remux, tanpa worker
// Cloudflare (yang clearance-nya sering expired).
//
// Yang paling rawan di sini: URL /storage/ mengandung SPASI TELANJANG
// (`/storage/anime/Naruto Shippuden/...mp4`) — kalau tidak di-encode, fetch
// gagal ERR_UNESCAPED_SPACE. Dan file MP4 TIDAK BOLEH masuk jalur gdriveplayer
// (download.js:968 memaksa ekstensi .ts → remuxToMp4 jalan → file salah tipe).
//
// Run: node scraper/tests/test-kamenime-provider.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isKamenimeUrl, resolveKamenimeFile, fileNameFromUrl, absolutize } = require('../providers/kamenime');

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); passed++; }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
}

const SLUG = 'naruto-shippuden';
const PAGE_EP1 = 'https://www.kamenime.com/anime/naruto-shippuden/episode/1';
const FILE_EP1 = 'https://www.kamenime.com/storage/anime/Naruto%20Shippuden/Naruto%20Shippuden-episode-1.mp4';

(async () => {
  // ── a) /anime/<slug>/episode/<N> → resolve ke URL .mp4 benar ──
  await t('a) halaman /anime/<slug>/episode/1 → resolve ke URL .mp4 yang benar', async () => {
    const r = await resolveKamenimeFile(PAGE_EP1);
    assert.ok(isKamenimeUrl(r.fileUrl), 'hasil harus tetap URL kamenime');
    assert.ok(/\/storage\/anime\/Naruto%20Shippuden\/Naruto%20Shippuden-episode-1\.mp4$/.test(r.fileUrl),
      `path salah: ${r.fileUrl}`);
    assert.ok(!/ /.test(r.fileUrl), `URL tidak boleh berisi space mentah: ${r.fileUrl}`);
    assert.strictEqual(r.fileName, 'Naruto Shippuden-episode-1.mp4');
    console.log(`      → ${r.fileUrl}`);
    console.log(`      → fileName: ${r.fileName}`);
  });

  // ── b) /storage/...mp4 → instan, TANPA request network ──
  await t('b) bentuk /storage/ → fileUrl persis input, tanpa request', async () => {
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (...a) => { called++; return realFetch(...a); };
    let r;
    try { r = await resolveKamenimeFile(FILE_EP1); } finally { globalThis.fetch = realFetch; }
    assert.strictEqual(called, 0, `harus tanpa request, tapi ${called} request`);
    assert.strictEqual(r.fileUrl, FILE_EP1, 'fileUrl harus persis input');
    assert.strictEqual(r.fileName, 'Naruto Shippuden-episode-1.mp4');
    console.log(`      → ${r.fileUrl} (0 request)`);
  });

  // ── c) URL non-kamenime → isKamenimeUrl() false (anti-tabrakan) ──
  await t('c) isKamenimeUrl() false untuk URL provider lain', () => {
    const lain = [
      'https://gofile.io/d/abc123', 'https://pixeldrain.com/u/abc', 'https://filedon.co/abc',
      'https://mega.nz/file/abc#key', 'https://drive.google.com/file/d/abc/view',
      'https://gdriveplayer.to/download.php?link=abc', 'https://v2.samehadaku.how/naruto-shippuuden-episode-1/',
      'https://www.kamenime.com/anime/naruto-shippuden',       // halaman anime, BUKAN episode
      'https://kamenime.com.evil.tld/storage/x.mp4',           // domain menipu
      'not-a-url',
    ];
    for (const u of lain) assert.strictEqual(isKamenimeUrl(u), false, `harus false: ${u}`);
  });

  // ── d) halaman tanpa <source> → error jelas, bukan diam ──
  await t('d) halaman tanpa <source> → error yang menyebut <source>', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '<html><body>Tidak ada video di sini</body></html>' });
    let err = null;
    try { await resolveKamenimeFile(PAGE_EP1); } catch (e) { err = e; }
    globalThis.fetch = realFetch;
    assert.ok(err, 'harus melempar error');
    assert.ok(/<source src> tidak ditemukan/.test(err.message), `pesan kurang jelas: ${err.message}`);
    console.log(`      → ${err.message}`);
  });

  // ── e) MUTASI: guard urung agar kamenime masuk jalur gdriveplayer ──
  // download.js memaksa ekstensi .ts pada file gdriveplayer:
  //   const gpName = /\.ts$/i.test(gpBase) ? gpBase : `${gpBase}.ts`;
  // Kalau ini bocor, MP4.Named .ts lalu remuxToMp4 jalan. Test WAJIB gagal
  // kalau urutan guard berubah.
  await t('e) guard: isKamenimeUrl dicek SEBELAH isGdrivePlayerUrl di resolveDirectUrl', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'download.js'), 'utf8');
    // WAJIB dipakai pada scopes resolveDirectUrl SAJA — string isGdrivePlayerUrl
    // juga muncul di downloadSamehadakuFile, dan indexOf akan salah tangkap.
    const start = src.indexOf('async function resolveDirectUrl');
    const end = src.indexOf('\n  async function ', start + 10);
    const body = src.slice(start, end > start ? end : undefined);
    const iKm = body.indexOf('if (isKamenimeUrl(url)) {');
    const iGp = body.indexOf('if (isGdrivePlayerUrl(url)) {');
    assert.ok(iKm > 0, `resolveDirectUrl harus punya cabang kamenime (idx ${iKm})`);
    assert.ok(iGp > 0, `resolveDirectUrl harus punya cabang gdriveplayer (idx ${iGp})`);
    assert.ok(iKm < iGp, `kamenime (idx ${iKm}) harus SEBELUM gdriveplayer (idx ${iGp}) — kalau tidak, .mp4 dipaksa jadi .ts`);
  });

  // ── f) handleKamenimeUrl TIDAK memanggil remuxToMp4 (sudah MP4) ──
  await t('f) handleKamenimeUrl tidak remux + mempertahankan .mp4', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'download.js'), 'utf8');
    const s = src.indexOf('async function handleKamenimeUrl');
    const e = src.indexOf('async function handleMegaUrl');
    assert.ok(s > 0 && e > s, 'handleKamenimeUrl harus ada sebelum handleMegaUrl');
    const body = src.slice(s, e);
    assert.ok(!/remuxToMp4/.test(body), 'handleKamenimeUrl tidak boleh remux (file sudah MP4)');
    assert.ok(/\.endsWith\('\.mp4'\)/.test(body), 'nama file harus dipertahankan .mp4');
    assert.ok(/sendAnimeMedia/.test(body), 'wajib lewat sendAnimeMedia (topic Anime + supports_streaming)');
    assert.ok(/supports_streaming:\s*true/.test(body), 'harus supports_streaming: true (kontrak media)');
  });

  // ── g) caption 4 baris persis (kontrak media) ──
  await t('g) caption anime 4 baris: Judul / Episode / Provider', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'download.js'), 'utf8');
    const s = src.indexOf('async function handleKamenimeUrl');
    const e = src.indexOf('async function handleMegaUrl');
    const body = src.slice(s, e);
    for (const line of ['➧ Judul :-', '➧ Episode :-', '➧ Provider :-']) {
      assert.ok(body.includes(line), `baris caption wajib ada: ${line}`);
    }
  });

  // ── h) encoding space & decode entity ──
  await t('h) absolutize() encode space + decode &amp;', () => {
    const a = absolutize('/storage/anime/Naruto Shippuden/Naruto Shippuden-episode-1.mp4');
    assert.ok(!/ /.test(a), `space harus ter-encode: ${a}`);
    assert.ok(a.includes('Naruto%20Shippuden'), `path salah: ${a}`);
    const b = absolutize('/storage/anime/A&amp;B/x.mp4');
    assert.ok(b.includes('A&B'), `&amp; harus di-decode: ${b}`);
    assert.strictEqual(fileNameFromUrl(a), 'Naruto Shippuden-episode-1.mp4');
    console.log(`      → encode: ${a.slice(0, 70)}…`);
  });

  console.log(`\n${passed} pass / ${failed} fail`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
