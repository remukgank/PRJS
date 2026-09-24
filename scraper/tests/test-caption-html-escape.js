'use strict';

// Unit test: preview kuronime wajib escape judul/episode sebelum dikirim parse_mode HTML.
// Replika komposisi preview bot.js + guard anti-drift ke file bot.js.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BOT_PATH = path.join(__dirname, '..', 'bot.js');
const bot = fs.readFileSync(BOT_PATH, 'utf8');

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function composeKuronimePreview(kurInfo, server, quality) {
  return `📦 <b>Preview Download</b>\n\n` +
    `➧ Judul :- <b>${escHtml(kurInfo?.title || '?')}</b>\n` +
    `➧ Episode :- ${escHtml(kurInfo?.episode || '?')}\n` +
    `➧ Provider :- kuronime\n` +
    `➧ Server :- ${server} (${quality})\n\nDownload?`;
}

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); passed++; }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
}

t('judul ber-& dan <> ter-escape (tolak 400 "can\'t parse entities")', () => {
  const info = { title: 'Tom & Jerry <Film>', episode: '1' };
  const preview = composeKuronimePreview(info, 'gofile', '1080p');
  assert.ok(preview.includes('Tom &amp; Jerry &lt;Film&gt;'), 'judul harus ter-escape');
  const inner = preview.match(/➧ Judul :- <b>([\s\S]*?)<\/b>/)[1];
  assert.strictEqual(inner, 'Tom &amp; Jerry &lt;Film&gt;');
  assert.ok(!/[<&](?!amp;|lt;|gt;|quot;|#\d+;)/.test(inner), 'tak ada & atau < mentah di dalam <b>');
});

t('judul normal tetap utuh (tanpa over-escape)', () => {
  const preview = composeKuronimePreview({ title: 'Yomi no Tsugai', episode: '8' }, 'pixeldrain', '720p');
  assert.ok(preview.includes('➧ Judul :- <b>Yomi no Tsugai</b>'));
  assert.ok(preview.includes('➧ Episode :- 8'));
});

t('kurInfo null → tetap "?" tanpa crash', () => {
  const preview = composeKuronimePreview(null, 'gofile', '4K');
  assert.ok(preview.includes('➧ Judul :- <b>?</b>'));
  assert.ok(preview.includes('➧ Episode :- ?'));
});

t('episode injection aman (mis. "1 <b>x</b>")', () => {
  const preview = composeKuronimePreview({ title: 'Safe', episode: '1 <b>x</b>' }, 'gofile', '4K');
  assert.ok(!preview.includes('1 <b>x</b>'), 'episode mentah tak boleh masuk');
  assert.ok(preview.includes('1 &lt;b&gt;x&lt;/b&gt;'));
});

t('anti-drift: bot.js preview kuronime wajib pakai escHtml', () => {
  assert.ok(bot.includes('escHtml(kurInfo?.title || \'?\')'), 'judul preview kuronime wajib escHtml');
  assert.ok(bot.includes('escHtml(kurInfo?.episode || \'?\')'), 'episode preview kuronime wajib escHtml');
});

t('anti-drift: preview samehadaku tetap escHtml (tak regression)', () => {
  assert.ok(/const titleSafe = escHtml\(/.test(bot), 'preview samehadaku wajib escHtml judul');
});

console.log(`RESULT: ${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
