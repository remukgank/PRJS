'use strict';

// Verifikasi nomor episode jalur direct provider memakai parser Samehadaku,
// bukan tebakan dari nama file.
//
// MASALAH: `bot.js` (blok dl_go jalur vyt/vv untuk direct provider):
//   const animeEp = extractPartFromFilename(fileName || '') || 1;
// `extractPartFromFilename` (lib/parser.js) memotong angka 4 digit jadi 3 digit
// terakhir (`/(\d{1,3})\s*$/`): one-piece-1180.mp4 → 180, naruto-episode-1234 → 234,
// [Horizon] One Piece - 1050 [1080p] → 1 (mengambil "1080" dari "1080p").
//
// FIX: `resolveProviderTitle()` sudah memanggil `parseSamehadakuFilename(fileName)`
// dan hasilnya dipakai untuk cari judul — tapi dibuang. Sekarang dikembalikan
// sebagai `gds`, dan baris ep menjadi:
//   const animeEp = (gds && gds.episode) || extractPartFromFilename(fileName || '') || 1;
//
// Test ini TIDAK menyalin logikanya: baris `const animeEp` dibaca dari bot.js
// asli SETIAP test berjalan (lazy), lalu dijalankan. Kalau baris itu berubah,
// test gagal dengan FAIL yang jelas — bukan crash saat load.
//
// Run: node scraper/tests/test-animeep-parser.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BOT = path.join(__dirname, '..', 'bot.js');
// eslint-disable-next-line import/no-dynamic-require
const { extractPartFromFilename } = require('../lib/parser');

let passed = 0;
let failed = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });

/**
 * Baca ulang bot.js dan ambil baris `const animeEp` yang ASLI.
 * Lazy (dipanggil per-test), bukan saat load — supaya kalau baris fix hilang,
 * yang muncul FAIL dengan pesan, bukan crash tanpa jejak.
 */
function readEpLine() {
  const src = fs.readFileSync(BOT, 'utf8');
  const marker = 'const animeEp = (gds && gds.episode)';
  const i = src.indexOf(marker);
  if (i < 0) return { ok: false, line: null, why: 'baris fix tidak ada di bot.js' };
  const end = src.indexOf(';', i) + 1;
  if (end <= i) return { ok: false, line: null, why: 'baris animeEp tidak tertutup' };
  return { ok: true, line: src.slice(i, end), why: null };
}

/** Jalankan baris asli dengan gds + fileName yang disuntik. */
function runEp(gds, fileName) {
  const { ok, line, why } = readEpLine();
  assert.ok(ok, `tidak bisa uji: ${why} — fix hilang dari bot.js?`);
  // eslint-disable-next-line no-new-func
  const fn = new Function('gds', 'fileName', 'extractPartFromFilename',
    `${line}\nreturn animeEp;`);
  return fn(gds, fileName, extractPartFromFilename);
}

t('gds.episode dipakai kalau ada (kasus Samehadaku FULLHD)', () => {
  const got = runEp({ episode: 933 }, 'OP-933-FULLHD-SAMEHADAKU.VIP.mp4');
  assert.strictEqual(got, 933, `harus 933, dapat ${got}`);
  return `OP-933 → ${got}`;
});

t('fallback ke extractPartFromFilename kalau gds null', () => {
  const got = runEp(null, 'naruto-episode-45.mp4');
  assert.strictEqual(got, 45, `harus 45, dapat ${got}`);
  return `naruto-episode-45 → ${got}`;
});

t('fallback ke extractPartFromFilename kalau gds.episode null', () => {
  const got = runEp({ episode: null }, 'bleach-episode-7.mp4');
  assert.strictEqual(got, 7, `harus 7, dapat ${got}`);
  return `bleach-episode-7 → ${got}`;
});

t('fallback ke 1 kalau keduanya gagal (tidak crash)', () => {
  const got = runEp(null, 'TsSDKMGnoKh-FULLHD-SAMEHADAKU.CARE.mp4');
  assert.strictEqual(got, 1, `harus 1, dapat ${got}`);
  return `tanpa angka → ${got}`;
});

t('gds.episode mengalahkan tebakan file yang salah', () => {
  const got = runEp({ episode: 1180 }, 'one-piece-1180.mp4');
  assert.strictEqual(got, 1180, `harus 1180, dapat ${got} — gds diabaikan?`);
  return `gds 1180 mengalahkan tebakan 180 → ${got}`;
});

t('baris yang diuji benar-benar dari bot.js (bukan salinan)', () => {
  const { ok, line, why } = readEpLine();
  assert.ok(ok, why);
  assert.ok(line.includes('(gds && gds.episode)'), 'bukan baris fix');
  assert.ok(line.includes('extractPartFromFilename(fileName'), 'fallback hilang?');
  assert.ok(line.endsWith('|| 1;'), 'fallback 1 hilang?');
  return `baris: ${line.slice(0, 90)}…`;
});

t('gds dideklarasikan di scope fungsi, bukan hanya di dalam blok (anti-ReferenceError)', () => {
  const src = fs.readFileSync(BOT, 'utf8');
  const s = src.indexOf('async function resolveProviderTitle(url) {');
  assert.ok(s >= 0, 'resolveProviderTitle tidak ditemukan');
  // akhir fungsi = baris yang hanya berisi dua spasi + '}' setelah return
  const ret = src.indexOf('return { detectedTitle, fileName, gds };', s);
  assert.ok(ret > s, 'return gds tidak ada');
  const body = src.slice(s, ret);
  // gds HARUS dideklarasikan di scope fungsi (let/var), dan TIDAK boleh ada
  // 'const gds' di dalam blok yang menutupi (shadowing) — itu yang membuat
  // return selalu null, atau ReferenceError kalau let-nya lupa.
  // Insiden 27 Sep 2026 19:17 UTC: `const gds` di dalam if + return di luar
  // → ReferenceError: gds is not defined → SEMUA callback crash.
  assert.ok(/^  let gds = null;$/m.test(body),
    '`let gds = null;` harus ada di scope fungsi resolveProviderTitle');
  assert.ok(!/const gds = parseSamehadakuFilename/.test(body),
    'ada `const gds` di dalam blok — itu menutupi (shadow) variabel fungsi');
  return 'let gds di scope fungsi, tanpa shadowing';
});

t('resolveProviderTitle mengembalikan gds (bukan dibuang)', () => {
  const src = fs.readFileSync(BOT, 'utf8');
  assert.ok(/return \{ detectedTitle, fileName, gds \};/.test(src),
    'resolveProviderTitle harus mengembalikan gds');
  const uses = (src.match(/const \{ detectedTitle, fileName, gds \} = await resolveProviderTitle\(url\)/g) || []).length;
  assert.ok(uses >= 1, 'tidak ada pemanggil yang memakai gds');
  return `return + ${uses} pemanggil memakai gds`;
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
