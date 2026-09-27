/**
 * test-media-key-konsisten.js
 *
 * Bug 27 Sep 2026: satu anime terpecah jadi 2 media_key hanya karena beda ejaan.
 *
 *   batch   → judul dari <title> situs  → "Re:Zero kara Hajimeru ..."  (titik dua)
 *   single  → judul dari NAMA FILE      → "Re-Zero kara Hajimeru ..."  (hyphen)
 *
 * Akibatnya picker (yang cuma menanyakan SATU key) menampilkan 23 part sebagai
 * "di Telegram" dan 2 part sebagai "perlu dikirim" — padahal 25/25 sudah
 * lengkap di Vidoy DAN Telegram.
 *
 * Test ini mengunci tiga hal:
 *   1. upsertMedia tidak lagi menimpa nama dengan judul yang lebih pendek
 *   2. picker kamenime mencari library lewat source_pattern, bukan slug dari judul
 *   3. picker kamenime punya vidoyKeysFromEpisodes + mengisi done dari st.tg
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const DB = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
const BOT = fs.readFileSync(path.join(ROOT, 'bot.js'), 'utf8');
const ES = fs.readFileSync(path.join(ROOT, 'lib', 'episode-status.js'), 'utf8');

let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); passed++; }
  catch (e) { console.log(`FAIL ${name}\n      ${e.message}`); failed++; }
};

/** Potong blok fungsi di bot.js dari marker sampai handler berikutnya. */
function pickerBlok() {
  const i = BOT.indexOf('async function buildKamenimeEpisodePicker');
  const j = BOT.indexOf('async function buildSamehadakuEpisodePicker', i);
  return BOT.slice(i, j > i ? j : i + 3000);
}

// ── 1) upsertMedia: nama tidak lagi ditimpa tanpa syarat ────────────────
t('1a) upsertMedia tidak memakai "nama = $2" telanjang', () => {
  const i = DB.indexOf('async function upsertMedia');
  const blk = DB.slice(i, i + 1400);
  assert.ok(!/\bnama = \$2,/.test(blk),
    'masih ada "nama = $2," — judul baru (dari nama file) menimpa judul lama');
  assert.ok(/nama = CASE/.test(blk), 'harus pakai CASE: hanya tulis kalau lebih baik');
});

t('1b) CASE melindungi nama yang sudah ada (tidak ditulis ulang)', () => {
  const i = DB.indexOf('async function upsertMedia');
  const blk = DB.slice(i, i + 1400);
  assert.ok(/WHEN media\.nama IS NULL OR btrim\(media\.nama\) = '' THEN EXCLUDED\.nama/.test(blk),
    'nama kosong di DB harus bisa diisi');
  assert.ok(/WHEN EXCLUDED\.nama IS NULL OR btrim\(EXCLUDED\.nama\) = '' THEN media\.nama/.test(blk),
    'nama baru kosong tidak boleh menimpa');
  assert.ok(/ELSE media\.nama/.test(blk), 'harus ada ELSE media.nama — judul lama dipertahankan');
  assert.ok(/length\(EXCLUDED\.nama\) > length\(media\.nama\) THEN EXCLUDED\.nama/.test(blk),
    'judul yang lebih lengkap (mis. dapat suffix season) boleh menulis');
});

