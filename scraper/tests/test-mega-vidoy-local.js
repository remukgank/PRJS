'use strict';

// Verifikasi mega bisa ke Vidoy lewat file lokal (bukan URL).
//
// MASALAH: `resolveDirectUrl()` return null untuk mega.nz (mega.File streaming,
// bukan URL HTTP). Jalur `sam_go` vyt/vv memanggilnya lalu menyerah dengan
// "Gagal resolve link file" — padahal arsitektur actionAnimeEpisode adalah
// download-then-upload dari file LOKAL. URL hanya dibutuhkan untuk langkah
// download; upload Vidoy-nya dari file.
//
// FIX:
//  - `vidoy.js` actionAnimeEpisode menerima `localPath` opsional: kalau ada dan
//    valid, salin ke destPath dan lewati `ensureMp4(directUrl)`.
//  - `bot.js` sam_go: kalau server mega, unduh dulu via downloadMegaFile ke
//    temp, oper sebagai localPath, hapus temp setelah selesai.
//
// Test ini membaca kode ASLI (bukan salinan) dan menjalankannya dengan stub.
//
// Run: node scraper/tests/test-mega-vidoy-local.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BOT = path.join(__dirname, '..', 'bot.js');
const VIDOY = path.join(__dirname, '..', 'handlers', 'vidoy.js');
const botSrc = fs.readFileSync(BOT, 'utf8');
const vidoySrc = fs.readFileSync(VIDOY, 'utf8');

let passed = 0;
let failed = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });

// ── 1) vidoy.js menerima localPath ──────────────────────────────────────────
t('1a) actionAnimeEpisode mendestructure localPath dari opts', () => {
  assert.ok(/const \{[^}]*\blocalPath\b[^}]*\} = opts \|\| \{\};/.test(vidoySrc),
    'localPath tidak ada di destructure opts actionAnimeEpisode');
  return 'opts.localPath ✓';
});

t('1b) cabang localPath menyalin + memvalidasi, tanpa ensureMp4', () => {
  const i = vidoySrc.indexOf('} else if (localPath');
  assert.ok(i >= 0, 'cabang `} else if (localPath` tidak ada');
  // akhir cabang = `} else {` berikutnya pada indentasi sama
  const j = vidoySrc.indexOf('} else {', i);
  assert.ok(j > i, 'akhir cabang localPath tidak ketemu');
  const branch = vidoySrc.slice(i, j);
  assert.ok(/fs\.copyFileSync\(localPath, destPath\)/.test(branch),
    'harus salin localPath → destPath');
  assert.ok(/isReusableVideo\(destPath\)/.test(branch),
    'harus validasi hasil salinan');
  assert.ok(!/ensureMp4\(/.test(branch),
    'cabang localPath TIDAK BOLEH memanggil ensureMp4(directUrl)');
  return 'copy + validasi, tanpa ensureMp4 ✓';
});

// ── 2) jalankan cabang localPath dengan stub ────────────────────────────────
function runLocalBranch({ localExists, localValid, destExists }) {
  const calls = [];
  const scope = {
    localPath: localExists ? '/tmp/mega-test.mp4' : '/tmp/tidak-ada.mp4',
    destPath: '/tmp/dest-test.mp4',
    logCtx: {},
    p: { update: () => {} },
    fs: {
      existsSync: () => localExists,
      copyFileSync: () => { calls.push('copy'); },
      statSync: () => ({ size: 100 * 1048576 }),
    },
    isReusableVideo: (p) => {
      calls.push('check:' + p);
      // destPath belum ada sebelum copy → pertama tidak layak;
      // sesudah copy → layak iff localValid
      if (p === '/tmp/dest-test.mp4' && calls.includes('copy')) {
        return localValid ? { ok: true, bytes: 1 } : { ok: false, why: 'rusak' };
      }
      return { ok: !!destExists, bytes: 1, why: 'tidak ada' };
    },
    ensureMp4: async () => { calls.push('ensureMp4'); return true; },
    logger: { info: () => {}, warn: () => {} },
  };
  // ekstrak cabang: dari `} else if (localPath` sampai `} else {`
  const i = vidoySrc.indexOf('} else if (localPath');
  const j = vidoySrc.indexOf('} else {', i);
  let branch = vidoySrc.slice(i, j);
  // ubah jadi if mandiri
  branch = 'if (localPath && fs.existsSync(localPath)) {' + branch.slice(branch.indexOf('{') + 1) + '\n}';
  const keys = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...keys, `${branch}\nreturn 'done';`);
  return { promise: (async () => { try { await fn(...keys.map((k) => scope[k])); return { ok: true, calls }; } catch (e) { return { ok: false, calls, err: e.message }; } })() };
}

