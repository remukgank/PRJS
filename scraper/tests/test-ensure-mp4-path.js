'use strict';
/**
 * Regression test: hasil konversi WAJIB berada di destPath yang diminta.
 *
 * Insiden 27 Sep 2026: `remuxToMp4` menulis hasil ke TMP_DIR root
 * (`downloads/<nama>_remux.mp4`) lalu MENGHAPUS file asli, dan
 * `reencodeForIos` juga menghapus inputnya. Semua pemanggil `ensureMp4`
 * membuang nilai balik fungsi (dipakai boolean) lalu tetap memakai path lama
 * → ENOENT, padahal unduhan + remux sudah SUKSES (file 59,9 MB valid).
 *
 * Jadi: unduh sukses, episode gagal. Test ini memaksa file muncul kembali di
 * destPath asli.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const S = require('../services/vidaraService');

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); passed++; }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ensurepath-'));

/** Buat konten MPEG-TS sungguhan (bukan MP4) supaya jalur remux benar-benar jalan. */
function makeTs() {
  const src = path.join(TMP, 'src.ts');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=128x72:rate=15',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mpegts', src,
  ], { timeout: 60000 });
  return src;
}

function serveFile(file) {
  const srv = http.createServer((req, res) => {
    const buf = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Length': buf.length, 'Content-Type': 'video/mp2t' });
    res.end(buf);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

(async () => {
  let tsFile;
  try { tsFile = makeTs(); }
  catch (e) { console.error('FATAL: tidak bisa membuat konten .ts — ' + e.message); process.exit(1); }

  await t('konten uji benar-benar MPEG-TS (bukan MP4)', () => {
    const c = S.detectVideoContainer(tsFile);
    if (c === 'mp4') throw new Error('konten uji sudah mp4 → jalur remux tidak teruji');
    if (!/ts|mpeg|mkv/i.test(String(c))) console.log(`  catatan: detectVideoContainer = ${c}`);
  });

  await t('KRITIS: hasil konversi MUNCUL di destPath yang diminta (dulu: ENOENT)', async () => {
    const { srv, port } = await serveFile(tsFile);
    const destPath = path.join(TMP, 'out', 'Anime — Ep 01.mp4');
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    try {
      const hasil = await S.ensureMp4(`http://127.0.0.1:${port}/src.ts`, destPath, { retries: 0 });
      if (hasil !== destPath) throw new Error(`ensureMp4 balikkan path lain: ${hasil}`);
      if (!fs.existsSync(destPath)) {
        const stray = fs.readdirSync(path.join(os.homedir(), 'workspace', 'downloads')).filter((f) => /_remux\.mp4$/.test(f));
        throw new Error('destPath tidak ada setelah konversi' + (stray.length ? ` — nyasar ke: ${stray.join(', ')}` : ''));
      }
    } finally { srv.close(); }
  });

  await t('file hasil valid + container mp4 + lolos validasi', async () => {
    const destPath = path.join(TMP, 'out', 'Anime — Ep 01.mp4');
    if (!fs.existsSync(destPath)) throw new Error('file hasil belum ada');
    S.assertLooksLikeVideo(destPath);
    const c = S.detectVideoContainer(destPath);
    if (c !== 'mp4') throw new Error(`container hasil = ${c}, harus mp4`);
    if (!S.isIosCompatible(destPath)) throw new Error('hasil tidak iOS-compatible');
  });

  await t('tidak ada sisa file _remux nyasar di TMP_DIR', () => {
    const tmpDir = path.join(os.homedir(), 'workspace', 'downloads');
    const stray = fs.existsSync(tmpDir)
      ? fs.readdirSync(tmpDir).filter((f) => /^Anime — Ep 01_remux\.mp4$/.test(f))
      : [];
    if (stray.length) throw new Error('masih ada file nyasar: ' + stray.join(', '));
  });

  await t('destPath lama TIDAK tertinggal (ditimpa hasil konversi)', async () => {
    const destPath = path.join(TMP, 'out', 'Anime — Ep 01.mp4');
    const before = fs.statSync(destPath).size;
    if (before <= 0) throw new Error('file kosong');
    if (!S.isIosCompatible(destPath)) throw new Error('cek ulang gagal');
  });

  await t('KRITIS: resolveFresh mengembalikan OBJEK → retry tetap jalan', async () => {
    // Insiden 27 Sep 2026: resolveDirectUrl() balik {url,...}, dipakai apa adanya
    // → attempt 2 melempar "url.startsWith is not a function" → episode gagal.
    const buf = fs.readFileSync(tsFile);
    let hits = 0;
    const srv = http.createServer((req, res) => {
      hits++;
      if (hits === 1) { res.writeHead(500); res.end('boom'); return; }
      res.writeHead(200, { 'Content-Length': buf.length, 'Content-Type': 'video/mp2t' });
      res.end(buf);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const destPath = path.join(TMP, 'retry', 'Ep 01.mp4');
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    try {
      const hasil = await S.ensureMp4(`http://127.0.0.1:${port}/x.ts`, destPath, {
        retries: 1,
        backoffMs: 50,
        resolveFresh: async () => ({ url: `http://127.0.0.1:${port}/x.ts`, provider: 'lokal' }),
      });
      if (hits < 2) throw new Error(`retry tidak terjadi (hits=${hits})`);
      if (hasil !== destPath) throw new Error('path salah: ' + hasil);
      S.assertLooksLikeVideo(destPath);
    } finally { srv.close(); }
  });

  await t('downloadTo menolak url non-string dengan pesan jelas', async () => {
    let msg = '';
    try { await S.downloadTo({ url: 'x' }, path.join(TMP, 'nope.bin')); }
    catch (e) { msg = e.message; }
    if (!/url bukan string/.test(msg)) throw new Error('pesan tidak informatif: ' + (msg || '(tanpa error)'));
  });

  console.log(`\n${passed} pass / ${failed} fail`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
