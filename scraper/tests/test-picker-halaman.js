'use strict';
/*
 * Regression test — picker episode mengingat halaman asal.
 *
 * Bug (28 Sep 2026): "Kembali ke list episode" selalu membuka page 0, padahal
 * user sedang di page 59. Penyebabnya halaman tidak pernah dibawa di
 * callback_data tombol apa pun selain Prev/Next.
 *
 * Yang dikunci test ini:
 *  1. buildPicker menyisipkan page di SETIAP tombol yang dia hasilkan
 *  2. batas 64 byte callback_data Telegram diuji sungguhan, bukan diasumsikan
 *     (urlId = counter integer dari lib/urlCache.js:30, String(++urlCacheCounter))
 *  3. kompatibilitas DUA ARAH: format lama -> page 0, DAN keyboard baru ->
 *     page terbaca benar. Uji satu arah saja akan membiarkan bug "Kembali
 *     selalu ke page 1" lolos.
 *  4. parser bot.js (splitUrlAndPage / parseBatchPick) — utils di-load
 *     langsung dari sumber supaya tidak menguji salinan.
 */

const assert = require('assert');
const { buildPicker, paginate } = require('../lib/samKeyboard');

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(msg);
}
function eq(a, b, msg) {
  ok(a === b, `${msg} — dapat ${JSON.stringify(a)}, harap ${JSON.stringify(b)}`);
}

// ---------------------------------------------------------------------------
// Parser yang diuji: DI-EKSTRAK dari bot.js supaya menguji kode nyata.
// Menyalin definisi secara manual adalah cara memastikan test tidak menguji
// apa pun — mutasi di bot.js akan lolos (terbukti 28 Sep 2026, 7 dari 9 mutasi
// lolos sebelum test ini diperbaiki).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const BOT_SRC = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');

function ambilFungsi(nama) {
  const i = BOT_SRC.indexOf(`function ${nama}(`);
  if (i < 0) throw new Error(`fungsi ${nama} tidak ada di bot.js`);
  const j = BOT_SRC.indexOf('\n}', i);
  if (j < 0) throw new Error(`fungsi ${nama} tidak tertutup di bot.js`);
  return BOT_SRC.slice(i, j + 2);
}

const KODE_PRODUKSI = ambilFungsi('splitUrlAndPage') + '\n'
  + ambilFungsi('parseBatchPick');
const Produksi = new Function(KODE_PRODUKSI
  + '\nreturn { splitUrlAndPage, parseBatchPick };')();
const splitUrlAndPage = Produksi.splitUrlAndPage;
const parseBatchPickProduksi = Produksi.parseBatchPick;

// Dead code yang KHUSUS untuk fix ini: fungsi halaman yang tidak dipanggil
// siapa pun tidak bisa diuji mutasinya. pickPageFromData pernah ada seperti
// ini (28 Sep 2026) — mutasi "return 0" lolos karena tak ada jalur yang
// memakainya, jadi tidak terdeteksi. Fungsi sudah dihapus; test ini mencegah
// pola yang sama muncul lagi untuk helper halaman.
// Cakupannya sengaja sempit: bukan audit seluruh bot.js.
{
  eq(BOT_SRC.includes('pickPageFromData'), false,
    'pickPageFromData tidak boleh ada (dead code, tidak dipanggil)');
  const helpers = ['splitUrlAndPage', 'parseBatchPick'];
  for (const nama of helpers) {
    const calls = (BOT_SRC.match(new RegExp(`\\b${nama}\\(`, 'g')) || []).length;
    ok(calls >= 2, `${nama} dipanggil minimal sekali (bukan dead code) — jumlah: ${calls}`);
  }
}

// ---------------------------------------------------------------------------
// Fixture: 1171 episode seperti One Piece
// ---------------------------------------------------------------------------
const EPS = Array.from({ length: 1171 }, (_, i) => ({
  ep: i + 1,
  url: `https://v2.samehadaku.how/one-piece-episode-${i + 1}/`,
}));
const URL_ID = '1';              // counter fresh
const URL_ID_BESAR = '999999';   // counter 6 digit
const PAGINATE = paginate({ total: EPS.length, page: 58, pageSize: 20 });
const TOTAL_PAGES = PAGINATE.totalPages;
const PAGE_TUJUH = TOTAL_PAGES - 1;

