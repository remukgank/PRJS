'use strict';

// Test baris Server (mode B — dinamis) + show_caption_above_media.
// Skenario: caption 5 baris saat link+server ada; 4 baris tanpa server;
// 3 baris tanpa link; pemanggil mengisi server dari host yang benar-benar
// memegang file (VIDOY/VIDARA), tidak pernah saat upload gagal.

const fs = require('fs');
const path = require('path');
const V = require('../scraper/handlers/vidoy');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (err) { fail++; console.log('FAIL  ' + name + ': ' + err.message); }
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error((msg || 'tidak cocok') + '\n    aktual : ' + JSON.stringify(actual) + '\n    harus  : ' + JSON.stringify(expected));
}

// ── 1. buildCaption: unit ────────────────────────────────────────────────────
t('caption anime + link + server VIDARA = 5 baris, urutan Link lalu Server', () => {
  const c = V.buildCaption({
    title: 'Dragon Ball', provider: 'hokireceh', part: 128, epStart: 128, epEnd: 128,
    link: 'https://vidara.to/DLYQlX8cF7T1M', server: 'VIDARA',
  });
  const lines = c.split('\n');
  eq(lines.length, 5, 'jumlah baris');
  eq(lines[3], '➧ Link :- <a href="https://vidara.to/DLYQlX8cF7T1M">https://vidara.to/DLYQlX8cF7T1M</a>', 'baris Link (label = URL penuh utk path tanpa /e/ — perilaku shortLinkLabel)');
  eq(lines[4], '➧ Server :- VIDARA', 'baris Server');
});

t('caption drama + link + server VIDOY = 5 baris', () => {
  const c = V.buildCaption({
    title: 'Drama X', provider: 'dramawave', part: 1, epStart: 1, epEnd: 10,
    link: 'https://vski.cc/e/abc', server: 'VIDOY',
  });
  eq(c.split('\n').length, 5, 'jumlah baris');
  eq(c.split('\n')[4], '➧ Server :- VIDOY', 'baris Server');
});

t('caption tanpa server = 4 baris, tidak ada baris Server', () => {
  const c = V.buildCaption({ title: 'X', provider: 'p', part: 1, epStart: 1, epEnd: 1, link: 'https://vski.cc/e/a' });
  eq(c.split('\n').length, 4, 'jumlah baris');
  if (c.includes('➧ Server')) throw new Error('baris Server muncul tanpa server: ' + c);
});

t('caption tanpa link & tanpa server = 3 baris', () => {
  const c = V.buildCaption({ title: 'X', provider: 'p', part: 1, epStart: 1, epEnd: 10 });
  eq(c.split('\n').length, 3, 'jumlah baris');
  if (c.includes('undefined')) throw new Error('ada undefined: ' + c);
});

t('server tidak pernah memuat "undefined"', () => {
  const c = V.buildCaption({ title: 'X', provider: undefined, part: 1, epStart: 1, epEnd: 1, link: 'https://vski.cc/e/a', server: undefined });
  if (c.includes('undefined')) throw new Error('ada undefined: ' + c);
});

// ── 2. Pemanggil: server dihitung dari host pemegang file ────────────────────
t('actionAnimeEpisode: server = VIDOY kalau link Vidoy, VIDARA kalau link Vidara', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scraper', 'handlers', 'vidoy.js'), 'utf8');
  if (!/const captionServer = vidoyLink \? 'VIDOY' : \(captionLink \? 'VIDARA' : ''\)/.test(src)) {
    throw new Error('actionAnimeEpisode tidak lagi menghitung captionServer dari host link');
  }
  if (!/link: captionLink, server: captionServer/.test(src)) {
    throw new Error('actionAnimeEpisode tidak meneruskan server ke buildCaption');
  }
});

t('drama merge10 (vidoy.js): server VIDOY hanya kalau item.link ada', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scraper', 'handlers', 'vidoy.js'), 'utf8');
  if (!/server: item\.link \? 'VIDOY' : ''/.test(src)) {
    throw new Error('merge10 Vidoy+TG tidak lagi mengisi server dengan benar');
  }
});

t('drama merge10 (vidara.js): Link + Server VIDARA hanya kalau fc ada', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scraper', 'handlers', 'vidara.js'), 'utf8');
  if (!/Server :- VIDARA/.test(src)) throw new Error('caption drama Vidara tanpa baris Server');
  if (!/\.\.\.\(vidaraLink \? \[`➧ Link :- <a href="\$\{vidaraLink\}">\$\{shortLinkLabel\(vidaraLink\)\}<\/a>`\] : \[\]\)/.test(src)) {
    throw new Error('caption drama Vidara tidak lagi mengisi baris Link bersyarat fc');
  }
  if (!/const vidaraCode = String\(fc \|\| ''\)/.test(src)) {
    throw new Error('fc tidak lagi dipakai untuk rekonstruksi link (fc di-scope out of try?)');
  }
});

t('kamenime manual (download.js): link null → tanpa baris Link & Server', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scraper', 'handlers', 'download.js'), 'utf8');
  if (!/link: null,\s*\n\s*\}\);/.test(src)) {
    throw new Error('handleKamenimeUrl tidak lagi memakai link: null (konsistensi: tanpa host = tanpa baris)');
  }
  if (/server:/.test(src.slice(src.indexOf('buildCaption('), src.indexOf('buildCaption(') + 400))) {
    throw new Error('handleKamenimeUrl mengisi server padahal tidak ada upload host');
  }
});

// ── 3. Fitur modern: caption di atas media (Bot API: show_caption_above_media)
t('lib/telegram sendVideo: show_caption_above_media di SEMUA jalur (>= 2)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scraper', 'lib', 'telegram.js'), 'utf8');
  const count = (src.match(/show_caption_above_media: true/g) || []).length;
  if (count < 2) throw new Error('hanya ' + count + ' (harus >= 2: local API + _bot.sendVideo)');
});

// ── 4. Skenario end-to-end caption (rekonstruksi dari kasus nyata) ──────────
t('skenario: episode vt yang di-skip → caption 5 baris dengan link rekonstruksi', () => {
  // Rekonstruksi sama persis dengan vidaraLinkFromRecord utk record DB nyata
  const rec = { filecode: 'DLYQlX8cF7T1M', domain: 'vidara.to' };
  const code = String(rec.filecode || '').replace(/^https?:\/\//i, '').split('/').filter(Boolean).pop() || '';
  const host = String(rec.domain || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const link = code && host ? `https://${host}/${code}` : '';
  eq(link, 'https://vidara.to/DLYQlX8cF7T1M', 'link rekonstruksi');
  const c = V.buildCaption({
    title: 'Dragon Ball', provider: 'hokireceh', part: 129, epStart: 129, epEnd: 129,
    link, server: 'VIDARA',
  });
  const lines = c.split('\n');
  eq(lines.length, 5, 'jumlah baris');
  eq(lines[4], '➧ Server :- VIDARA', 'baris Server');
  if (c.includes('undefined')) throw new Error('ada undefined: ' + c);
});

console.log(`\n${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
