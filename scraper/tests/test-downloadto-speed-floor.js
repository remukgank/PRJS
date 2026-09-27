'use strict';

// Regression test: speed floor + fail-fast resume di jalur downloadTo.
//
// Insiden 26 Sep 2026 (Naruto Shippuden ep 5, server gdriveplayer):
//   1) Unduhan berjalan 20–35 KiB/s — JAUH di bawah ambang 70 KiB/s — tapi
//      tidak pernah dibatalkan. Yang akhirnya membunuh hanya STALL_MS
//      (0 byte selama 20 dtk), bukan speed.
//   2) Setelah stall, ensureMp4 retry → downloadTo mengirim Range, tapi host
//      chunked mengabaikannya (status 200, bukan 206) → restart dari nol.
//      3x restart membuang ~65 MB tanpa satu byte berguna.
//
// Test ini memakai `opts.thresholds` dengan ambang kecil supaya logikanya bisa
// dibuktikan dalam hitungan detik; angka production (70 KiB/s / 90 dtk / 5 MiB)
// dikunci terpisah oleh test anti-drift di bawah.
//
// Run: node scraper/tests/test-downloadto-speed-floor.js

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { downloadTo, ensureMp4 } = require('../services/vidaraService');
const TH = require('../lib/download-thresholds');