const mkEp = (e, pg) => ({ text: `Ep ${e.ep}`, callback_data: `sam_ep:${e.url.slice(-4, -2)}:${pg}` });

function semuaCd(kb) {
  const out = [];
  for (const row of kb) for (const btn of row) if (btn && btn.callback_data) out.push(btn.callback_data);
  return out;
}

// === 1. buildPicker membawa page di semua tombol ===========================

const hasil = buildPicker(EPS, { urlId: URL_ID, page: PAGE_TUJUH, pageSize: 20, done: new Set(), mkEp, prefix: 'sam' });
const kb = hasil.keyboard;
const cd = semuaCd(kb);
ok(cd.length > 0, 'keyboard punya tombol');

// Download Semua membawa page
const all = cd.find((c) => c.startsWith('sam_all:'));
ok(!!all, 'ada tombol Download Semua');
ok(all && all.endsWith(`:${PAGE_TUJUH}`), `sam_all membawa page ${PAGE_TUJUH} — dapat ${all}`);

// Semua tombol episode membawa page
const eps = cd.filter((c) => c.startsWith('sam_ep:'));
// Halaman terakhir One Piece: ep 1161-1171 = 11 tombol (1171 % 20 = 11),
// bukan 20. Halaman penuh diuji terpisah di bawah.
const JUMLAH_EP_HALAMAN_TERAKHIR = 1171 % 20;
eq(eps.length, JUMLAH_EP_HALAMAN_TERAKHIR, 'tombol episode di halaman terakhir (1171 % 20)');
eq(PAGINATE.first, 1161, 'halaman terakhir mulai dari ep 1161');
eq(PAGINATE.last, 1171, 'halaman terakhir berakhir di ep 1171');
ok(eps.every((c) => c.endsWith(`:${PAGE_TUJUH}`)), `semua tombol episode membawa page — contoh: ${eps[0]}`);

// Nav tetap benar dan tidak berubah bentuknya.
// (Dulu .find() cukup karena Prev selalu pertama. Sekarang First/⏮ ada di
// depannya, jadi cari spesifik callback Prev, bukan tombol nav pertama.)
const prev = cd.find((c) => c === `sam_page:${PAGE_TUJUH - 1}:${URL_ID}`);
ok(!!prev, 'ada tombol navigasi');
eq(prev, `sam_page:${PAGE_TUJUH - 1}:${URL_ID}`, 'Prev menunjuk halaman sebelumnya');
const here = cd.filter((c) => c.startsWith('sam_page:') && c.endsWith(`:${URL_ID}`));
// Halaman terakhir: First + -10 + Prev + tombol halaman, TIDAK ada Next/+10/Last.
// (Dulu hanya Prev + tombol halaman. Tombol lompat ditambah 28 Sep agar ke
// page 59 tidak butuh 59× tap — hitungannya berubah, maksudnya tetap.)
eq(here.length, 4, 'halaman terakhir punya First + -10 + Prev + tombol halaman');
ok(here.includes(`sam_page:0:${URL_ID}`), 'ada First (⏮) ke halaman 0');
ok(here.includes(`sam_page:${PAGE_TUJUH - 10}:${URL_ID}`), 'ada -10 (⏪10)');
ok(!here.some((c) => c === `sam_page:${PAGE_TUJUH + 1}:${URL_ID}`), 'tidak ada Next di halaman terakhir');
ok(!here.some((c) => c === `sam_page:${PAGE_TUJUH + 10}:${URL_ID}`), 'tidak ada +10 di halaman terakhir');

// === 2. Batas 64 byte Telegram — diukur, bukan diasumsikan ===============

function buildSemua(urlId) {
  return semuaCd(buildPicker(EPS, { urlId, page: PAGE_TUJUH, pageSize: 20, done: new Set(), mkEp, prefix: 'sam' }).keyboard);
}