t('2a) file lokal valid → disalin, divalidasi, TANPA ensureMp4', async () => {
  const { ok, calls, err } = await runLocalBranch({ localExists: true, localValid: true }).promise;
  assert.ok(ok, `harus sukses: ${err}`);
  assert.ok(calls.includes('copy'), 'copyFileSync tidak dipanggil');
  assert.ok(!calls.includes('ensureMp4'), 'ensureMp4 ikut dipanggil — directUrl tidak dibutuhkan di sini!');
  return `calls: ${calls.join(', ')}`;
});

t('2b) file lokal rusak → throw, TANPA ensureMp4', async () => {
  const { ok, calls, err } = await runLocalBranch({ localExists: true, localValid: false }).promise;
  assert.ok(!ok, 'harus throw untuk file rusak');
  assert.ok(/tidak layak/.test(err), `pesan salah: ${err}`);
  assert.ok(!calls.includes('ensureMp4'), 'ensureMp4 tidak boleh jadi fallback diam-diam');
  return `throw: ${err}`;
});

// ── 3) sam_go cabang mega ───────────────────────────────────────────────────
t('3a) sam_go: server mega mengunduh dulu via downloadMegaFile', () => {
  assert.ok(/if \(server === 'mega'\) \{/.test(botSrc),
    'cabang `if (server === \'mega\')` tidak ada di sam_go');
  assert.ok(/await downloadMegaFile\(mf\.file, megaLocal/.test(botSrc),
    'sam_go harus memanggil downloadMegaFile(mf.file, megaLocal)');
  assert.ok(/localPath: megaLocal/.test(botSrc),
    'actionAnimeEpisode harus dipanggil dengan localPath: megaLocal');
  return 'resolveMegaFile → downloadMegaFile → localPath ✓';
});

t('3b) sam_go: temp mega dihapus setelah selesai (finally)', () => {
  const i = botSrc.indexOf("if (server === 'mega') {");
  assert.ok(i >= 0, 'cabang mega tidak ada');
  const j = botSrc.indexOf('if (res && res.error)', i);
  const block = botSrc.slice(i, j);
  assert.ok(/finally\s*\{[\s\S]*?fs\.unlinkSync\(megaLocal\)/.test(block),
    'temp megaLocal harus dihapus di finally');
  return 'finally unlink ✓';
});

t('3c) sam_go: mega gagal → pesan jelas, bukan hang', () => {
  const i = botSrc.indexOf("if (server === 'mega') {");
  const block = botSrc.slice(i, botSrc.indexOf('const direct = megaLocal', i));
  assert.ok(/Gagal unduh Mega/.test(block), 'harus ada pesan "Gagal unduh Mega"');
  return 'error path ada ✓';
});

t('3d) non-mega tidak tersentuh: resolveDirectUrl tetap dipakai', () => {
  assert.ok(/const direct = megaLocal \? \{ url: fileUrlG \} : await _downloadHandlers\.resolveDirectUrl\(fileUrlG\);/.test(botSrc),
    'jalur non-mega harus tetap resolveDirectUrl');
  return 'non-mega → resolveDirectUrl ✓';
});

t('3e) import downloadMegaFile + os ada', () => {
  const m = /const \{([^}]*)\} = require\('\.\/providers\/mega'\);/.exec(botSrc);
  assert.ok(m, 'require providers/mega tidak ditemukan');
  assert.ok(/\bdownloadMegaFile\b/.test(m[1]),
    `downloadMegaFile belum di-import (isi: ${m[1].trim()})`);
  assert.ok(/^const os = require\('os'\);$/m.test(botSrc), "require('os') belum ada");
  return 'import ✓';
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
