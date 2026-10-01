'use strict';
/*
 * Regression test — target picker untuk "Ganti Judul" di provider langsung.
 *
 * Bug (28 Sep 2026, dilaporkan Ochi 22:43): kirim link Google Drive → tekan
 * "Ganti Judul" → ketik judul → bot LANGSUNG mengunduh dan mengirim ke
 * Telegram. Target picker (Telegram / Vidoy+TG / Vidoy) tidak pernah muncul.
 *
 * Root cause: bot.js blok "Pending download: custom title input" punya 6
 * cabang. 5 langsung memanggil handle*Url (gofile, pixeldrain, gdrive,
 * filedon, mega) — hanya kamenime yang menyimpan judul dulu lalu menampilkan
 * animeTargetKeyboard. Komentar di kode (baris 2569-2570) sudah menjelaskan
 * niat yang benar; penerapannya hanya di satu provider.
 *
 * Test ini mengekstrak kode dari bot.js, BUKAN menyalin definisi. Menyalin
 * definisi adalah cara memastikan test tidak menguji apa pun — pelajaran dari
 * fix "picker halaman" di hari yang sama, di mana 7 dari 9 mutasi lolos karena
 * test menyalin parser secara manual.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BOT_SRC = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; failures.push(name + ' — ' + e.message); console.log('FAIL  ' + name + '\n      ' + e.message); }
}

// ---------------------------------------------------------------------------
// Ekstrak blok custom title dari bot.js
// ---------------------------------------------------------------------------
function blokCustomTitle() {
  const i = BOT_SRC.indexOf('// ─── Pending download: custom title input');
  if (i < 0) throw new Error('blok "Pending download: custom title input" tidak ada di bot.js');
  // Ambil sampai batas penanda perintah berikutnya — blok custom title
  // adalah if yang memuat semua pencabangan provider.
  const j = BOT_SRC.indexOf("if (text === '/status')", i);
  if (j < 0) throw new Error('batas blok custom title tidak ditemukan');
  return BOT_SRC.slice(i, j);
}

const BLOK = blokCustomTitle();

// ---------------------------------------------------------------------------
// 1. TIDAK ADA provider yang boleh langsung mengunduh
// ---------------------------------------------------------------------------
const LANGSUNG = ['handleGofileUrl', 'handlePixeldrainUrl', 'handleGdriveUrl',
                  'handleFiledonUrl', 'handleMegaUrl'];

t('1) tidak ada provider yang langsung unduh di blok custom title', () => {
  const offenders = LANGSUNG.filter((fn) =>
    new RegExp('return\\s+' + fn + '\\(').test(BLOK));
  assert.strictEqual(offenders.length, 0,
    'masih ada provider yang langsung unduh: ' + offenders.join(', '));
});

t('2) tidak ada handle*Url sama sekali di blok itu', () => {
  const calls = BLOK.match(/handle[A-Za-z]+Url\s*\(/g) || [];
  assert.strictEqual(calls.length, 0,
    'blok custom title masih memanggil handler: ' + calls.join(', '));
});

// ---------------------------------------------------------------------------
// 2. Judul disimpan dulu, baru target ditanyakan
// ---------------------------------------------------------------------------
t('3) rememberCustomTitle dipanggil untuk semua provider', () => {
  assert.ok(/rememberCustomTitle\(pending\.url,\s*customTitle\)/.test(BLOK),
    'judul kustom harus disimpan dulu (rememberCustomTitle)');
});

t('4) animeTargetKeyboard dipakai di blok custom title', () => {
  assert.ok(/animeTargetKeyboard\(/.test(BLOK),
    'harus memakai animeTargetKeyboard untuk menanyakan target');
});

t('5) ketiga target terbentuk: tg, vyt, vv', () => {
  for (const target of ['dl_go:tg:', 'dl_go:vyt:', 'dl_go:vv:']) {
    assert.ok(BLOK.includes(target),
      `callback ${target} harus ada di blok custom title`);
  }
});

t('6) callback memakai urlId hasil cacheUrl, bukan URL mentah', () => {
  assert.ok(/const urlId = cacheUrl\(pending\.url\)/.test(BLOK),
    'urlId harus dari cacheUrl() supaya callback tetap pendek');
  assert.ok(/dl_go:tg:\$\{urlId\}/.test(BLOK),
    'callback harus memakai ${urlId}');
});

// ---------------------------------------------------------------------------
// 3. mega tidak bisa Vidoy → tombolnya harus dinonaktifkan
// ---------------------------------------------------------------------------
t('7) SEMUA provider dapat 3 tombol — tidak ada pengecualian', () => {
  // 28 Sep 2026 koreksi Ochi: semua provider (gofile/pixeldrain/gdrive/
  // filedon/mega) WAJIB punya Telegram | Vidoy+TG | Vidoy. Versi pertama
  // fix ini menyembunyikan tombol Vidoy untuk mega dengan asumsi "mega tidak
  // bisa di-Vidoy" — itu asumsi tanpa trace. Trace sebenarnya: resolveDirectUrl
  // memang null untuk mega, tapi itu KETERBATASAN jalur vyt/vv, bukan alasan
  // menyembunyikan tombol. Kalau tidak bisa, errornya harus muncul.
  assert.ok(!/vidoyOk/.test(BLOK), 'tidak boleh ada penyesuaian per provider di blok custom title');
  assert.ok(!/isMegaUrl/.test(BLOK), 'mega tidak boleh diperlakukan khusus di blok custom title');
  const pemanggil = BLOK.match(/animeTargetKeyboard\(([\s\S]{0,200}?)\);/);
  assert.ok(pemanggil, 'animeTargetKeyboard harus dipanggil');
  for (const t of ['dl_go:tg:', 'dl_go:vyt:', 'dl_go:vv:']) {
    assert.ok(pemanggil[1].includes(t), `semua tombol harus lewat argumen: ${t}`);
  }
  // tidak boleh ada argumen opsional yang mematikan tombol
  assert.ok(!/vidoyOk\s*:/.test(pemanggil[1]), 'tidak boleh mengirim argumen vidoyOk');
});

t('8) animeTargetKeyboard TIDAK punya pengecualian provider', () => {
  const i = BOT_SRC.indexOf('function animeTargetKeyboard');
  const body = BOT_SRC.slice(i, BOT_SRC.indexOf('\n}', i));
  assert.ok(!/opts\.vidoyOk/.test(body),
    'animeTargetKeyboard tidak boleh menerima opts.vidoyOk — semua provider sama');
  assert.ok(/const vidoyOk = Vidoy\.isConfigured\(\);/.test(body),
    'tombol Vidoy ditentukan hanya oleh isConfigured()');
});


t('10) animeTargetKeyboard mengembalikan ROW (bukan [f()]) — §4 AGENTS.md', () => {
  const i = BOT_SRC.indexOf('function animeTargetKeyboard');
  const body = BOT_SRC.slice(i, BOT_SRC.indexOf('\n}', i));
  assert.ok(/return BTN\.grid\(\[[\s\S]*\]\);/.test(body),
    'harus return BTN.grid([...]) — pemanggil wajib spread');
});

// ---------------------------------------------------------------------------
// 4. Label provider
// ---------------------------------------------------------------------------
t('11) PENDING_HANDLER_LABEL memuat keenam provider', () => {
  const i = BOT_SRC.indexOf('const PENDING_HANDLER_LABEL');
  assert.ok(i > -1, 'PENDING_HANDLER_LABEL harus ada');
  const j = BOT_SRC.indexOf('};', i);
  const blok = BOT_SRC.slice(i, j);
  for (const h of ['gofile', 'pixeldrain', 'gdrive', 'filedon', 'mega', 'kamenime']) {
    assert.ok(new RegExp(`\\b${h}:`).test(blok), `label untuk ${h} harus ada`);
  }
  assert.ok(/PENDING_HANDLER_LABEL\[pending\.handler\]/.test(BLOK),
    'blok custom title harus memakai label itu');
});

t('12) PENDING_HANDLER_LABEL bukan dead code', () => {
  const n = (BOT_SRC.match(/PENDING_HANDLER_LABEL/g) || []).length;
  assert.ok(n >= 2, `harus terdefinisi + dipakai (ditemukan ${n} kali)`);
});

// ---------------------------------------------------------------------------
// 5. Bukti falsifikasi: resolveDirectUrl mega = null (kode produksi)
// ---------------------------------------------------------------------------
t('13) resolveDirectUrl mega mengembalikan null di kode', () => {
  const DL = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'download.js'), 'utf8');
  const i = DL.indexOf('async function resolveDirectUrl');
  assert.ok(i > -1, 'resolveDirectUrl harus ada');
  const j = DL.indexOf('if (isMegaUrl(url))', i);
  assert.ok(j > -1, 'cabang mega harus ada di resolveDirectUrl');
  const k = DL.indexOf('}', DL.indexOf('return', j));
  assert.ok(DL.slice(j, k).includes('return null'),
    'mega harus return null di resolveDirectUrl — inilah alasan vidoyOk=false');
});

// ---------------------------------------------------------------------------
// 6. Kemunenian: dl_go: menangani keenam provider
// ---------------------------------------------------------------------------
t('14) dl_go: target=tg menangani keenam provider', () => {
  const i = BOT_SRC.indexOf("if (data.startsWith('dl_go:'))");
  assert.ok(i > -1, 'handler dl_go: harus ada');
  const body = BOT_SRC.slice(i, BOT_SRC.indexOf("data.startsWith('dl_title_custom:')", i) > i
    ? BOT_SRC.indexOf("data.startsWith('dl_title_custom:')", i)
    : i + 12000);
  for (const fn of ['isGofileUrl', 'isGdriveUrl', 'isPixeldrainUrl',
                    'isFiledonUrl', 'isKamenimeUrl', 'isMegaUrl']) {
    assert.ok(body.includes(fn), `dl_go: harus menangani ${fn}`);
  }
});

t('15) dl_go: membaca judul kustom (takeCustomTitle)', () => {
  const i = BOT_SRC.indexOf("if (data.startsWith('dl_go:'))");
  const body = BOT_SRC.slice(i, i + 4000);
  assert.ok(/takeCustomTitle\(url\)/.test(body),
    'dl_go: harus membaca judul kustom yang disimpan blok custom title');
});

t('16) takeCustomTitle menghapus nilai (bukan peek) agar sekali pakai', () => {
  const i = BOT_SRC.indexOf('function takeCustomTitle');
  const body = BOT_SRC.slice(i, BOT_SRC.indexOf('\n}', i));
  assert.ok(/delete\(/.test(body),
    'takeCustomTitle harus menghapus — kalau peek, judul bocor ke episode lain');
});

// ---------------------------------------------------------------------------
// 5b. BUKTI RUN — animeTargetKeyboard produksi benar-benar dijalankan
// ---------------------------------------------------------------------------
// Di atas semua hanya membaca source. Test ini mengekstrak fungsi dan
// MENJALANKANNYA dengan BTN tiruan, lalu memeriksa bentuk keyboard yang
//benar-benar dikirim ke Telegram (AGENTS.md §4).
function jalankanAnimeTargetKeyboard() {
  const src = BOT_SRC;
  function ambilFungsi(nama) {
    const i = src.indexOf('function ' + nama + '(');
    if (i < 0) throw new Error('fungsi ' + nama + ' tidak ada');
    const j = src.indexOf('\n}', i);
    return src.slice(i, j + 2);
  }
  const BTN = {
    btn: (text, data, style) => ({ text, callback_data: data, style }),
    btnOff: (text, style) => ({ text, callback_data: 'off', style, disabled: {} }),
    grid: (rows) => rows,
  };
  // animeTargetKeyboard memanggil require('./vidoy-uploader') di dalam fungsi.
  // new Function tidak punya require — harus disuntikkan (terbukti: run pertama
  // gagal "require is not defined").
  const req = require('module').createRequire(path.join(__dirname, '..', 'bot.js'));
  const kode = 'const require = __req__;\n'
    + ambilFungsi('targetBtn') + '\n'
    + ambilFungsi('animeTargetKeyboard')
    + '\nreturn animeTargetKeyboard;';
  const vidoyStub = { isConfigured: () => true };   // env bot selalu true (§7)
  return new Function('BTN', '__req__', kode)(BTN, req, vidoyStub);
}

t('17) JALANKAN produksi: gdrive dapat 3 tombol aktif', () => {
  const fn = jalankanAnimeTargetKeyboard();
  const kb = fn('dl_go:tg:1', 'dl_go:vyt:1', 'dl_go:vv:1');
  assert.ok(Array.isArray(kb), 'harus array of row');
  const flat = kb.flat();
  assert.strictEqual(flat.length, 3, 'harus 3 tombol (Telegram, Vidoy+TG, Vidoy)');
  assert.deepStrictEqual(flat.map((b) => b.callback_data),
    ['dl_go:tg:1', 'dl_go:vyt:1', 'dl_go:vv:1'],
    'ketiga callback harus aktif dan benar');
  assert.ok(flat.every((b) => !b.disabled), 'tidak ada tombol yang nonaktif untuk gdrive');
});

t('18) JALANKAN produksi: keenam provider dapat 3 tombol aktif', () => {
  const fn = jalankanAnimeTargetKeyboard();
  for (const [nama, id] of [['gofile', 1], ['pixeldrain', 2], ['gdrive', 3],
                            ['filedon', 4], ['mega', 5], ['kamenime', 6]]) {
    const kb = fn(`dl_go:tg:${id}`, `dl_go:vyt:${id}`, `dl_go:vv:${id}`);
    const flat = kb.flat();
    assert.strictEqual(flat.length, 3, `${nama} harus dapat 3 tombol`);
    assert.ok(flat.every((b) => !b.disabled),
      `${nama}: tidak boleh ada tombol nonaktif — semua provider konsisten`);
    assert.deepStrictEqual(flat.map((b) => b.callback_data),
      [`dl_go:tg:${id}`, `dl_go:vyt:${id}`, `dl_go:vv:${id}`],
      `${nama}: ketiga callback harus aktif`);
  }
});

t('19) JALANKAN produksi: bentuk keyboard sesuai §4 AGENTS.md', () => {
  const fn = jalankanAnimeTargetKeyboard();
  {
    const kb = fn('dl_go:tg:9', 'dl_go:vyt:9', 'dl_go:vv:9');
    assert.ok(kb.every((r) => Array.isArray(r)), 'inline_keyboard = array of row');
    assert.ok(kb.every((r) => r.every((b) => b && typeof b === 'object' && typeof b.text === 'string')),
      'row = array of object dengan text');
    const primary = kb.flat().filter((b) => b.style === 'primary');
    assert.ok(primary.length <= 1, 'maks 1 tombol primary per keyboard');
    assert.ok(kb.flat().every((b) => ['primary', 'success', 'danger'].includes(b.style)),
      'style hanya primary/success/danger — "link" tidak ada di Bot API');
  }
});

t('20) JALANKAN produksi: callback_data dalam batas 64 byte', () => {
  const fn = jalankanAnimeTargetKeyboard();
  // urlId realistis: counter 6 digit (lihat urlCache.js)
  const urlId = '999999';
  const kb = fn(`dl_go:tg:${urlId}`, `dl_go:vyt:${urlId}`, `dl_go:vv:${urlId}`);
  for (const b of kb.flat()) {
    const n = Buffer.byteLength(b.callback_data);
    assert.ok(n <= 64, `callback_data "${b.callback_data}" = ${n} byte, melebihi 64`);
  }
});

// ---------------------------------------------------------------------------
// Ringkasan
// ---------------------------------------------------------------------------
console.log('\n' + '-'.repeat(58));
console.log(`${pass} pass / ${fail} fail`);
if (fail) {
  console.log('\nGAGAL:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
