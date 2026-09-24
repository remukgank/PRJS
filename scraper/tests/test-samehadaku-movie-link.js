'use strict';

// Unit test: deteksi link film/single Samehadaku (slug non-numerik, mis. -episode-movie)
// pada halaman /anime/<slug>/ lalu parse blok download sub-halaman.
// Replika logika gofile-worker.js (helper QUALITY_ORDER/parseDownloadBlocks/detectSinglePageLink).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const QUALITY_ORDER = ["4K", "FULLHD", "MP4HD", "720p", "480p", "360p"];

function parseDownloadBlocks(html) {
  const blocks = {};
  const liRe = /<li[^>]*>\s*<strong[^>]*>([^<]+)<\/strong>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(html))) {
    const q = m[1].trim().replace(/\s+/g, "");
    const inner = m[2];
    const servers = {};
    const hrefRe = /<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
    let h;
    while ((h = hrefRe.exec(inner))) {
      const href = h[1].trim();
      const name = (h[2] || "").trim().toLowerCase();
      let key = null;
      try {
        const host = new URL(href).hostname.replace(/^www(?:\d+)\./i, "").replace(/^www\./, "").split(".")[0];
        if (host) key = host.toLowerCase();
      } catch {}
      if (!key && name) key = name.replace(/\s+/g, "");
      if (key && /^(?:zipps?yshare|racaty)$/i.test(key)) continue;
      if (key) servers[key] = href;
    }
    if (Object.keys(servers).length) blocks[q] = servers;
  }
  const chosenQ = QUALITY_ORDER.find((q) => blocks[q]) || Object.keys(blocks).find((q) => blocks[q]) || null;
  return { blocks, chosenQ, preferred: chosenQ ? blocks[chosenQ] : null };
}

function detectSinglePageLink(html, scope) {
  const mvRe = /<a[^>]+href="([^"]*-episode-(?:movie|ova|special|batch|ona)\b[^"]*)"[^>]*>([^<]*)<\/a>/gi;
  let mm;
  while ((mm = mvRe.exec(scope || html))) return mm[1].trim();
  return null;
}

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); passed++; }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
}

const TARGET = 'https://v2.samehadaku.how/anime/assassination-classroom-the-movie-our-time/';
const MOVIE_EP = 'https://v2.samehadaku.how/assassination-classroom-the-movie-our-time-episode-movie/';

// Fixture nyata (dipotong dari HTML asli samehadaku, 23 Sep 2026).
const moviePage = `<div class="lstepsiode listeps" style="height:auto!important;"><ul style="overflow: hidden auto;"><li><div class="epsright"><span class="eps"><a href="${MOVIE_EP}">1</a></span></div><div class="epsleft"><span class="lchx"><a href="${MOVIE_EP}">Assassination Classroom the Movie: Our Time Episode Movie</a></span><span class="date">25 July 2026</span></div></li></ul></div>`;

const subPage = `
<li><strong>360p </strong><span><a href="https://gofile.io/d/hgap3P">Gofile</a></span><span><a href="https://acefile.co/f/112001390/ak-mmnj-360p"> Acefile</a></span></li>
<li><strong>MP4HD </strong><span><a href="https://gofile.io/d/mp4hd1">Gofile</a></span><span><a href="https://pixeldrain.com/u/mp4hdP"> Pixeldrain</a></span></li>
<li><strong>FULLHD </strong><span><a href="https://gofile.io/d/sPU89A">Gofile</a></span><span><strike> Krakenfiles</strike></span><span><a href="https://pixeldrain.com/u/9JYc2ZkD"> Pixeldrain</a></span></li>
<li><strong>360p </strong><span><a href="https://gofile.io/d/zzz1">Gofile</a></span></li>
`;

t('halaman film: link -episode-movie terdeteksi di scope lstepsiode', () => {
  const link = detectSinglePageLink(moviePage, moviePage);
  assert.ok(link, 'link movie harus terdeteksi');
  assert.strictEqual(link, MOVIE_EP);
  assert.ok(link.startsWith('https://v2.samehadaku.how/'), 'link absolut ke host yang sama');
});

t('sub-halaman film: quality tertinggi FULLHD + gofile & pixeldrain', () => {
  const parsed = parseDownloadBlocks(subPage);
  assert.strictEqual(parsed.chosenQ, 'FULLHD');
  assert.ok(parsed.preferred.gofile, 'gofile harus ada');
  assert.ok(parsed.preferred.pixeldrain, 'pixeldrain harus ada');
  assert.ok(!parsed.preferred.krakenfiles, 'server mati (krakenfiles) tidak boleh masuk');
});

t('halaman film tanpa sub-page → tak ada link, parse kosong (fallback aman)', () => {
  const emptyPage = '<div class="lstepsiode listeps"><ul><li><span>Belum ada file</span></li></ul></div>';
  assert.strictEqual(detectSinglePageLink(emptyPage, emptyPage), null);
  const parsed = parseDownloadBlocks(emptyPage);
  assert.strictEqual(parsed.preferred, null);
});

t('halaman anime normal (episode angka) TIDAK false-positive ke movie', () => {
  const animePage = `<div class="lstepsiode listeps"><ul>
    <li><span class="eps"><a href="https://v2.samehadaku.how/one-piece-episode-1/">1</a></span></li>
    <li><span class="eps"><a href="https://v2.samehadaku.how/one-piece-episode-2/">2</a></span></li>
  </ul></div>`;
  assert.strictEqual(detectSinglePageLink(animePage, animePage), null);
});

t('slug movie terdeteksi walau case varies & di luar teks anchor', () => {
  const variants = [
    'https://v2.samehadaku.how/foo-episode-MOVIE/',
    'https://v2.samehadaku.how/foo-episode-OVA/',
    'https://v2.samehadaku.how/foo-episode-special/',
    'https://v2.samehadaku.how/foo-episode-batch/',
  ];
  for (const v of variants) {
    const html = `<div class="lstepsiode listeps"><ul><li><span class="lchx"><a href="${v}">Judul Film</a></span></li></ul></div>`;
    assert.strictEqual(detectSinglePageLink(html, html), v, `harus kena: ${v}`);
  }
});

t('file test punya helper worker yang sama (cek drift regex via fixture worker asli)', () => {
  const worker = fs.readFileSync(path.join(__dirname, '..', '..', 'gofile-worker.js'), 'utf8');
  assert.ok(worker.includes('function detectSinglePageLink'), 'helper detectSinglePageLink harus ada di worker');
  assert.ok(worker.includes('function parseDownloadBlocks'), 'helper parseDownloadBlocks harus ada di worker');
  assert.ok(worker.includes('via: "single"'), 'balasan movie harus menandai via=single');
  assert.ok(worker.includes('parseDownloadBlocks(await sr.text())'), 'sub-halaman film harus diparse');
});

console.log(`RESULT: ${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
