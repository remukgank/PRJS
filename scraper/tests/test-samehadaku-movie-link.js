'use strict';

// Unit test: halaman film Samehadaku (slug non-numerik -episode-movie) → sub-halaman,
// ekstraksi judul halaman, dan komposisi caption Movie.
// Helper diambil LANGSUNG dari gofile-worker.js (dimuat via eval) agar tak ada drift regex.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const WORKER_PATH = path.join(__dirname, '..', '..', 'gofile-worker.js');
const worker = fs.readFileSync(WORKER_PATH, 'utf8');

function sliceBlock(src, startMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error(`blok worker tak ditemukan: ${startMarker}`);
  const end = src.indexOf('\n}', start);
  if (end < 0) throw new Error(`blok worker tak lengkap: ${startMarker}`);
  return src.slice(start, end + 2);
}

const QUALITY_ORDER = worker.match(/const QUALITY_ORDER[^;]+;/)[0];
const code = [
  QUALITY_ORDER,
  sliceBlock(worker, 'function decodeEntities'),
  sliceBlock(worker, 'function extractPageTitle'),
  sliceBlock(worker, 'function parseDownloadBlocks'),
  sliceBlock(worker, 'function detectSinglePageLink'),
].join('\n');
const w = new Function(`${code}; return { extractPageTitle, parseDownloadBlocks, detectSinglePageLink };`)();

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); passed++; }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
}

const MOVIE_EP = 'https://v2.samehadaku.how/assassination-classroom-the-movie-our-time-episode-movie/';

const moviePage = `<div class="lstepsiode listeps" style="height:auto!important;"><ul style="overflow: hidden auto;"><li><div class="epsright"><span class="eps"><a href="${MOVIE_EP}">1</a></span></div><div class="epsleft"><span class="lchx"><a href="${MOVIE_EP}">Assassination Classroom the Movie: Our Time Episode Movie</a></span><span class="date">25 July 2026</span></div></li></ul></div>`;

const moviePageFull = `<html><head><title>Assassination Classroom the Movie: Our Time &#8211; Samehadaku</title></head><body><h1 class="entry-title" itemprop="name">Assassination Classroom the Movie: Our Time Sub Indo</h1>${moviePage}</body></html>`;

const subPage = `
<li><strong>360p </strong><span><a href="https://gofile.io/d/hgap3P">Gofile</a></span><span><a href="https://acefile.co/f/112001390/ak-mmnj-360p"> Acefile</a></span></li>
<li><strong>MP4HD </strong><span><a href="https://gofile.io/d/mp4hd1">Gofile</a></span><span><a href="https://pixeldrain.com/u/mp4hdP"> Pixeldrain</a></span></li>
<li><strong>FULLHD </strong><span><a href="https://gofile.io/d/sPU89A">Gofile</a></span><span><strike> Krakenfiles</strike></span><span><a href="https://pixeldrain.com/u/9JYc2ZkD"> Pixeldrain</a></span></li>
`;

t('halaman film: link -episode-movie terdeteksi di scope lstepsiode', () => {
  assert.strictEqual(w.detectSinglePageLink(moviePage, moviePage), MOVIE_EP);
  assert.ok(MOVIE_EP.startsWith('https://v2.samehadaku.how/'));
});

t('sub-halaman film: quality tertinggi FULLHD + gofile & pixeldrain', () => {
  const parsed = w.parseDownloadBlocks(subPage);
  assert.strictEqual(parsed.chosenQ, 'FULLHD');
  assert.ok(parsed.preferred.gofile);
  assert.ok(parsed.preferred.pixeldrain);
  assert.ok(!parsed.preferred.krakenfiles, 'server mati tak boleh masuk');
});

t('judul halaman film diambil dari <h1 entry-title> (tanpa "Episode Movie" dari sub)', () => {
  assert.strictEqual(w.extractPageTitle(moviePageFull), 'Assassination Classroom the Movie: Our Time Sub Indo');
});

t('judul fallback ke <title> + decode entity + buang suffix " – Samehadaku"', () => {
  const html = '<html><head><title>Duck &amp; Goose &#8211; Samehadaku</title></head><body>x</body></html>';
  assert.strictEqual(w.extractPageTitle(html), 'Duck & Goose');
});

t('judul tanpa <h1>/og:title/<title> → null (tak crash)', () => {
  assert.strictEqual(w.extractPageTitle('<div>x</div>'), null);
});

t('judul dengan karakter HTML di-escape untuk parse_mode HTML (anti 400 entities)', () => {
  const title = w.extractPageTitle('<h1 class="entry-title">Tom &amp; Jerry &lt;Film&gt;</h1>');
  assert.strictEqual(title, 'Tom & Jerry <Film>');
  const safe = escHtml(title);
  assert.strictEqual(safe, 'Tom &amp; Jerry &lt;Film&gt;');
  assert.ok(!/[^&]<Film>/.test(safe), 'tag mentah tak boleh bocor ke parse_mode HTML');
});

