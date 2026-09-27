'use strict';
/**
 * Uji FUNGSIONAL downloadTo terhadap server HTTP sungguhan.
 *
 * Insiden aslinya (26 Sep 2026): server gdriveplayer memotong transfer di
 * tengah. Kode lama hanya mendengar `out.on('finish')` + `req.on('error')`,
 * sehingga promise tidak pernah settle → `await` menggantung selamanya, file
 * beku 251 detik, TANPA error di log, progress bar tetap jalan.
 *
 * Test ini menyalakan skenario itu secara nyata (bukan mock) dan memaksa
 * downloadTo MENOLAK dalam batas waktu.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { downloadTo } = require('../services/vidaraService');

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); passed++; }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
}

// 2 MB payload dengan pola deterministik
const PAYLOAD = Buffer.alloc(1024 * 1024 * 2);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = i & 0xff;

function start(handler) {
  const srv = http.createServer(handler);
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port })));
}
function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dlstall-')), name);
}
/** Wajib menolak; kembalikan { err, ms }. Kalau resolve → lempar error test. */
async function expectReject(p, label, limitMs) {
  const t0 = Date.now();
  try { await p; } catch (e) { return { err: e, ms: Date.now() - t0 }; }
  throw new Error(`${label}: SEHARUSNYA menolak, tapi resolve (artinya digantung / dianggap sukses)`);
}