let passed = 0;
let failed = 0;
const t = (name, fn) => {
  try { const r = fn(); if (r && typeof r.then === 'function') return r.then(() => { passed++; console.log(`PASS  ${name}`); }, (e) => { failed++; console.error(`FAIL  ${name}: ${e.message}`); }); passed++; console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
};

// Server lokal sungguhan. mode:
//   'slow'  → trickle di bawah ambang (uji speed floor)
//   'fast'  → hrs penuh (uji tidak false-positive)
//   'freeze'→ langsung diam (uji stall)
//   'ignore-range' → balas 200 walau Range diminta (uji fail-fast resume)
function startServer(mode) {
  return new Promise((resolve) => {
    let sent = 0;
    const srv = http.createServer((req, res) => {
      if (mode === 'ignore-range') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '4096' });
        return res.end(Buffer.alloc(4096));
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(50 * 1024 * 1024) });
      const chunk = Buffer.alloc(64 * 1024);
      const t = setInterval(() => {
        if (res.writableEnded) return clearInterval(t);
        if (mode === 'freeze') return;                    // diam total
        const n = mode === 'fast' ? 16 : 1;               // fast: 16 chunk/50ms ≈ 20 MB/s; slow: 1 chunk ≈ 1,3 MB/s…kejar ambang
        for (let i = 0; i < n; i++) { if (!res.write(chunk)) { res.once('drain', () => {}); break; } sent += chunk.length; }
      }, 50);
      res.on('close', () => clearInterval(t));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const tmp = (n) => path.join(os.tmpdir(), `dltest-${process.pid}-${n}`);
const FAST_TH = { SPEED_FLOOR_BPS: 70 * 1024, SPEED_WINDOW_MS: 900, SPEED_MIN_RUN_MS: 900, SPEED_MIN_BYTES: 128 * 1024, STALL_MS: 60000, PROGRESS_MS: 1000, WATCHDOG_MS: 50 };

(async () => {
  // ── a) speed floor: < ambang > window, > min bytes → kill "terlalu lambat" ──
  await t('a) < 70 KiB/s selama > window dengan > min bytes → kill speed floor', async () => {
    const { srv, port } = await startServer('slow');
    const dest = tmp('a.mp4');
    try { fs.rmSync(dest, { force: true }); fs.writeFileSync(dest, Buffer.alloc(0)); } catch {}
    const t0 = Date.now();
    let msg = null;
    try {
      // dest sudah ada 0 byte → have=0, jadi tak ada Range; speed floor murni.
      await downloadTo(`http://127.0.0.1:${port}/v`, dest, { thresholds: { ...FAST_TH, SPEED_FLOOR_BPS: 5 * 1024 * 1024 } });
    } catch (e) { msg = e.message; }
    const dt = Date.now() - t0;
    srv.close();
    assert.ok(msg && /terlalu lambat/.test(msg), `harus gagal speed floor, dapat: ${msg}`);
    assert.ok(/tidak menolong/.test(msg), `pesan harus menyebut retry tidak menolong: ${msg}`);
    assert.ok(dt < 8000, `harus cepat (~1-3s),进程 ${dt}ms`);
    console.log(`      → ${msg}  (${dt}ms)`);
  });

  // ── b) > ambang → TIDAK di-kill (tidak false-positive) ──
  await t('b) > 70 KiB/s → TIDAK di-kill (tidak false-positive)', async () => {
    const { srv, port } = await startServer('fast');
    const dest = tmp('b.mp4');
    fs.rmSync(dest, { force: true });
    const p = downloadTo(`http://127.0.0.1:${port}/v`, dest, { thresholds: FAST_TH });
    // tunggu cukup lama untuk speed floor sempat dievaluasi (window 900ms)
    await new Promise((r) => setTimeout(r, 1600));
    // belum harus gagal — masih mengunduh
    let done = false, err = null;
    p.then(() => { done = true; }, (e) => { err = e; });
    await new Promise((r) => setTimeout(r, 100));
    srv.close();
    assert.ok(!err, `tidak boleh gagal, dapat error: ${err && err.message}`);
    assert.ok(!done || true, 'tidak wajib selesai');
    // pastikan tidak ada galat speed floor
    assert.ok(!err || !/terlalu lambat/.test(err.message), 'tidak boleh kena speed floor');
  });

  // ── c) stall 20 dtk (production) → tetap di-kill ──
  await t('c) stall (0 byte) → tetap di-kill, pesan "macet"', async () => {
    const { srv, port } = await startServer('freeze');
    const dest = tmp('c.mp4');
    fs.rmSync(dest, { force: true });
    let msg = null;
    try {
      await downloadTo(`http://127.0.0.1:${port}/v`, dest, { thresholds: { ...FAST_TH, STALL_MS: 400, SPEED_MIN_RUN_MS: 999999, SPEED_MIN_BYTES: 999999999 } });
    } catch (e) { msg = e.message; }
    srv.close();
    assert.ok(msg && /macet/.test(msg), `harus gagal stall, dapat: ${msg}`);
    console.log(`      → ${msg}`);
  });

  // ── d) Range diabaikan (200, bukan 206) saat have>0 → noRetry, pesan resume ──
  await t('d) Range diabaikan (200 bukan 206) saat have>0 → noRetry "tidak mendukung resume"', async () => {
    const { srv, port } = await startServer('ignore-range');
    const dest = tmp('d.mp4');
    fs.writeFileSync(dest, Buffer.alloc(64 * 1024)); // partial → have>0 → Range dikirim
    let err = null;
    try {
      await downloadTo(`http://127.0.0.1:${port}/v`, dest, { thresholds: FAST_TH });
    } catch (e) { err = e; }
    srv.close();
    assert.ok(err, 'harus gagal');
    assert.ok(/tidak mendukung resume/.test(err.message), `pesan harus menyebut resume: ${err.message}`);
    assert.ok(err.noRetry === true, 'error harus ditandai noRetry agar ensureMp4 tidak retry');
    console.log(`      → ${err.message}  (noRetry=${err.noRetry})`);
  });

  // ── e) 416 dengan have > 0 → SUKSES (berkas sudah utuh di server) ──
  // 26 Sep 2026: blok 416 berada SETELAH `statusCode >= 400` sehingga tidak
  // terjangkau → 416 jatuh jadi error retryable dan ensureMp4 mengulang 4×
  // berkas yang sebenarnya sudah jadi. Persis "retry sia-sia" item 2.
  await t('e) 416 dengan have>0 → sukses (bukan error retryable)', async () => {
    const srv = http.createServer((req, res) => {
      assert.ok(req.headers.range, `server harus menerima Range; yang datang: ${JSON.stringify(req.headers.range)}`);
      res.writeHead(416); res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const dest = tmp('e.mp4');
    const partial = Buffer.alloc(1024, 0x5a);
    fs.writeFileSync(dest, partial);
    let err = null, resolved = false;
    try { await downloadTo(`http://127.0.0.1:${port}/v`, dest, { thresholds: FAST_TH }); resolved = true; }
    catch (e) { err = e; }
    srv.close();
    assert.ok(resolved, `416 dengan have>0 harus SUKSES, dapat error: ${err && err.message}`);
    assert.ok(!err, `tidak boleh ada error: ${err && err.message}`);
    // file parsial dibiarkan utuh — validasi (assertLooksLikeVideo) yang memvonis
    assert.ok(fs.readFileSync(dest).equals(partial), 'file tidak boleh ditimpa');
    console.log('      → 416 + have>0 = sukses (file dianggap sudah utuh, tanpa retry)');
  });

  // ── g) 416 dengan have == 0 → tetap ERROR (permintaan rusak) ──
  await t('g) 416 dengan have==0 → tetap error 416 (tidak salah accept)', async () => {
    const srv = http.createServer((req, res) => { res.writeHead(416); res.end(); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const dest = tmp('g.mp4');
    fs.rmSync(dest, { force: true }); // tidak ada file parsial → have = 0
    let err = null;
    try { await downloadTo(`http://127.0.0.1:${port}/v`, dest, { thresholds: FAST_TH }); }
    catch (e) { err = e; }
    srv.close();
    assert.ok(err, '416 tanpa Range harus tetap gagal');
    assert.ok(/HTTP 416/.test(err.message), `pesan harus menyebut 416, dapat: ${err && err.message}`);
    console.log(`      → 416 + have=0 = error "${err.message}" (permintaan rusak, bukan "sudah utuh")`);
  });

  // ── h) 416 harus Dicek SEBELUM >= 400 (anti-regresi urutan) ──
  await t('h) cabang 416 berada SEBELUM cek statusCode >= 400', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'vidaraService.js'), 'utf8');
    const i416 = src.indexOf('res.statusCode === 416');
    const i400 = src.indexOf('res.statusCode >= 400');
    assert.ok(i416 >= 0, 'blok 416 harus ada');
    assert.ok(i400 >= 0, 'cek >= 400 harus ada');
    assert.ok(i416 < i400, `blok 416 (idx ${i416}) harus SEBELUM >= 400 (idx ${i400}) — kalau tidak, 416 tidak terjangkau`);
  });

  // ── f) ensureMp4 TIDAK retry pada galat noRetry (anti retry sia-sia) ──
  // Item 2 proposal: "supaya retry sia-sia tidak terjadi". Flag noRetry di
  // downloadTo saja tidak cukup — yang harus dibuktikan adalah ensureMp4
  // benar-benar BERHENTI, bukan mengulang dengan URL fresh.
  await t('f) ensureMp4 berhenti di percobaan pertama saat server tak dukung resume', async () => {
    // Hitung request di sisi server: setiap retry ensureMp4 → downloadTo lagi
    // → satu HTTP request baru. Jadi jumlah request = jumlah percobaan.
    let attempts = 0;
    const srv = http.createServer((req, res) => {
      attempts++;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '4096' });
      res.end(Buffer.alloc(4096));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const dest = tmp('f.mp4');
    fs.writeFileSync(dest, Buffer.alloc(64 * 1024)); // partial → Range → server balas 200
    let err = null;
    try {
      await ensureMp4(`http://127.0.0.1:${port}/v`, dest, { retries: 3, backoffMs: 1, thresholds: FAST_TH });
    } catch (e) { err = e; }
    srv.close();
    assert.ok(err, 'harus gagal');
    assert.ok(/tidak mendukung resume/.test(err.message), `pesan: ${err.message}`);
    assert.strictEqual(attempts, 1, `harus CUMA 1 percobaan, bukan ${attempts} — retry sia-sia!`);
    console.log(`      → ${attempts} percobaan (bukan 4), pesan: ${err.message.slice(0, 55)}…`);
  });

  // ── Anti-drift: konstanta production = literal downloader.js ──
  await t('anti-drift: SPEED_* di lib/download-thresholds.js = literal downloader.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'downloader.js'), 'utf8');
    const grab = (name) => {
      const m = new RegExp(`const\\s+${name}\\s*=\\s*([^;]+);`).exec(src);
      assert.ok(m, `downloader.js harus punya ${name}`);
      return m[1].replace(/\s*\/\/.*$/, '').trim().replace(/\s+/g, '');
    };
    const pairs = [
      ['ARIA2C_SPEED_FLOOR_BPS', 'SPEED_FLOOR_BPS'],
      ['ARIA2C_SPEED_WINDOW_MS', 'SPEED_WINDOW_MS'],
      ['ARIA2C_SPEED_MIN_RUN_MS', 'SPEED_MIN_RUN_MS'],
      ['ARIA2C_SPEED_MIN_BYTES', 'SPEED_MIN_BYTES'],
    ];
    for (const [aria, mine] of pairs) {
      const lit = grab(aria);
      const val = eval(lit.replace(/\*/g, '*')); // konstanta aritmetika sederhana
      assert.strictEqual(TH[mine], val,
        `${mine} (${TH[mine]}) harus sama dengan ${aria} (${val}) di downloader.js —kalau berubah, update lib/download-thresholds.js`);
      console.log(`      ${mine} = ${TH[mine]} == ${aria} ✓`);
    }
  });

  // ── Anti-drift: default downloadTo = shared module (tidak ada angka magic) ──
  await t('anti-drift: default threshold downloadTo = shared module', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'vidaraService.js'), 'utf8');
    assert.ok(/require\('\.\.\/lib\/download-thresholds'\)/.test(src), 'harus import shared module');
    // tidak boleh ada angka 70*1024 / 90000 / 5*1024*1024 hardcoded di watchdog
    const watchdog = src.slice(src.indexOf('const watchdog = setInterval'), src.indexOf('}, 1000);'));
    assert.ok(!/70\s*\*\s*1024/.test(watchdog), 'tidak boleh ada 70*1024 magic di watchdog');
    assert.ok(!/90\s*\*\s*1000/.test(watchdog) && !/90000/.test(watchdog), 'tidak boleh ada 90000 magic di watchdog');
  });

  console.log(`\n${passed} pass / ${failed} fail`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