for (const [label, urlId] of [['counter 1 digit', URL_ID], ['counter 6 digit', URL_ID_BESAR]]) {
  for (const prefix of ['sam', 'kam', 'kur']) {
    const forms = [
      `${prefix}_all:${urlId}:${PAGE_TUJUH}`,
      `${prefix}_allgo:vyt:${urlId}:${PAGE_TUJUH}`,
      `${prefix}_allgo:tg:${urlId}:${PAGE_TUJUH}`,
      `${prefix}_allgo:vv:${urlId}:${PAGE_TUJUH}`,
      `${prefix}_fix:${urlId}:${PAGE_TUJUH}`,
      `${prefix}_ep:ab12cd34:${PAGE_TUJUH}`,
      `${prefix}_page:${PAGE_TUJUH}:${urlId}`,
      `${prefix}_page:${PAGE_TUJUH - 1}:${urlId}`,
      `${prefix}_back:${urlId}:${PAGE_TUJUH}`,
    ];
    for (const f of forms) {
      const bytes = Buffer.byteLength(f, 'utf8');
      ok(bytes <= 64, `callback_data <= 64 byte (${label}, ${prefix}) — "${f}" = ${bytes} byte`);
    }
  }
}

// Angka acuan: format terpanjang yang muncul di picker
const terpanjang = `sam_allgo:vyt:${URL_ID_BESAR}:${TOTAL_PAGES}`;
ok(Buffer.byteLength(terpanjang, 'utf8') === 23,
  `terpanjang 6 format = 23 byte (dapat ${Buffer.byteLength(terpanjang, 'utf8')})`);

// === 3. Kompatibilitas DUA ARAH ==========================================

// 3a. Format LAMA (tanpa page) -> page 0, urlId utuh
// Catatan: "sam_allgo:vyt:1" TIDAK diuji di sini. Format itu punya 3 bagian
// (prefix_allgo:target:urlId) dan dipecah oleh parseBatchPick, bukan
// splitUrlAndPage — diuji terpisah di blok parseBatchPick bawah.
for (const [cdlama, prefix] of [
  ['sam_all:1', 'sam_all'],
  ['sam_back:1', 'sam_back'],
  ['sam_ep:ab12cd34', 'sam_ep'],
  ['kur_back:1', 'kur_back'],
  ['kam_ep:ab12cd34', 'kam_ep'],
]) {
  const r = splitUrlAndPage(cdlama, prefix);
  eq(r.page, 0, `format lama "${cdlama}" -> page 0`);
  const tanpaPrefix = r.urlId.includes(':') ? r.urlId.split(':').pop() : r.urlId;
  eq(tanpaPrefix, cdlama.split(':').pop(), `format lama "${cdlama}" -> urlId utuh "${cdlama.split(':').pop()}"`);
}

// 3b. Format BARU -> page terbaca, urlId BERSIH (tanpa page)
for (const [cdbaru, prefix, urlIdHarus, pageHarus] of [
  ['sam_back:1:58', 'sam_back', '1', 58],
  ['kur_back:1:0', 'kur_back', '1', 0],
  ['sam_ep:ab12cd34:58', 'sam_ep', 'ab12cd34', 58],
  ['kam_ep:ab12cd34:117', 'kam_ep', 'ab12cd34', 117],
  ['sam_back:999999:58', 'sam_back', '999999', 58],
]) {
  const r = splitUrlAndPage(cdbaru, prefix);
  eq(r.urlId, urlIdHarus, `"${cdbaru}" -> urlId "${urlIdHarus}" (tanpa page)`);
  eq(r.page, pageHarus, `"${cdbaru}" -> page ${pageHarus}`);
}

// 3c. arah yang tidak boleh lolos: keyboard baru -> Kembali -> page benar
//     (ini yang dulu bikin "Kembali selalu ke page 1")
{
  const kcd = semuaCd(buildPicker(EPS, { urlId: '7', page: PAGE_TUJUH, pageSize: 20, done: new Set(), mkEp, prefix: 'sam' }).keyboard);
  const epBtn = kcd.find((c) => c.startsWith('sam_ep:'));
  const back = splitUrlAndPage(epBtn, 'sam_ep');
  eq(back.page, PAGE_TUJUH, 'tombol episode di page terakhir membawa page untuk kembali');
  const allBtn = kcd.find((c) => c.startsWith('sam_all:'));
  const backAll = splitUrlAndPage(allBtn, 'sam_all');
  eq(backAll.page, PAGE_TUJUH, 'Download Semua di page terakhir membawa page untuk kembali');
}