(async () => {
  await t('unduh normal → isi file identik dengan payload', async () => {
    const { srv, port } = await start((req, res) => {
      res.writeHead(200, { 'Content-Length': PAYLOAD.length });
      res.end(PAYLOAD);
    });
    const dest = tmpFile('normal.bin');
    try { await downloadTo(`http://127.0.0.1:${port}/f`, dest); }
    finally { srv.close(); }
    const got = fs.readFileSync(dest);
    if (got.length !== PAYLOAD.length) throw new Error(`panjang ${got.length} ≠ ${PAYLOAD.length}`);
    if (!got.equals(PAYLOAD)) throw new Error('isi file beda dengan payload');
  });

  await t('KRITIS: koneksi dipotong di tengah → MENOLAK (dulu: gantung selamanya)', async () => {
    const { srv, port } = await start((req, res) => {
      res.writeHead(200, { 'Content-Length': PAYLOAD.length });
      res.write(PAYLOAD.slice(0, 200 * 1024));
      setTimeout(() => res.destroy(), 60);
    });
    const dest = tmpFile('cut.bin');
    const p = downloadTo(`http://127.0.0.1:${port}/f`, dest);
    let out;
    try { out = await expectReject(p, 'pemotongan koneksi', 15000); }
    finally { srv.close(); }
    if (out.ms > 15000) throw new Error(`terlalu lambat menolak: ${out.ms}ms`);
    if (!/terputus|aborted|ECONNRESET|socket|premature/i.test(out.err.message)) {
      throw new Error('pesan gagal tidak informatif: ' + out.err.message);
    }
  });

  await t('KRITIS: server diam total → tolak ±20 dtk (stall watchdog)', async () => {
    const { srv, port } = await start((req, res) => {
      res.writeHead(200, { 'Content-Length': PAYLOAD.length });
      res.flushHeaders(); // header sampai ke client, lalu diam — menyerupai CDN
                          // yang berhenti mengirim di tengah transfer
    });
    const dest = tmpFile('stall.bin');
    const p = downloadTo(`http://127.0.0.1:${port}/f`, dest);
    let out;
    try { out = await expectReject(p, 'server diam', 30000); }
    finally { srv.close(); }
    if (out.ms < 15000) throw new Error(`terlalu cepat menolak (${out.ms}ms) — bisa memotong transfer yang sehat`);
    if (out.ms > 26000) throw new Error(`watchdog terlalu lambat: ${out.ms}ms (batas 20s + toleransi)`);
    if (!/macet/.test(out.err.message)) throw new Error('pesan bukan "macet": ' + out.err.message);
  });

  await t('resume: file parsial dilanjut via Range → hasil utuh', async () => {
    const dest = tmpFile('resume.bin');
    const half = Math.floor(PAYLOAD.length / 2);
    fs.writeFileSync(dest, PAYLOAD.slice(0, half));
    let sawRange = null;
    const { srv, port } = await start((req, res) => {
      sawRange = req.headers.range || null;
      const m = /^bytes=(\d+)-$/.exec(sawRange || '');
      const from = m ? Number(m[1]) : 0;
      if (from > 0) {
        res.writeHead(206, {
          'Content-Range': `bytes ${from}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
          'Content-Length': PAYLOAD.length - from,
        });
        res.end(PAYLOAD.slice(from));
      } else {
        res.writeHead(200, { 'Content-Length': PAYLOAD.length });
        res.end(PAYLOAD);
      }
    });
    try { await downloadTo(`http://127.0.0.1:${port}/f`, dest); }
    finally { srv.close(); }
    if (!sawRange) throw new Error('header Range tidak dikirim → retry tetap mulai dari nol');
    const got = fs.readFileSync(dest);
    if (got.length !== PAYLOAD.length) throw new Error(`panjang hasil ${got.length} ≠ ${PAYLOAD.length}`);
    if (!got.equals(PAYLOAD)) throw new Error('hasil resume tidak identik (file corrupt)');
  });

  // 26 Sep 2026: perilaku INI berubah. Sebelumnya server Range-ignoring
  // (chunked, tanpa Content-Length) menyebabkan restart dari nol — dan karena
  // stall-kill memicu retry, tiap retry membuang seluruh progres (65 MB pada
  // Naruto ep 5). Sekarang fail-fast: error noRetry supaya ensureMp4 berhenti
  // dan user diminta ganti server.
  await t('server mengabaikan Range (balas 200) saat ada file parsial → fail-fast, bukan restart', async () => {
    const dest = tmpFile('nocookie.bin');
    const half = Math.floor(PAYLOAD.length / 2);
    fs.writeFileSync(dest, Buffer.alloc(half, 0xab));
    const { srv, port } = await start((req, res) => {
      res.writeHead(200, { 'Content-Length': PAYLOAD.length });
      res.end(PAYLOAD);
    });
    let out;
    try { out = await expectReject(downloadTo(`http://127.0.0.1:${port}/f`, dest), 'no-resume', 8000); }
    finally { srv.close(); }
    if (!/tidak mendukung resume/.test(out.err.message)) {
      throw new Error('pesan harus menyebut tidak mendukung resume: ' + out.err.message);
    }
    if (out.err.noRetry !== true) throw new Error('error harus ditandai noRetry (retry tidak menolong)');
    // file parsial TIDAK boleh ditimpa/dicampur — gagal sebelum menulis apa pun
    const got = fs.readFileSync(dest);
    if (!got.equals(Buffer.alloc(half, 0xab))) {
      throw new Error(`file parsial berubah (len ${got.length}) — jangan tulis apa pun sebelum tahu status resume`);
    }
  });

  await t('HTTP 404 → tolak dengan kode status', async () => {
    const { srv, port } = await start((req, res) => { res.writeHead(404); res.end('nope'); });
    const dest = tmpFile('404.bin');
    let out;
    try { out = await expectReject(downloadTo(`http://127.0.0.1:${port}/f`, dest), '404', 8000); }
    finally { srv.close(); }
    if (!/404/.test(out.err.message)) throw new Error('pesan tidak memuat status: ' + out.err.message);
  });

  await t('tidak ada fd bocor setelah gagal', async () => {
    const { srv, port } = await start((req, res) => {
      res.writeHead(200, { 'Content-Length': PAYLOAD.length });
      res.write(PAYLOAD.slice(0, 64 * 1024));
      setTimeout(() => res.destroy(), 40);
    });
    const dest = tmpFile('leak.bin');
    try { await expectReject(downloadTo(`http://127.0.0.1:${port}/f`, dest), 'uji bocor', 10000); }
    finally { srv.close(); }
    await new Promise((r) => setTimeout(r, 200));
    const fds = fs.readdirSync(`/proc/self/fd`).length;
    if (fds > 40) throw new Error(`jumlah fd tidak wajar: ${fds} (kemungkinan bocor)`);
  });

  console.log(`\n${passed} pass / ${failed} fail`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
