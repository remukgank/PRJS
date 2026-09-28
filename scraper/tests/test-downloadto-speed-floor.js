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
const { logger } = require('../logger');
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
//   'mp4'   → MP4 H.264/yuv420p asli, dukung Range (dipakai uji ensureMp4
//             supaya tidak memicu re-encode ffmpeg yang lambat)
//
// PAYLOAD_MP4(): MP4 asli > 5 MB (ftyp + h264/yuv420p) → isIosCompatible() true,
// jadi ensureMp4 TIDAK menjalankan ffmpeg. Satu file per proses, di-cache.
const PAYLOAD_PATH = path.join(os.tmpdir(), `dltest-payload-${process.pid}.mp4`);
function PAYLOAD_MP4() {
  if (fs.existsSync(PAYLOAD_PATH) && fs.statSync(PAYLOAD_PATH).size > 5 * 1024 * 1024) {
    return fs.readFileSync(PAYLOAD_PATH);
  }
  require('child_process').execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=12',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '8000k',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', PAYLOAD_PATH,
  ], { timeout: 120000 });
  return fs.readFileSync(PAYLOAD_PATH);
}

const startServer = (mode) => new Promise((resolve) => {
  let sent = 0;
  const srv = http.createServer((req, res) => {
    if (mode === 'ignore-range') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '4096' });
      return res.end(Buffer.alloc(4096));
    }
    if (mode === 'mp4') {
      const buf = PAYLOAD_MP4();
      const from = Number(/bytes=(\d+)-/.exec(req.headers.range || '')?.[1] || 0);
      const slice = from > 0 ? buf.subarray(from) : buf;
      res.writeHead(from > 0 ? 206 : 200, {
        'Content-Type': 'video/mp4',
        ...(from > 0 ? { 'Content-Range': `bytes ${from}-${buf.length - 1}/${buf.length}` } : {}),
        'Content-Length': String(slice.length),
      });
      return res.end(slice);
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
    assert.ok(/koneksi baru/.test(msg), `pesan harus menyebut koneksi baru (bukan "ganti server" — kamenime tidak punya mirror lain): ${msg}`);
    assert.ok(dt < 8000, `harus cepat (~1-3s), proses ${dt}ms`);
    console.log(`      → ${msg}  (${dt}ms)`);
  });

  // ── a2) speed floor HARUS ditandai retryable: yang lambat = socket, bukan file ──
  // 28 Sep 2026: probe berulang ke file yang sama dari host yang sama → 7 dari 11
  // tembus 4–220 MB/s, 4 sisanya nge-drip 34–85 KiB/s. Tidak ada pola per-file,
  // jadi "ganti server" adalah diagnosis yang salah dan "berhenti total" membuang
  // episode yang bisa didapat dalam 2 detik (ep725: 189 MB / 2,0 s).
  await t('a2) speed floor → noRetry TAPI slow (retry dengan koneksi baru)', async () => {
    const { srv, port } = await startServer('slow');
    const dest = tmp('a2.mp4');
    try { fs.rmSync(dest, { force: true }); fs.writeFileSync(dest, Buffer.alloc(0)); } catch {}
    let err = null;
    try {
      await downloadTo(`http://127.0.0.1:${port}/v`, dest, { thresholds: { ...FAST_TH, SPEED_FLOOR_BPS: 5 * 1024 * 1024 } });
    } catch (e) { err = e; }
    srv.close();
    assert.ok(err, 'harus gagal');
    assert.strictEqual(err.noRetry, true, 'harus noRetry agar tidak di-vonis "mengulang tidak menolong"');
    assert.strictEqual(err.slow, true, 'harus slow=true agar ensureMp4 mencoba koneksi baru');
    console.log(`      → noRetry=${err.noRetry} slow=${err.slow}`);
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

  // ── f2) ensureMp4: galat "lambat" → ULANG dengan koneksi baru, bukan berhenti ──
  // 28 Sep 2026. Server: percobaan pertama nge-drip JAUH di bawah ambang
  // (speed floor yang menyala), percobaan kedua normal. Kalau ensureMp4 masih
  // memakai `if (err.noRetry) break`, episode yang sebenarnya bisa didapat dalam
  // 2 detik jadi hilang — persis 4 episode yang hilang di batch One Piece
  // 28 Sep 2026.
  //
  // PENTING: drip harus di BAWAH ambang dengan margin jauh, dan HILANG total
  // setelah beberapa detik supaya STALL_MS (yang di-set 60 dtk di sini) tidak
  // yang menyalakan lebih dulu. Kalau tidak, test lulus karena alasan salah —
  // versi pertama "lulus" karena isIosCompatible() melempar Parse Error pada file
  // yang terpotong, bukan karena speed floor. Karena itu test ini mengetat: alasan
  // gagalnya harus `terlalu lambat` (dicek dari log "koneksi lambat"), bukan
  // Parse Error atau galat lain.
  await t('f2) ensureMp4 retry setelah speed floor (koneksi baru) sampai berhasil', async () => {
    let attempts = 0;
    const { srv, port } = await startServer('mp4');
    const dest = tmp('f2.mp4');
    fs.rmSync(dest, { force: true });
    const payloadBuf = PAYLOAD_MP4();
    // 4 KiB/100ms = 40 KiB/s → di bawah ambang 70 KiB/s dengan margin 1,75×.
    // Setelah 40 chunk (4 dtk) drip BERHENTI total → tanpa itu, isIosCompatible()
    // akan membaca file terpotong dan melempar Parse Error (bukan speed floor).
    srv.removeAllListeners('request');
    srv.on('request', (req, res) => {
      attempts++;
      const buf = payloadBuf;
      const from = Number(/bytes=(\d+)-/.exec(req.headers.range || '')?.[1] || 0);
      const slice = from > 0 ? buf.subarray(from) : buf;
      res.writeHead(from > 0 ? 206 : 200, {
        'Content-Type': 'video/mp4',
        ...(from > 0 ? { 'Content-Range': `bytes ${from}-${buf.length - 1}/${buf.length}` } : {}),
        'Content-Length': String(slice.length),
      });
      if (attempts === 1) {
        let off = 0, n = 0;
        const t = setInterval(() => {
          n++;
          if (n > 40) { clearInterval(t); return; }        // freeze total → speed floor yang menyalakan
          if (res.writableEnded) return clearInterval(t);
          res.write(slice.subarray(off, off + 4 * 1024));
          off = Math.min(off + 4 * 1024, slice.length);
        }, 100);
        res.on('close', () => clearInterval(t));
        return;
      }
      res.end(slice);
    });
    // Window 900ms + run 900ms → speed floor menyala ~1,8 dtk setelah drip,
    // JAUH sebelum STALL_MS 60 dtk. MAX_RUN_MS longgar supaya bukan itu.
    const TH2 = { ...FAST_TH, SPEED_FLOOR_BPS: 70 * 1024, SPEED_MIN_RUN_MS: 900, SPEED_WINDOW_MS: 900, SPEED_MIN_BYTES: 0, STALL_MS: 60000, MAX_RUN_MS: 120000 };
    const warns = [];
    const origWarn = logger.warn;
    logger.warn = (obj, msg) => { if (/koneksi lambat/.test(msg)) warns.push(String(obj && obj.err || '')); return origWarn.call(logger, obj, msg); };
    let okPath = null, err = null;
    try { okPath = await ensureMp4(`http://127.0.0.1:${port}/v`, dest, { retries: 2, backoffMs: 1, thresholds: TH2 }); }
    catch (e) { err = e; }
    finally { logger.warn = origWarn; }
    srv.close();
    assert.ok(!err, `harus akhirnya BERHASIL setelah retry, dapat: ${err && err.message}`);
    assert.ok(attempts >= 2, `harus mencoba minimal 2 koneksi, dapat ${attempts}`);
    // Ketat: percobaan pertama HARUS gagal karena speed floor. Kalau bukan, test
    // ini lulus karena alasan lain (mis. Parse Error) dan tidak mengunci apa pun.
    assert.ok(warns.length >= 1, `harus ada log "koneksi lambat" (speed floor), dapat ${warns.length} — test tidak membuktikan speed floor`);
    assert.ok(/terlalu lambat/.test(warns[0]), `alasan harus "terlalu lambat", dapat: ${warns[0]}`);
    assert.ok(fs.existsSync(okPath), 'file hasil harus ada');
    const st = fs.statSync(okPath);
    assert.strictEqual(st.size, payloadBuf.length, `hasil harus identik payload (${payloadBuf.length}), dapat ${st.size}`);
    console.log(`      → ${attempts} percobaan, SUKSES ${(st.size / 1048576).toFixed(1)} MB; slow-retry terbukti: ${warns[0].slice(0, 58)}…`);
  });

  // ── f3) parsial dari percobaan lambat TIDAK boleh disambung ke unduhan baru ──
  // Kalau parsial lama dibiarkan, `downloadTo` mengirim Range dan host yang mendukung
  // resume menyambungnya → file campur korup yang tetap lolos assertLooksLikeVideo
  // (signature ftyp masih di depan). Server di sini mendukung 206, jadi kombinasinya
  // persis kelas bug itu. Yang diuji: retry TIDAK boleh mengirim Range.
  await t('f3) retry setelah speed floor menghapus parsial lama (tidak dicampur)', async () => {
    let attempts = 0;
    let sawRangeOnRetry = false;
    const { srv, port } = await startServer('mp4');
    const dest = tmp('f3.mp4');
    fs.rmSync(dest, { force: true });
    const payloadBuf = PAYLOAD_MP4();
    srv.removeAllListeners('request');
    srv.on('request', (req, res) => {
      attempts++;
      const buf = payloadBuf;
      const from = Number(/bytes=(\d+)-/.exec(req.headers.range || '')?.[1] || 0);
      if (attempts >= 2 && req.headers.range) sawRangeOnRetry = true;
      const slice = from > 0 ? buf.subarray(from) : buf;
      res.writeHead(from > 0 ? 206 : 200, {
        'Content-Type': 'video/mp4',
        ...(from > 0 ? { 'Content-Range': `bytes ${from}-${buf.length - 1}/${buf.length}` } : {}),
        'Content-Length': String(slice.length),
      });
      if (attempts === 1) {
        let off = 0, n = 0;
        const t = setInterval(() => {
          n++;
          if (n > 40) { clearInterval(t); return; }
          if (res.writableEnded) return clearInterval(t);
          res.write(slice.subarray(off, off + 4 * 1024));
          off = Math.min(off + 4 * 1024, slice.length);
        }, 100);
        res.on('close', () => clearInterval(t));
        return;
      }
      res.end(slice);
    });
    const TH2 = { ...FAST_TH, SPEED_FLOOR_BPS: 70 * 1024, SPEED_MIN_RUN_MS: 900, SPEED_WINDOW_MS: 900, SPEED_MIN_BYTES: 0, STALL_MS: 60000, MAX_RUN_MS: 120000 };
    const warns = [];
    const origWarn = logger.warn;
    logger.warn = (obj, msg) => { if (/koneksi lambat/.test(msg)) warns.push(String(obj && obj.err || '')); return origWarn.call(logger, obj, msg); };
    let okPath = null, err = null;
    try { okPath = await ensureMp4(`http://127.0.0.1:${port}/v`, dest, { retries: 2, backoffMs: 1, thresholds: TH2 }); }
    catch (e) { err = e; }
    finally { logger.warn = origWarn; }
    srv.close();
    assert.ok(!err, `harus berhasil: ${err && err.message}`);
    assert.ok(warns.length >= 1 && /terlalu lambat/.test(warns[0]), `harus gagal karena speed floor, dapat: ${warns[0] || '(tidak ada)'}`);
    assert.ok(attempts >= 2, `harus mencoba minimal 2 koneksi, dapat ${attempts}`);
    assert.ok(!sawRangeOnRetry, `percobaan kedua TIDAK boleh mengirim Range (parsial lama harus dihapus)`);
    const st = fs.statSync(okPath);
    assert.strictEqual(st.size, payloadBuf.length, `ukuran harus sama dengan payload server (${payloadBuf.length}), dapat ${st.size} — ada data parsial yang tercampur`);
    console.log(`      → ${attempts} percobaan, hasil ${(st.size / 1048576).toFixed(1)} MB identik payload (tanpa Range di retry)`);
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
