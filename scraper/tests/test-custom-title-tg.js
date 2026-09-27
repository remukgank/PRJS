'use strict';

// Verifikasi judul kustom ("Ganti Judul") diteruskan ke handler di jalur Telegram.
//
// MASALAH: di blok `if (target === 'tg')` (bot.js:4384-4405), user mengetik judul
// lewat "Ganti Judul", tapi 5 dari 6 cabang meneruskan `detectedTitle` —
// yaitu hasil lookup ke library. Untuk judul baru hasilnya null, jadi caption
// jatuh ke nama file mentah. `titleForCap` (sudah = customTitle || detectedTitle)
// ada di baris 4381 tapi tidak tersambung ke cabang mana pun.
//
// Test ini TIDAK menyalin logikanya: blok kode ASLI diekstrak dari bot.js lalu
// dijalankan dengan stub — seperti test-dell-vdell-logging.js.
//
// Run: node scraper/tests/test-custom-title-tg.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BOT = path.join(__dirname, '..', 'bot.js');
const src = fs.readFileSync(BOT, 'utf8');

let passed = 0;
let failed = 0;
const queue = [];
// t() hanya mendaftarkan; yang menjalankan+await adalah main() di bawah.
// Versi sinkron pernah membuat test yang balik Promise selalu "PASS".
const t = (name, fn) => queue.push({ name, fn });

/**
 * Potong blok `if (target === 'tg') { … }` yang ADA DI DALAM dl_go.
 *
 * PENTING: ada TIGA blok `if (target === 'tg')` di bot.js — 3704 dan 4212
 * ada di dalam loop batch Samehadaku/Kuronime (mengandung `break`/`continue`),
 * yang kita butuh adalah yang ketiga di dalam `dl_go:`. Versi pertama
 * memakai indexOf() → mengambil yang pertama → "Illegal break statement".
 * Jadi sekarang: pakai lastIndexOf, dan)PENJAGA di bawah memverifikasi isi.
 */
function extractTgBlock() {
  const start = src.lastIndexOf("if (target === 'tg') {");
  assert.ok(start >= 0, "blok `if (target === 'tg')` tidak ditemukan di bot.js");
  let depth = 0;
  let end = -1;
  for (let k = start; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) { end = k + 1; break; } }
  }
  assert.ok(end > start, 'blok tidak tertutup — struktur bot.js berubah?');
  return src.slice(start, end);
}

const TG_BLOCK = extractTgBlock();

/** Jalankan blok asli dengan stub; kembalikan handler mana + judul yang dipakai. */
async function dispatch({ target, customTitle, detectedTitle, kind, gdriveCb }) {
  const calls = [];
  const rec = (name) => (chatId, url, title) => { calls.push({ name, title }); return { name, title }; };
  const scope = {
    target,
    customTitle,
    detectedTitle,
    // baris 4381 bot.js — DI LUAR blok `if (target === 'tg')`, jadi harus
    // disuntik stub dengan rumus yang sama persis.
    titleForCap: customTitle || detectedTitle || undefined,
    url: 'https://contoh.test/file.mp4',
    chatId: -100,
    // hanya provider yang diuji yang true
    isGofileUrl: (u) => kind === 'gofile',
    isGdriveUrl: (u) => kind === 'gdrive',
    isPixeldrainUrl: (u) => kind === 'pixeldrain',
    isFiledonUrl: (u) => kind === 'filedon',
    isKamenimeUrl: (u) => kind === 'kamenime',
    isMegaUrl: (u) => kind === 'mega',
    handleGofileUrl: rec('gofile'),
    handleGdriveUrl: rec('gdrive'),
    handlePixeldrainUrl: rec('pixeldrain'),
    handleFiledonUrl: rec('filedon'),
    handleKamenimeUrl: rec('kamenime'),
    handleMegaUrl: rec('mega'),
    // gdrive: parser DILETAK karena logika season/part yang diuji ada di bot.js
    resolveGdriveFile: async () => ({ name: 'Judul.Custom.S2.P3.1080p.mp4' }),
    parseSamehadakuFilename: () => gdriveCb || null,
    isFunction: typeof String,
  };
  const keys = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const factory = new Function(keys.join(','), `return (async () => {\n${TG_BLOCK}\n})();`);
  const ret = await factory(...keys.map((k) => scope[k]));
  return { calls, ret };
}

const PROVIDERS = [
  ['gofile', 'handleGofileUrl'],
  ['gdrive', 'handleGdriveUrl'],
  ['pixeldrain', 'handlePixeldrainUrl'],
  ['filedon', 'handleFiledonUrl'],
  ['mega', 'handleMegaUrl'],
  ['kamenime', 'handleKamenimeUrl'],
];

// (a) customTitle ada → semua cabang harus memakai custom, bukan detected
for (const [kind, fn] of PROVIDERS) {
  t(`(a) ${fn}: customTitle dipakai, bukan detectedTitle`, async () => {
    const { calls, ret } = await dispatch({
      target: 'tg', kind, customTitle: 'Judul Kustom User', detectedTitle: 'Judul Dari Library',
    });
    assert.strictEqual(calls.length, 1, `${fn} harus dipanggil tepat sekali`);
    assert.strictEqual(calls[0].name, kind, `handler yang salah: ${calls[0].name}`);
    assert.strictEqual(calls[0].title, 'Judul Kustom User',
      `${fn} memakai "${calls[0].title}", harusnya judul kustom`);
    assert.ok(ret && ret.title === 'Judul Kustom User', 'nilai balik bukan judul kustom');
    return `${kind} → "${calls[0].title}"`;
  });
}

