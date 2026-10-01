/**
 * test-preview-judul-resolusi.js
 *
 * Menguji resolusi judul di alur "link provider langsung": entry URL kamenime,
 * picker kam_ep, preview "📥 Download", dan blok dl_go: target tg.
 *
 * Aturan yang diuji (urutan prioritas):
 *   1. customTitle  (dari "Ganti Judul")
 *   2. detectedTitle (dari library)
 *   3. kamenimeTitleFromFileName(fileName)  ← judul asli, KAMENIME SAJA
 *   4. fileName     (fallback)
 *
 * Test ini membaca bot.js ASLI (bukan menyalin logikanya) supaya ia mengunci
 * kode yang benar-benar jalan, dan menjalankan fungsi asli dari providers/.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
const LINES = SRC.split('\n');
const {
  kamenimeTitleFromFileName,
  isKamenimeUrl,
} = require('../providers/kamenime.js');

let pass = 0, fail = 0;
const queue = [];
function t(name, fn) { queue.push({ name, fn }); }
function done(name, err) {
  if (err) { fail++; console.log(`FAIL  ${name}\n      ${String(err.message).split('\n')[0]}`); }
  else { pass++; console.log(`PASS  ${name}`); }
}

// ── helper: salin blok baris dari bot.js ────────────────────────────────────
function block(startLine, endLine) {
  return LINES.slice(startLine - 1, endLine).join('\n');
}
/** Cari blok yang mengandung pola, mulai dari baris tertentu. */
function blockFrom(fromLine, len = 26) {
  return LINES.slice(fromLine - 1, fromLine - 1 + len).join('\n');
}
/** Nomor baris yang berisi pola (pertama setelah from). */
function lineOf(re, from = 0) {
  for (let i = from; i < LINES.length; i++) if (re.test(LINES[i])) return i + 1;
  return -1;
}

/** Cari nomor baris yangmatch regex, mulai dari offset tertentu. */
function findLine(re, from = 0) {
  for (let i = from; i < LINES.length; i++) if (re.test(LINES[i])) return i + 1;
  return -1;
}

/**
 * Simulasikan resolution judul sesuai kode nyata di bot.js.
 * Sengaja ditulis ulang dari ekspresi yang ADA di bot.js, lalu di-assert
 * terhadap isi bot.js oleh test (q/r/s) — supaya test inidan kode asli
 * harus selalu中级人民法院 sinkron.
 */
function resolveTitle({ customTitle, detected, fileName, isKamenime }) {
  const kmTitle = isKamenime ? kamenimeTitleFromFileName(fileName) : null;
  return customTitle || (detected && detected.nama) || kmTitle || fileName || 'file';
}

// ══════════════════════════════════════════════════════════════════════════
t('a) entry URL kamenime, judul TIDAK ada di library → judul dari nama file', () => {
  // Cari blok entry URL kamenime (bukan nomor baris hardcode — fragile)
  const L = lineOf(/const km = await resolveKamenimeFile/);
  assert.ok(L > 0, 'blok entry URL kamenime tidak ditemukan');
  const src = blockFrom(L, 24);
  assert.ok(/kamenimeTitleFromFileName\(kmName\)/.test(src),
    'entry URL harus memakai kamenimeTitleFromFileName(kmName)');
  const out = resolveTitle({ customTitle: null, detected: null, fileName: 'Naruto Shippuden-episode-2.mp4', isKamenime: true });
  assert.strictEqual(out, 'Naruto Shippuden');
  assert.ok(!out.includes('episode-2'), 'judul tidak boleh memuat sufiks episode');
  assert.ok(!out.includes('.mp4'), 'judul tidak boleh memuat ekstensi');
});

t('b) entry URL kamenime, judul ADA di library → judul library yang tampil', () => {
  const L = lineOf(/const km = await resolveKamenimeFile/);
  assert.ok(L > 0, 'blok entry URL kamenime tidak ditemukan');
  const src = blockFrom(L, 24);
  // detectedTitle harus Dicek SEBELUM judul dari nama file
  const iDet = src.indexOf('detectedTitle && detectedTitle.nama');
  const iKm = src.indexOf('kamenimeTitleFromFileName(kmName)');
  assert.ok(iDet > -1 && iKm > -1, 'dua sumber judul harus ada');
  assert.ok(iDet < iKm, 'judul library harus diprioritaskan sebelum judul dari nama file');
  const out = resolveTitle({ customTitle: null, detected: { nama: 'Naruto' }, fileName: 'Naruto Shippuden-episode-2.mp4', isKamenime: true });
  assert.strictEqual(out, 'Naruto');
});

t('c) picker kam_ep, judul TIDAK ada di library → judul asli tampil', () => {
  // 28 Sep 2026: batas baris ABSOLUT (3500-3560) di sini rapuh — fix picker
  // halaman menambah baris di bot.js sehingga posisi bergeser tanpa bug nyata.
  // Yang diuji isi handler kam_ep, pakai blockFrom yang sudah dipakai test lain.
  const L2 = lineOf(/data\.startsWith\('kam_ep:'\)/);
  assert.ok(L2 > 0, 'handler kam_ep tidak ditemukan');
  const bodyKamEp = blockFrom(L2, 26);
  assert.ok(/kamenimeTitleFromFileName\(fileName\)/.test(bodyKamEp),
    'handler kam_ep harus memakai judul dari nama file');
  const out = resolveTitle({ customTitle: null, detected: null, fileName: 'Bleach-episode-1.mp4', isKamenime: true });
  assert.strictEqual(out, 'Bleach');
});

t('d) picker kam_ep, judul ADA di library → judul library', () => {
  const out = resolveTitle({ customTitle: null, detected: { nama: 'Bleach' }, fileName: 'Bleach-episode-1.mp4', isKamenime: true });
  assert.strictEqual(out, 'Bleach');
});