// 3d. page 0 bukan dianggap "format lama yang rusak"
eq(splitUrlAndPage('sam_back:1:0', 'sam_back').page, 0, 'page 0 eksplisit tetap 0, bukan diabaikan');
eq(splitUrlAndPage('sam_back:1:0', 'sam_back').urlId, '1', 'page 0 eksplisit tetap menyisakan urlId');

// 3e. nilai bukan angka di akhir = format lama, urlId TIDAK terpotong
{
  const r = splitUrlAndPage('sam_back:12:x', 'sam_back');
  eq(r.urlId, '12:x', 'suffix non-angka tidak memotong urlId');
  eq(r.page, 0, 'suffix non-angka -> page 0');
}

// === 4. Edge case pagination =============================================

{
  const c1 = semuaCd(buildPicker(EPS, { urlId: '1', page: 0, pageSize: 20, done: new Set(), mkEp, prefix: 'sam' }).keyboard);
  eq(c1.filter((x) => x.startsWith('sam_page:') && x.endsWith(':1')).length, 4,
    'page 0: tombol halaman + Next + +10 + Last (tanpa Prev/First/-10)');
  ok(!c1.some((x) => x === 'sam_page:-1:1'), 'tidak ada Prev dengan page -1');
  ok(!c1.some((x) => x.startsWith('sam_all:') && !x.endsWith(':0')), 'page 0 explicit di _all:');
}

// Episode di luar rentang dijepit, bukan error
{
  const c = semuaCd(buildPicker(EPS, { urlId: '1', page: 99999, pageSize: 20, done: new Set(), mkEp, prefix: 'sam' }).keyboard);
  const allBtn = c.find((x) => x.startsWith('sam_all:'));
  eq(allBtn, `sam_all:1:${PAGE_TUJUH}`, `page 99999 dijepit ke ${PAGE_TUJUH}`);
}

// semua episode sudah ada -> tombol all jadi disabled, page tidak boleh hilang
{
  const done = new Set(EPS.map((e) => e.ep));
  const c = semuaCd(buildPicker(EPS, { urlId: '1', page: PAGE_TUJUH, pageSize: 20, done, mkEp, prefix: 'sam' }).keyboard);
  const eps = c.filter((x) => x.startsWith('sam_ep:'));
  ok(eps.every((x) => x.endsWith(`:${PAGE_TUJUH}`)), 'tombol episode tetap bawa page walau semua sudah ada');
}

// ---------------------------------------------------------------------------
// parseBatchPick dari bot.js sungguhan.
// ---------------------------------------------------------------------------
for (const [prefix] of [['sam'], ['kam'], ['kur']]) {
  eq(JSON.stringify(parseBatchPickProduksi(`${prefix}_all:1`, prefix)),
    JSON.stringify({ target: '', urlId: '1', page: 0 }),
    `${prefix}_all:1 (lama) -> urlId 1 page 0`);
  eq(JSON.stringify(parseBatchPickProduksi(`${prefix}_allgo:vyt:1`, prefix)),
    JSON.stringify({ target: 'vyt', urlId: '1', page: 0 }),
    `${prefix}_allgo:vyt:1 (lama) -> target vyt urlId 1 page 0`);
  eq(JSON.stringify(parseBatchPickProduksi(`${prefix}_all:1:58`, prefix)),
    JSON.stringify({ target: '', urlId: '1', page: 58 }),
    `${prefix}_all:1:58 (baru) -> urlId 1 page 58`);
  eq(JSON.stringify(parseBatchPickProduksi(`${prefix}_allgo:vyt:1:58`, prefix)),
    JSON.stringify({ target: 'vyt', urlId: '1', page: 58 }),
    `${prefix}_allgo:vyt:1:58 (baru) -> target vyt urlId 1 page 58`);
  eq(JSON.stringify(parseBatchPickProduksi(`${prefix}_allgo:tg:999999:0`, prefix)),
    JSON.stringify({ target: 'tg', urlId: '999999', page: 0 }),
    `${prefix}_allgo:tg:999999:0 -> target tg urlId 999999 page 0`);
  const r = parseBatchPickProduksi(`${prefix}_all:123:58`, prefix);
  eq(r.urlId, '123', `${prefix}_all:123:58 -> urlId "123", bukan "123:58"`);
  eq(r.page, 58, `${prefix}_all:123:58 -> page 58`);
}