// (b) customTitle null + detectedTitle ada → tetap detected (regresi)
for (const [kind, fn] of PROVIDERS) {
  t(`(b) ${fn}: tanpa customTitle → tetap detectedTitle (regresi)`, async () => {
    const { calls } = await dispatch({
      target: 'tg', kind, customTitle: null, detectedTitle: 'Judul Dari Library',
    });
    assert.strictEqual(calls[0].title, 'Judul Dari Library',
      `${fn} harusnya "Judul Dari Library", dapat "${calls[0].title}"`);
    return `${kind} → "${calls[0].title}"`;
  });
}

// (c) keduanya null → undefined, tidak crash (regresi)
for (const [kind, fn] of PROVIDERS) {
  t(`(c) ${fn}: keduanya null → undefined, tidak crash (regresi)`, async () => {
    const { calls } = await dispatch({
      target: 'tg', kind, customTitle: null, detectedTitle: null,
    });
    assert.strictEqual(calls[0].title, undefined,
      `${fn} harusnya undefined, dapat ${JSON.stringify(calls[0].title)}`);
    return `${kind} → undefined`;
  });
}

// (d) gdrive + customTitle + season/part di filename → season/part tetap menempel
t('(d) gdrive: judul kustom + season/part dari filename tetap menempel', async () => {
  const { calls } = await dispatch({
    target: 'tg', kind: 'gdrive',
    customTitle: 'Judul Kustom User', detectedTitle: 'Judul Dari Library',
    gdriveCb: { season: 2, part: 3 },
  });
  const got = calls[0].title;
  assert.ok(got.startsWith('Judul Kustom User'), `harus mulai dari judul kustom, dapat "${got}"`);
  assert.ok(/\bS2\b/.test(got), `season S2 hilang: "${got}"`);
  assert.ok(/\bP3\b/.test(got), `part P3 hilang: "${got}"`);
  return `gdrive → "${got}"`;
});

t('(d2) gdrive: judul kustom yang SUDAH punya S2 → tidak diduplikasi', async () => {
  const { calls } = await dispatch({
    target: 'tg', kind: 'gdrive',
    customTitle: 'Judul Kustom S2', detectedTitle: 'X',
    gdriveCb: { season: 2, part: 3 },
  });
  const got = calls[0].title;
  assert.strictEqual((got.match(/S2/g) || []).length, 1, `S2 terduplikasi: "${got}"`);
  assert.ok(/\bP3\b/.test(got), `P3 harus tetap ditambahkan: "${got}"`);
  return `gdrive → "${got}"`;
});

// CATATAN: test ini MENDOKUMENTASIKAN perilaku yang SUDAH ADA, bukan perilaku
// yang seharusnya. Assert apa adanya supaya tidak mengunci asumsi salah.
t('(d3) gdrive: season tanpa part → season TIDAK ditambahkan (quirk yang sudah ada)', async () => {
  const { calls } = await dispatch({
    target: 'tg', kind: 'gdrive',
    customTitle: 'Judul Kustom', detectedTitle: 'X',
    gdriveCb: { season: 4, part: null },
  });
  const got = calls[0].title;
  //_bot.js: `const hasP = gdsCb.part ? … : true;` → kalau part null, hasP=true,
  // sehingga `!hasS && !hasP` dan `hasS && !hasP` sama-sama false dan season
  // dibuang diam-diam. Ini PRE-EXISTING (perilaku season/part tidak boleh
  // diubah oleh fix ini) — dicatat, bukan dibetulkan. Laporan: docs/audit.
  assert.strictEqual(got, 'Judul Kustom',
    `perilaku aktual harus "Judul Kustom" (season dibuang), dapat "${got}"`);
  assert.ok(!/\bS4\b/.test(got), 'kalau S4 muncul, perilaku lama sudah berubah — regression');
  return `gdrive → "${got}"  (S4 dibuang — quirk pre-existing, sengaja tidak diubah)`;
});

// penjaga: blok yang diuji benar-benar dari bot.js & kamenime tidak berubah
t('penjaga: blok yang diekstrak memang blok dl_go (bukan loop batch)', () => {
  for (const h of ['handleGofileUrl', 'handleGdriveUrl', 'handlePixeldrainUrl',
    'handleFiledonUrl', 'handleKamenimeUrl', 'handleMegaUrl']) {
    assert.ok(TG_BLOCK.includes(h), `blok tidak memuat ${h} — ekstraksi salah blok?`);
  }
  assert.ok(!/\bbreak\b|\bcontinue\b/.test(TG_BLOCK),
    'blok memuat break/continue → itu loop batch, bukan dl_go');
  return `6 handler ditemukan, panjang ${TG_BLOCK.length} char`;
});

t('penjaga: kamenime tetap memakai titleForCap (tidak diubah commit 20ffc4e)', () => {
  assert.ok(/isKamenimeUrl\(url\)\) return handleKamenimeUrl\(chatId, url, titleForCap\)/.test(TG_BLOCK),
    'cabang kamenime harus tetap titleForCap');
  return 'kamenime → titleForCap ✓';
});

t('penjaga: tidak ada cabang yang masih meneruskan detectedTitle langsung', () => {
  const bad = [...TG_BLOCK.matchAll(/return handle\w+\(chatId, url, detectedTitle/g)];
  assert.deepStrictEqual(bad.map((m) => m[0]), [],
    `masih ada ${bad.length} cabang yang memakai detectedTitle langsung`);
  return `${PROVIDERS.length} cabang diverifikasi`;
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