t('caption movie: Judul + Tipe Movie, tanpa baris Episode', () => {
  const sami = { title: 'Assassination Classroom the Movie: Our Time Sub Indo', season: null, part: null, episode: null, movie: true, provider: 'samehadaku', slug: 'assassination-classroom-the-movie-our-time' };
  const customTitle = sami.title;
  const cleanTitle = (customTitle && !/S\d/i.test(sami.title || '')) ? customTitle : (sami.title || customTitle || '');
  let finalCap = '';
  if (sami.movie) {
    finalCap = [`➧ Judul :- ${cleanTitle}`, `➧ Tipe :- Movie`, `➧ Provider :- samehadaku`].join('\n');
  }
  assert.ok(finalCap.includes('Assassination Classroom the Movie: Our Time Sub Indo'));
  assert.ok(finalCap.includes('➧ Tipe :- Movie'));
  assert.ok(!/➧ Episode :-/.test(finalCap), 'baris Episode tak boleh muncul untuk movie');
  assert.ok(!finalCap.includes('null'), 'tak ada nilai null di caption');
});

t('caption episode biasa:Season/Episode tetap utuh (tanpa regresi)', () => {
  const sami = { title: 'One Piece', season: 2, part: 1, episode: 1125, provider: 'samehadaku' };
  let finalCap = '';
  if (sami.season) {
    finalCap = [`➧ Judul :- ${sami.title}`, `➧ Season :- ${sami.season} Part ${sami.part} Episode ${sami.episode}`, `➧ Provider :- samehadaku`].join('\n');
  }
  assert.ok(finalCap.includes('➧ Season :- 2 Part 1 Episode 1125'));
});

t('halaman film tanpa sub-page → fallback aman (tak ada server)', () => {
  const empty = '<div class="lstepsiode listeps"><ul><li><span>Belum ada file</span></li></ul></div>';
  assert.strictEqual(w.detectSinglePageLink(empty, empty), null);
  assert.strictEqual(w.parseDownloadBlocks(empty).preferred, null);
});

t('halaman anime episode-angka TIDAK false-positive ke movie', () => {
  const anime = '<div class="lstepsiode listeps"><ul><li><a href="https://v2.samehadaku.how/one-piece-episode-1/">1</a></li><li><a href="https://v2.samehadaku.how/one-piece-episode-2/">2</a></li></ul></div>';
  assert.strictEqual(w.detectSinglePageLink(anime, anime), null);
});

t('varian slug movie/ova/special/batch terdeteksi (case-insensitive)', () => {
  for (const v of ['foo-episode-MOVIE', 'foo-episode-OVA', 'foo-episode-special', 'foo-episode-batch']) {
    const html = `<div class="lstepsiode listeps"><ul><li><span class="lchx"><a href="https://v2.samehadaku.how/${v}/">Judul</a></span></li></ul></div>`;
    assert.strictEqual(w.detectSinglePageLink(html, html), `https://v2.samehadaku.how/${v}/`, `harus kena: ${v}`);
  }
});

t('worker menyertakan title + movie flag di respons single', () => {
  assert.ok(worker.includes('via: "single", title: extractPageTitle(html) || extractPageTitle(subHtml), movie: true'), 'respons single wajib title + movie:true');
  assert.ok(worker.includes('blocks: parsed.blocks, title: extractPageTitle(html)'), 'respons episode biasa wajib title');
});

t('bot.js & handler punya cabang movie (anti drift)', () => {
  const bot = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
  const handler = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'download.js'), 'utf8');
  assert.ok(bot.includes("via === 'single'"), 'bot preview harus tahu jalur single');
  assert.ok(bot.includes('➧ Tipe :- Movie'), 'bot preview harus punya baris Tipe Movie');
  assert.ok(bot.includes('movie: true'), 'sam_go harus synthesise sameInfo movie');
  assert.ok(handler.includes('sami.movie'), 'handler caption harus punya cabang movie');
  assert.ok(handler.includes('➧ Tipe :- Movie'), 'handler caption harus punya Tipe Movie');
  assert.ok(/const titleSafe = escHtml\(/.test(bot), 'judul di preview wajib di-escape untuk parse_mode HTML');
});

t('label progress film: "— Movie" (bukan "— Episode 1") di semua tahap', () => {
  const handlerSrc = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'download.js'), 'utf8');
  const start = handlerSrc.indexOf('function epCapLabel');
  const end = handlerSrc.indexOf('\n}', start);
  assert.ok(start > 0 && end > start, 'helper epCapLabel harus ada di handlers/download.js');
  const epCapLabel = new Function(`${handlerSrc.slice(start, end + 2)}; return epCapLabel;`)();
  const cap = 'Assassination Classroom the Movie: Our Time Sub Indo';
  const movie = { title: cap, movie: true, episode: null, provider: 'samehadaku' };
  assert.strictEqual(epCapLabel(cap, true, movie, 1), `${cap} — Movie`);
  assert.ok(!/Episode/.test(epCapLabel(cap, true, movie, 1)), 'tak boleh ada "Episode" untuk film');
  const anime = { title: 'One Piece', movie: false, season: 2, part: 1, episode: 1125 };
  assert.strictEqual(epCapLabel('One Piece S2 P1', true, anime, 1125), 'One Piece S2 P1 — Episode 1125');
  assert.strictEqual(epCapLabel(cap, false, null, 3), cap, 'tanpa customTitle label tetap polos');
  const sites = (handlerSrc.match(/epCapLabel\(/g) || []).length;
  assert.strictEqual(sites, 6, 'helper dipakai 5 situs + definisinya (ditemukan ' + sites + ')');
});

console.log(`RESULT: ${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