// ---------------------------------------------------------------------------
// mkEp di bot.js WAJIB menerima page dan menyisipkannya di callback_data.
// Dicek dari source (bukan mkEp salinan) — mkEp versi test hanya untuk
// memerlukan callback_data yang berbentuk.
// ---------------------------------------------------------------------------
{
  const src = BOT_SRC;
  const cands = [
    ['kam', /mkEp:\s*\(e,\s*pg\s*=\s*0\)\s*=>\s*\{[\s\S]{0,400}?callback_data:\s*`kam_ep:\$\{epId\}:\$\{pg\}`/],
    ['sam', /mkEp:\s*\(e,\s*pg\s*=\s*0\)\s*=>\s*\{[\s\S]{0,400}?callback_data:\s*`sam_ep:\$\{epId\}:\$\{pg\}`/],
    ['kur', /mkEp:\s*\(e,\s*pg\s*=\s*0\)\s*=>\s*\{[\s\S]{0,400}?callback_data:\s*`kur_ep:\$\{epId\}:\$\{pg\}`/],
  ];
  for (const [prefix, re] of cands) {
    ok(re.test(src), `mkEp picker ${prefix} menerima page (pg) dan menaruh di callback_data`);
  }
  // Tidak boleh ada mkEp yang masih tanpa page
  const tanpaPage = (src.match(/mkEp:\s*\(e\)\s*=>/g) || []).length;
  eq(tanpaPage, 0, 'tidak ada mkEp picker yang menerima (e) tanpa page');

  // Tombol Kembali wajib membawa page (tidak boleh hardcode 0 di picker list)
  for (const [label, re] of [
    ['sam Kembali', /callback_data:\s*`sam_back:\$\{bid\}:\$\{pickParsed\.page \|\| 0\}`/],
    ['kur Kembali', /callback_data:\s*`kur_back:\$\{bid\}:\$\{pickParsed\.page \|\| 0\}`/],
    ['kam Kembali', /callback_data:\s*`kam_page:\$\{kmPick\.page\}:\$\{kmBid\}`/],
    // kam_ep (tampilan episode) wajib punya Kembali juga — bukan cuma kam_all.
    // Tanpa ini, sekali klik episode tidak bisa balik ke list.
    ['kam_ep Kembali', /callback_data:\s*`kam_page:\$\{epPage\}:\$\{cacheUrl\(mAnimeKm\[1\]\)\}`/],
  ]) {
    ok(re.test(src), `${label} membawa page (bukan hardcode 0)`);
  }
  // Tombol Kembali TIDAK boleh lagi hardcode 0 tanpa page
  ok(!/callback_data:\s*`kam_page:0:\$\{kmBid\}`/.test(src), 'tidak ada lagi kam_page:0 hardcode');
  ok(!/callback_data:\s*`sam_back:\$\{bid\}`\s*\]/.test(src), 'tidak ada lagi sam_back tanpa page');

  // Handler _back: wajib meneruskan page ke picker
  ok(/buildSamehadakuEpisodePicker\(eps, animeUrl, backPage\)/.test(src),
    'handler sam_back meneruskan backPage ke picker');
  ok(/buildKuronimeEpisodePicker\(eps, animeUrl, backPage\)/.test(src),
    'handler kur_back meneruskan backPage ke picker');

  // Handler _ep: harus baca page lewat splitUrlAndPage, bukan slice fixed
  ok(/splitUrlAndPage\(data, 'kam_ep'\)/.test(src), 'handler kam_ep baca page via splitUrlAndPage');
  ok(!/const epId = data\.slice\(7\)/.test(src), 'tidak ada slice(7) untuk epId');
  ok(!/const rawUrl = data\.slice\(7\)/.test(src), 'tidak ada slice(7) untuk rawUrl episode');
  ok(!/const rawUrl = data\.slice\(9\)/.test(src), 'tidak ada slice(9) untuk rawUrl back');
}

// === 5. Bentuk keyboard Telegram (§4 AGENTS.md) ==========================
{
  const k = buildPicker(EPS, { urlId: '1', page: 0, pageSize: 20, done: new Set(), mkEp, prefix: 'sam' }).keyboard;
  ok(Array.isArray(k), 'keyboard adalah array');
  for (const row of k) {
    ok(Array.isArray(row), 'row adalah array');
    for (const btn of row) ok(typeof btn === 'object' && btn !== null, 'tombol adalah object');
  }
  // Telegram memotong keyboard > 100 tombol
  const total = k.reduce((n, row) => n + row.length, 0);
  ok(total <= 100, `total tombol ${total} <= 100`);
}

// === 6. Tombol lompat (First/Last/±10) — 28 Sep: ke page 59 tanpa 59 tap ===
{
  const nav = (page) => semuaCd(buildPicker(EPS, { urlId: '1', page, pageSize: 20, done: new Set(), mkEp, prefix: 'sam' }).keyboard)
    .filter((c) => c.startsWith('sam_page:'));
  // tengah (page 30 dari 59): semua 7 tombol navigasi ada
  const mid = nav(30);
  for (const [lbl, cd] of [
    ['First ⏮', 'sam_page:0:1'],
    ['-10 ⏪10', 'sam_page:20:1'],
    ['Prev', 'sam_page:29:1'],
    ['Number', 'sam_page:30:1'],
    ['Next', 'sam_page:31:1'],
    ['+10', 'sam_page:40:1'],
    ['Last ⏭', 'sam_page:58:1'],
  ]) ok(mid.includes(cd), `${lbl} ada → ${cd}`);
  // page 0: tanpa First/Prev/-10; page terakhir: tanpa Next/+10/Last
  const p0 = nav(0);
  ok(!p0.some((c) => c === 'sam_page:-1:1'), 'page 0: tidak ada page negatif');
  const plast = nav(58);
  ok(!plast.some((c) => /^sam_page:(59|68):1$/.test(c)), 'page terakhir: tidak ada yang melebihi 58');
  // semua callback lompat muat di batas 64 byte Telegram
  for (const cd of mid) ok(Buffer.byteLength(cd, 'utf8') <= 64, `${cd} <= 64 byte`);
}

// === 7. Label nav pendek (anti-truncate di layar kecil) =================
// Bukti screenshot 28 Sep: "⬅️ Prev" → "⬅️ Pr...", "📄 59/59" → "📄 59...".
// Label kata tidak muat; wajib simbol/angka saja. Callback tidak berubah.
{
  const navTexts = (page) => {
    const k = buildPicker(EPS, { urlId: '1', page, pageSize: 20, done: new Set(), mkEp, prefix: 'sam' }).keyboard;
    const navRow = k[k.length - 1];
    return navRow.map((b) => b.text);
  };
  for (const pg of [0, 30, 58]) {
    const texts = navTexts(pg);
    for (const t of texts) {
      ok(!/Prev|Next|📄/.test(t), `page ${pg}: label "${t}" harus simbol/angka, bukan kata`);
      ok([...t].length <= 6, `page ${pg}: label "${t}" maksimal 6 char`);
    }
  }
  eq(navTexts(30).join('|'), '⏮|⏪|⬅️|31/59|➡️|⏩|⏭', 'urutan + label nav tengah persis');
  eq(navTexts(0).join('|'), '1/59|➡️|⏩|⏭', 'urutan + label nav page 0 persis');
  eq(navTexts(58).join('|'), '⏮|⏪|⬅️|59/59', 'urutan + label nav terakhir persis');
}

// ---------------------------------------------------------------------------
console.log(`\ntest-picker-halaman: ${pass} pass / ${fail} fail`);
if (fail) {
  console.log('\nGAGAL:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
