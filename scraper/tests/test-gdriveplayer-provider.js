/**
 * test-gdriveplayer-provider.js — resolver GDrivePlayer (bagian #2).
 *
 * Provider mengekstrak URL file asli + nama + kualitas dari halaman download.php
 * (GDrivePlayer). Tanpa network: fixture HTML kaptur asli disajikan via global.fetch
 * mock (Node 18+ punya fetch global; provider memakainya agar bisa di-test).
 *
 * Usage: node scraper/tests/test-gdriveplayer-provider.js
 */

const fs = require('fs');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures', 'samehadaku');
const { isGdrivePlayerUrl, resolveGdrivePlayerFile } = require('../providers/gdriveplayer');

function loadFixture(name) {
  return fs.readFileSync(path.join(FIX, name), 'utf8');
}

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

function mockHtml(html) {
  const prev = global.fetch;
  global.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : input?.url);
    const ua = init?.headers?.['User-Agent'] || init?.headers?.get('User-Agent') || '';
    const ref = init?.headers?.['Referer'] || init?.headers?.get('Referer') || '';
    ok(/Mozilla\/5\.0 .*Chrome\//.test(ua), `UA browser penuh dikirim (${ua.slice(0, 30)}...)`);
    ok(ref === 'https://samehadaku.how/', `Referer samehadaku dikirim (${ref})`);
    ok(/download\.php\?link=/.test(url), `fetch url download.php (${url.slice(0, 60)}...)`);
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  return () => { global.fetch = prev; };
}

(async () => {
  console.log('== A. isGdrivePlayerUrl ==');
  ok(isGdrivePlayerUrl('https://gdriveplayer.me/download.php?link=abc123'), 'gdriveplayer.me + download.php = true');
  ok(isGdrivePlayerUrl('https://gdriveplayer.to/download.php?link=abc123'), 'gdriveplayer.to + download.php = true');
  ok(!isGdrivePlayerUrl('https://gofile.io/d/abc'), 'gofile = false');
  ok(!isGdrivePlayerUrl('https://gdriveplayer.to/other'), 'tanpa download.php = false');

  console.log('== B. resolve: URL file asli + nama + kualitas dari halaman download.php ==');
  const restore = mockHtml(loadFixture('gdriveplayer-download.html'));
  try {
    const r = await resolveGdrivePlayerFile('https://gdriveplayer.to/download.php?link=TOKEN');
    ok(/^https:\/\/download\.[^"']+\/dl\.php\?t=/.test(r.fileUrl || ''), `fileUrl = download.*/dl.php?t= (${(r.fileUrl || '').slice(0, 60)}...)`);
    ok((r.fileName || '').includes('DBH-01-MP4HD-SAMEHADAKU.TV.mp4'), `fileName dari <h1> (${r.fileName})`);
    ok(r.quality === '360p', `quality dari tombol Download (${r.quality})`);
  } finally {
    restore();
  }

  console.log('== C. error: halaman tanpa link download → throw jelas ==');
  const restore2 = mockHtml('<html><body>Not found</body></html>');
  try {
    await resolveGdrivePlayerFile('https://gdriveplayer.to/download.php?link=TOKEN');
    ok(false, 'harus throw');
  } catch (e) {
    ok(/link download tidak ditemukan/.test(e.message), `throw: ${e.message.slice(0, 60)}`);
  } finally {
    restore2();
  }

  console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('ERROR:', err && err.stack || err);
  process.exit(1);
});