t('1c) kolom lain tetap COALESCE (tidak ikut berubah)', () => {
  const i = DB.indexOf('async function upsertMedia');
  const blk = DB.slice(i, i + 1800);
  for (const col of ['source_url', 'source_pattern', 'poster_url', 'poster_file_id', 'synopsis']) {
    assert.ok(new RegExp(`${col} = COALESCE\\(`).test(blk),
      `${col} harus tetap COALESCE`);
  }
  assert.ok(/total_eps = GREATEST\(/.test(blk), 'total_eps harus tetap GREATEST');
});

// ── 2) picker kamenime: kunci library dari source_pattern ────────────────
t('2a) picker kamenime tidak lagi memakai sanitizeSlug(title) langsung', () => {
  const b = pickerBlok();
  assert.ok(!/episodeStatusMap\(`anime:\$\{sanitizeSlug\(title\)\}`, title\)/.test(b),
    'masih menebak slug dari judul — gagal kalau ejaan judul berubah');
  assert.ok(/resolveLibrarySlugByPattern\(/.test(b),
    'harus lewat resolveLibrarySlugByPattern (source_pattern stabil)');
});

t('2b) resolveLibrarySlugByPattern ada & benar', () => {
  assert.ok(/async function resolveLibrarySlugByPattern/.test(ES), 'helper tidak ada');
  const i = ES.indexOf('async function resolveLibrarySlugByPattern');
  const blk = ES.slice(i, i + 1200);
  assert.ok(/kamenimeSourcePattern\(animeUrl\)/.test(blk),
    'harus ambil pola dari URL');
  assert.ok(/findMediaByPattern\(/.test(blk), 'harus cari lewat findMediaByPattern');
  // Fallback WAJIB di akhir fungsi: kalau DB tidak punya source_pattern-nya
  // (anime baru, DB belum terisi, atau DB error), picker harus tetap tampil
  // dengan slug tebakan — bukan null/'' yang membuat episodeStatusMap mencari
  // kunci kosong sehingga tidak ada episode yang terdeteksi.
  const akhir = blk.slice(blk.lastIndexOf('} catch'));
  assert.ok(/return (fb|fallback);\s*\n?\s*\}/.test(akhir),
    `fungsi harus berakhir "return fb;" setelah catch; dapat: ${akhir.slice(-140)}`);
  assert.ok(!/catch\s*\{\s*\}\s*return/.test(blk),
    'catch kosong yang langsung return tanpa fallback');
  // Jangan pernah mengembalikan nilai kosong sebagai hasil akhir.
  assert.ok(!/catch[\s\S]{0,120}return (null|''|"");/.test(blk),
    'catch tidak boleh mengembalikan null/kosong — picker kehilangan kunci');
  // Tidak boleh pakai pool.query tanpa import (ReferenceError)
  assert.ok(!/pool\.query/.test(blk), 'jangan pakai pool.query — pool tidak di-import di sini');
});

t('2c) parseKamenimeEpisode ada & menghasilkan provider hokireceh', () => {
  assert.ok(/function parseKamenimeEpisode/.test(ES), 'parser episode kamenime tidak ada');
  const i = ES.indexOf('function parseKamenimeEpisode');
  const blk = ES.slice(i, i + 900);
  assert.ok(/provider: 'hokireceh'/.test(blk),
    'provider harus hokireceh — sama dengan yang dipakai picker & library');
  assert.ok(/\\\/episode\\\//.test(blk) || /episode\\/.test(blk),
    'harus mem-parse nomor episode dari URL');
});

t('2d) picker kamenime WAJIB lewat helper, bukan slug tebakan langsung', () => {
  const b = pickerBlok();
  // M2 (slug tebakan tanpa source_pattern) harus tertangkap di sini juga.
  const tebakan = b.match(/episodeStatusMap\(\s*`anime:\$\{sanitizeSlug\([^`]*\)`\s*,/);
  assert.ok(!tebakan,
    'episodeStatusMap masih dipanggil dengan slug hasil tebakan judul — '
    + 'gagal kalau ejaan judul saat simpan berbeda');
  assert.ok(/resolveLibrarySlugByPattern\(animeUrl,/.test(b),
    'harus menyertakan animeUrl sebagai sumber pola (source_pattern)');
});

t('2e) helper mengembalikan slug dari DB, bukan slug tebakan', () => {
  const i = ES.indexOf('async function resolveLibrarySlugByPattern');
  const blk = ES.slice(i, i + 1300);
  const posHelper = blk.indexOf('findMediaByPattern(pat)');
  const posReturn = blk.lastIndexOf('return fb;');
  assert.ok(posHelper > 0, 'harus memanggil findMediaByPattern');
  assert.ok(posReturn > posHelper,
    `return fallback harus SESUDAH mencoba DB (helper@${posHelper}, return@${posReturn}) `
    + '— kalau tidak, slug tebakan selalu menang dan picker salah');
});

// ── 3) picker kamenime: vidoyKeysFromEpisodes + done dari st.tg ──────────
t('3a) picker kamenime punya vidoyKeysFromEpisodes (seperti 2 picker lain)', () => {
  const b = pickerBlok();
  assert.ok(/vidoyKeysFromEpisodes\(eps, parseKamenimeEpisode\)/.test(b),
    'tanpa extraVidoyKeys, episode yang judulnya beda ejaan tidak akan ditemukan');
});

t('3b) picker kamenime mengisi done dari st.tg', () => {
  const b = pickerBlok();
  assert.ok(/for \(const \[ep, st\] of statusMap\) if \(st\.tg\) done\.add\(ep\)/.test(b),
    'done harus diisi dari statusMap — tanpa ini tombol tidak pernah hijau');
});

t('3c) ketiga picker seragam: semua punya vidoyKeysFromEpisodes + done', () => {
  for (const [nama, marker] of [
    ['kamenime', 'async function buildKamenimeEpisodePicker'],
    ['samehadaku', 'async function buildSamehadakuEpisodePicker'],
    ['kuronime', 'async function buildKuronimeEpisodePicker'],
  ]) {
    const i = BOT.indexOf(marker);
    assert.ok(i > 0, `${nama} picker tidak ditemukan`);
    const next = BOT.indexOf('async function build', i + 20);
    const blk = BOT.slice(i, next > i ? next : i + 3000);
    assert.ok(/vidoyKeysFromEpisodes\(/.test(blk), `${nama}: tidak punya vidoyKeysFromEpisodes`);
    assert.ok(/if \(st\.tg\) done\.add\(ep\)/.test(blk), `${nama}: done tidak diisi dari st.tg`);
  }
});

// ── Anti-regresi ─────────────────────────────────────────────────────────
t('r1) keduanya di-export dari episode-status.js', () => {
  const i = ES.lastIndexOf('module.exports');
  const blok = ES.slice(i);
  assert.ok(/resolveLibrarySlugByPattern/.test(blok), 'resolveLibrarySlugByPattern tidak di-export');
  assert.ok(/parseKamenimeEpisode/.test(blok), 'parseKamenimeEpisode tidak di-export');
});

t('r2) bot.js meng-import semua yang dipakai', () => {
  const re = /const \{([^}]+)\} = require\('\.\/lib\/episode-status'\)/;
  const m = BOT.match(re);
  assert.ok(m, 'import episode-status tidak ditemukan');
  for (const nama of ['episodeStatusMap', 'vidoyKeysFromEpisodes', 'resolveLibrarySlugByPattern', 'parseKamenimeEpisode']) {
    assert.ok(m[1].includes(nama), `${nama} dipakai tapi tidak di-import dari episode-status`);
  }
});

t('r3) prefix picker kamenime tetap "kam" (tidak balik ke default "sam")', () => {
  const b = pickerBlok();
  assert.ok(/prefix: 'kam'/.test(b), 'prefix picker kamenime HARUS "kam"');
  assert.ok(!/prefix: 'sam'/.test(b), 'prefix "sam" akan menjalankan parser Samehadaku');
});

t('r4) handleKamenimeUrl: pola dari URL DULUAN, nama file hanya fallback', () => {
  const d = fs.readFileSync(path.join(ROOT, 'handlers', 'download.js'), 'utf8');
  const baris = d.split('\n').find((l) => l.includes('kamenimeSourcePattern(url)'));
  assert.ok(baris, 'tidak ada baris dengan kamenimeSourcePattern(url)');
  // Bentuk yang benar: pola dari URL dipakai PERTAMA, nama file hanya cadangan.
  // Kalau urannya dibalik, tiap episode punya pattern berbeda sehingga
  // findMediaByPattern tidak pernah connect.
  const posisiUrl = baris.indexOf('kamenimeSourcePattern(url)');
  const posisiFallback = baris.indexOf('sanitizeSlug(kmName)');
  if (posisiFallback < 0) return;                 // tidak ada fallback = lebih aman
  assert.ok(posisiUrl < posisiFallback,
    `pola dari URL harus sebelum fallback nama file. Baris: ${baris.trim()}`);
});

console.log(`\n${passed} pass / ${failed} fail`);
process.exit(failed ? 1 : 0);
