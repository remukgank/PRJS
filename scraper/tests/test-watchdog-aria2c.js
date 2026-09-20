/* Test watchdog downloadWithAria2c (stall + speed floor) + parsing downloaded bytes.
 * Server lokal: chunked (no content-length), Range-supporting, silent, slow-then-fast.
 * Run: node scraper/tests/test-watchdog-aria2c.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const TMP = path.join(os.homedir(), 'workspace', 'downloads');
fs.mkdirSync(TMP, { recursive: true });

const { downloadWithAria2c } = require('../downloader');

let failures = 0;
function ok(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures += 1;
}

function makeBuf(mb) {
  const b = Buffer.alloc(mb * 1024 * 1024, 0x61);
  return b;
}

// ── server helpers ────────────────────────────────────────────────────────────
function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function writeChunks(res, buf, chunkSize, delayMs, done) {
  let off = 0;
  const step = () => {
    if (off >= buf.length) { res.end(); done(); return; }
    if (res.destroyed) return;
    res.write(buf.subarray(off, off + chunkSize));
    off += chunkSize;
    setTimeout(step, delayMs);
  };
  step();
}

// A: chunked, no Content-Length (meniru dl.php gdriveplayer) — cukup lama utk muncul DL log
async function serverChunked() {
  const buf = makeBuf(32);
  return await startServer((req, res) => {
    res.writeHead(200, { 'Transfer-Encoding': 'chunked', 'Content-Type': 'video/mp2t' });
    writeChunks(res, buf, 1024 * 1024, 200, () => {});
  });
}

// B: Range-supporting (CDN-like), -x4 akan paralel
async function serverRange() {
  const buf = makeBuf(24);
  return await startServer((req, res) => {
    const SIZE = buf.length;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = +m[1], end = m[2] ? +m[2] : SIZE - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${SIZE}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
      writeChunks(res, buf.subarray(start, end + 1), 512 * 1024, 5, () => {});
    } else {
      res.writeHead(200, { 'Content-Length': SIZE });
      writeChunks(res, buf, 512 * 1024, 5, () => {});
    }
  });
}

// S: silent — Content-Length besar, body tidak pernah dikirim
async function serverSilent() {
  return await startServer((req, res) => {
    res.writeHead(200, { 'Content-Length': 80 * 1024 * 1024 });
    // jangan kirim apa pun
    req.on('close', () => { try { res.destroy(); } catch {} });
  });
}

// M: slow-then-fast — 50 KiB/s selama ~115s lalu akselerasi penuh
async function serverSlowThenFast() {
  const buf = makeBuf(12);
  let fastAt = Date.now() + 115000;
  return await startServer((req, res) => {
    const slow = Date.now() < fastAt;
    res.writeHead(200, { 'Content-Length': buf.length });
    let off = 0;
    const step = () => {
      if (res.destroyed || !res.writableEnded) {
        if (off >= buf.length) { res.end(); return; }
        const chunk = slow ? 50 * 1024 : 512 * 1024;
        const delay = slow ? 1000 : 5;
        res.write(buf.subarray(off, off + chunk));
        off += chunk;
        setTimeout(step, delay);
      }
    };
    step();
  });
}

function runTest(name, url, outName, opts, timeoutMs, expect) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(TMP, outName);
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
    const logs = [];
    const started = Date.now();
    downloadWithAria2c(url, outPath, (l) => logs.push(l), {}, opts)
      .then((p) => resolve({ name, ok: true, path: p, elapsed: (Date.now() - started) / 1000, logs }))
      .catch((e) => resolve({ name, ok: false, err: e.message, elapsed: (Date.now() - started) / 1000, logs }));
  });
}

(async () => {
  // 1) chunked (gdriveplayer-like) — parsing downloaded + selesai
  const a = await serverChunked();
  const r1 = await runTest('A chunked', `http://127.0.0.1:${a.port}/f`, 'wd_chunked.bin', {}, 60000,
    { expect: 'done' });
  ok('A chunked completes', r1.ok, `elapsed ${r1.elapsed.toFixed(1)}s`);
  ok('A readout parsed (DL log muncul)', r1.logs.some((l) => /DL:/.test(l)), r1.logs.slice(0, 5).join(' | '));
  a.srv.close();

  // 2) Range + parallel (CDN) — no false-positive
  const b = await serverRange();
  const r2 = await runTest('B range-parallel', `http://127.0.0.1:${b.port}/f`, 'wd_range.bin', {}, 60000,
    { expect: 'done' });
  ok('B range-parallel completes (no false kill)', r2.ok, `elapsed ${r2.elapsed.toFixed(1)}s`);
  console.log('   logs:', r2.logs.slice(0, 4).join(' | '));
  b.srv.close();

  // 3) silent server → stall kill (~90-105s)
  const s = await serverSilent();
  const r3 = await runTest('S silent-stall', `http://127.0.0.1:${s.port}/f`, 'wd_silent.bin', {}, 170000,
    { expect: 'stall' });
  ok('S silent killed by stall watchdog', !r3.ok && /nol progres/.test(r3.err || ''), `${r3.err || '??'} (${r3.elapsed.toFixed(0)}s)`);
  s.srv.close();

  // 4) slow (50KiB/s) + speed floor ON → speed kill (~90-115s)
  const m = await serverSlowThenFast();
  const r4 = await runTest('M slow speedfloor-ON', `http://127.0.0.1:${m.port}/f`, 'wd_slow_on.bin', {}, 170000,
    { expect: 'speed' });
  ok('M speed floor fired', !r4.ok && /server terlalu lambat/.test(r4.err || ''), `${r4.err || '??'} (${r4.elapsed.toFixed(0)}s)`);

  // 5) slow host + disableSpeedFloor → must NOT be killed; selesai setelah speed-up
  const m2 = await serverSlowThenFast();
  const r5 = await runTest('D slow disabled', `http://127.0.0.1:${m2.port}/f`, 'wd_slow_off.bin', { disableSpeedFloor: true }, 170000,
    { expect: 'done' });
  ok('D disableSpeedFloor → completes, not killed (melewati slow phase)', r5.ok, `elapsed ${r5.elapsed.toFixed(0)}s (stall watchdog masih aktif tapi progres jalan)`);
  m.srv.close();
  m2.srv.close();

  // cleanup
  for (const f of ['wd_chunked.bin', 'wd_range.bin', 'wd_silent.bin', 'wd_slow_on.bin', 'wd_slow_off.bin', 'wd_slow_on.bin.aria2', 'wd_slow_off.bin.aria2', 'wd_silent.bin.aria2']) {
    try { fs.unlinkSync(path.join(TMP, f)); } catch {}
  }

  console.log(failures === 0 ? '\nALL TESTS PASS' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });