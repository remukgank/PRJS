#!/usr/bin/env node
// Cek link Vidoy satu per satu lewat browser sungguhan (Chromium headless).
// Verdik per link: apakah halaman MEMBUKA pemutar (videq_iframe + token)?
// Bukan sekadar "halaman tidak 404" — itu klaim yang terlalu lemah.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME_BIN
  || '/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium';
const OUT = process.env.OUT_CSV || __dirname + '/../../docs/audit/2026-09-26-vidoy-link-check-220.csv';
const from = Number(process.argv[2] || 1);
const to = Number(process.argv[3] || 20);

const ROOT = __dirname + '/..';
require(ROOT + '/node_modules/dotenv').config({ path: ROOT + '/../.env' });
const { pool } = require(ROOT + '/db.js');

function cek(code) {
  const tmp = require('os').tmpdir() + `/_vidoy_dom_${code}.html`;
  let dom = '';
  try {
    execFileSync(CHROME, [
      '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--virtual-time-budget=8000', '--dump-dom', `https://vidmonstr.com/e/${code}`,
    ], { timeout: 40000, stdio: ['ignore', fs.openSync(tmp, 'w'), 'ignore'] });
    dom = fs.readFileSync(tmp, 'utf8');
  } catch (e) {
    return { status: 'error', detail: 'gagal jalankan chromium' };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
  if (/404 Page Not Found/i.test(dom)) return { status: 'mati', detail: 'halaman 404' };
  const title = ((dom.match(/<title>([^<]*)<\/title>/) || [])[1] || '').trim();
  const iframe = dom.match(/<iframe id="videq_iframe"[^>]*src="([^"]+)"/);
  if (!iframe) return { status: 'tanpa-pemutar', detail: title.slice(0, 60) || '(tanpa judul)' };
  let file = '';
  try {
    const tok = new URL(iframe[1], 'https://vidmonstr.com').searchParams.get('t') || '';
    const json = JSON.parse(Buffer.from(tok, 'base64').toString('utf8'));
    if (json.t) file = json.t;
  } catch {}
  return { status: 'punya-pemutar', detail: file || title.slice(0, 60) };
}

(async () => {
  const r = await pool.query(
    "SELECT part, link FROM vidoy_uploads WHERE media_key='Naruto Kecil' AND part BETWEEN $1 AND $2 ORDER BY part",
    [from, to]);
  console.log(`  ▶ cek episode ${from}-${to} (${r.rows.length} link)\n`);
  const rows = [];
  for (const row of r.rows) {
    const code = String(row.link).split('/e/')[1];
    const v = cek(code);
    rows.push({ part: row.part, code, ...v });
    const mark = { 'punya-pemutar': 'OK  ', 'mati': 'MATI', 'tanpa-pemutar': 'GAGAL', error: 'ERR ' }[v.status];
    console.log(`     ${mark}  ep${String(row.part).padStart(3)}  ${code}  ${v.detail}`);
  }
  const hasil = {};
  rows.forEach((x) => { hasil[x.status] = (hasil[x.status] || 0) + 1; });
  console.log('\n  ── ringkasan ──');
  for (const [k, n] of Object.entries(hasil)) console.log(`     ${k.padEnd(14)} ${n}`);
  const csv = ['part,code,status,detail'].concat(
    rows.map((x) => `${x.part},${x.code},${x.status},"${String(x.detail).replace(/"/g, '')}"`)).join('\n');
  const mode = fs.existsSync(OUT) ? 'a' : 'w';
  if (mode === 'a') fs.appendFileSync(OUT, '\n' + csv.split('\n').slice(1).join('\n') + '\n');
  else fs.writeFileSync(OUT, csv + '\n');
  console.log(`     → ${OUT}`);
  await pool.end();
})().catch((e) => { console.log('ERR ' + e.message); process.exit(0); });