t('e) preview setelah "Ganti Judul" → judul kustom tampil, bukan nama file', () => {
  // preview tidak boleh memakai takeCustomTitle (destruktif) — harus peek
  const previewStart = findLine(/const titleShown = customTitle/);
  assert.ok(previewStart > 4300, `preview titleShown harus pakai customTitle (baris ${previewStart})`);
  // peekCustomTitle harus ada DAN takeCustomTitle tidak boleh dipakai di preview
  const iPeek = SRC.indexOf('const customTitle = peekCustomTitle(url)');
  assert.ok(iPeek > -1, 'preview harus memakai peekCustomTitle(url)');
  const previewBlk = block(previewStart - 8, previewStart + 2);
  assert.ok(!/takeCustomTitle\(url\)/.test(previewBlk),
    'preview tidak boleh memakai takeCustomTitle — nilainya akan habis sebelum dl_go:');
  const out = resolveTitle({ customTitle: 'Judul Kustom User', detected: { nama: ' Naruto' }, fileName: 'Bleach-episode-1.mp4', isKamenime: true });
  assert.strictEqual(out, 'Judul Kustom User');
});

t('f) preview tanpa "Ganti Judul", library kosong → judul asli (langkah 3)', () => {
  const out = resolveTitle({ customTitle: null, detected: null, fileName: 'One Piece-episode-1050.mp4', isKamenime: true });
  assert.strictEqual(out, 'One Piece');
});

t('g) provider lain (gofile) → PERILAKU TIDAK BERUBAH (regresi)', () => {
  // kmTitle hanya boleh dihitung kalau isKamenimeUrl — bukan provider lain
  const out = resolveTitle({ customTitle: null, detected: null, fileName: 'TSSDK-S2-P2-1-FULLHD.mp4', isKamenime: false });
  assert.strictEqual(out, 'TSSDK-S2-P2-1-FULLHD.mp4', 'gofile harus tetap pakai fileName');
  // dan di kode nyata, kmTitle di-preview harus dikunci isKamenimeUrl
  const i = SRC.indexOf('const kmTitle = isKamenimeUrl(url) ? kamenimeTitleFromFileName(fileName) : null;');
  assert.ok(i > -1, 'kmTitle di preview harus dikunci isKamenimeUrl(url)');
});

t('h) tidak ada judul sama sekali → fallback ke fileName, tidak crash', () => {
  const out = resolveTitle({ customTitle: null, detected: null, fileName: 'video.mp4', isKamenime: true });
  assert.ok(out, 'harus ada nilai, tidak boleh undefined');
  assert.strictEqual(typeof out, 'string');
});

t('i) blok dl_go:tg — semua cabang memakai titleForCap, bukan detectedTitle', () => {
  const start = findLine(/if \(target === 'tg'\)/);
  assert.ok(start > 0, "blok target === 'tg' tidak ditemukan");
  // blok tg berakhir tepat sebelum komentar "target = vyt atau vv"
  const end = findLine(/target = vyt atau vv/, start);
  assert.ok(end > start, 'batas blok tg tidak ditemukan');
  const blk = block(start, end);
  const calls = [...blk.matchAll(/return handle(\w+)\(chatId, url, ([^)]*)\)/g)];
  assert.ok(calls.length >= 6, `harus ada >=6 cabang, dapat ${calls.length}`);
  for (const [, name, arg] of calls) {
    assert.ok(/titleForCap|gdTitle/.test(arg),
      `handle${name} dapat argumen "${arg}" — harus titleForCap atau gdTitle`);
  }
  // titleForCap sendiri harus punya fallback judul asli kamenime
  const iT = SRC.indexOf('const titleForCap = customTitle');
  assert.ok(iT > 0, 'titleForCap harus ada');
  const tLineIdx = SRC.slice(0, iT).split('\n').length - 1;
  const tLine = LINES[tLineIdx];
  assert.ok(/kmTitleFallback|kamenimeTitleFromFileName/.test(tLine),
    `titleForCap harus punya fallback judul asli, dapat: ${tLine.trim()}`);
});

t('j) judul kustom TIDAK boleh lintas episode (key = URL) — itu bukan bug', () => {
  // dua URL berbeda = dua key berbeda; judul episode 1 tidak boleh bocor ke 2
  const U1 = 'https://www.kamenime.com/anime/naruto-shippuden/episode/1';
  const U2 = 'https://www.kamenime.com/anime/naruto-shippuden/episode/2';
  assert.notStrictEqual(U1, U2);
  assert.strictEqual(isKamenimeUrl(U1), true);
  assert.strictEqual(isKamenimeUrl(U2), true);
  // dan preview episode 2 tanpa custom title harus tetap dapat judul asli
  const out = resolveTitle({ customTitle: null, detected: null, fileName: 'Naruto Shippuden-episode-2.mp4', isKamenime: true });
  assert.strictEqual(out, 'Naruto Shippuden');
});

t('q) kode preview memuat urutan custom → detected → km → fileName', () => {
  const L = findLine(/const titleShown = customTitle/);
  assert.ok(L > 0, 'titleShown dengan customTitle tidak ditemukan');
  const line = LINES[L - 1];
  const iC = line.indexOf('customTitle');
  const iD = line.indexOf('detectedTitle');
  const iK = line.indexOf('kmTitle');
  const iF = line.indexOf('fileName');
  assert.ok(iC > -1 && iD > iC && iK > iD && iF > iK,
    `urutan salah: ${line.trim()}`);
});

// ── jalankan (antrean, supaya failure tidak menutupi yang lain) ────────────
(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); done(name, null); }
    catch (e) { done(name, e); }
  }
  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
