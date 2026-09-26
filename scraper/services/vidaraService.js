"use strict";
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile, execFileSync } = require('child_process');
const { logger } = require('../logger');
const V = require('../vidara-uploader');

const pad = (n) => String(n).padStart(2, '0');

// UA browser penuh, sama seperti downloader.js (CDN galak block UA default).
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

function rangeLabel(a, b) { return `${pad(a)}-${pad(b)}`; }

async function downloadTo(url, destPath) {
  const lib = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    // Toko gofile (store*.gofile.io) HANYA melayani file bilaAuthorization
    // premium ikut. Tanpa itu balasannya halaman HTML "needs JavaScript"
    // (~3 KB) — botNlalu meng-upload HTML itu ke Vidoy dan ditolak.
    // Jalur Telegram (handlers/download.js) sudah mengirim header ini lewat
    // extraHeaders; jalur Vidoy lewat fungsi ini belum.
    const gofileTok = (process.env.GOFILE_TOKEN || '').trim();
    const isGofileStore = /^((cold|store|file)[\w-]*)\.gofile\.io$/i.test(
      (() => { try { return new URL(url).hostname; } catch { return ''; } })()
    );
    const headers = { 'User-Agent': 'Mozilla/5.0' };
    if (isGofileStore) {
      headers.Referer = 'https://gofile.io/';
      if (gofileTok) headers.Authorization = `Bearer ${gofileTok}`;
    }
    const req = lib.get(url, { headers }, (res) => {
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`download HTTP ${res.statusCode}`));
      }
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return downloadTo(res.headers.location, destPath).then(resolve, reject);
      }
      const out = fs.createWriteStream(destPath);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(destPath)));
      out.on('error', reject);
    });
    req.setTimeout(180000, () => req.destroy(new Error('download timeout')));
    req.on('error', reject);
  });
}

function isHlsUrl(url) {
  return typeof url === 'string' && /\.m3u8($|\?)/i.test(url);
}

// ─── Fail-fast provider down (insiden dramanova 502) ─────────────────────────
// Bedakan "sebagian gagal" (retry berguna) vs "semua gagal sama" (upstream
// down -> vonis cepat). Klasifikasi konservatif: hanya sinyal upstream yang
// dikenal; error download/merge lokal (HLS→mp4 gagal, ffmpeg, dsb) -> null.
function providerDownSig(msg) {
  const m = String(msg || '').toLowerCase().replace(/ep(isode)?\s*\d+/g, '').replace(/\d+\s*ms/g, '');
  if (/502|bad gateway/.test(m)) return 'HTTP 502';
  if (/503|service unavailable/.test(m)) return 'HTTP 503';
  if (/504|gateway timeout/.test(m)) return 'HTTP 504';
  if (/invalid response/.test(m)) return 'invalid response';
  if (/video url kosong/.test(m)) return 'video URL kosong';
  if (/timeout|timed out|econn|eai_again|socket hang|fetch failed|request failed/.test(m)) return 'timeout/jaringan';
  return null;
}

// Vonis batch paralel: 100% gagal + semua sig identik non-null -> Error
// provider-down; selain itu null (jalur normal). Threshold 100% disengaja
// (konservatif); campuran -> jalur lama.
// Pesan dipadatkan (sig pendek) agar muat di progress-line onBatch (60 char).
const SHORT_SIG = { 'HTTP 502': '502', 'HTTP 503': '503', 'HTTP 504': '504', 'invalid response': 'invalid', 'video URL kosong': 'URL kosong', 'timeout/jaringan': 'timeout' };
function providerDownVerdict(errors, total, providerLabel) {
  if (!Array.isArray(errors) || errors.length !== total || total <= 0) return null;
  const sigs = errors.map((e) => providerDownSig(e && e.error));
  if (!sigs[0] || !sigs.every((s) => s === sigs[0])) return null;
  return new Error(`Provider ${providerLabel} down (${total}/${total}:${SHORT_SIG[sigs[0]] || sigs[0]}), coba lagi nanti`);
}

// Format pesan vonis serial (max-3-ep). Diekstrak agar panjangnya bisa
// di-test (rp.note trunkasi 80 char).
function providerDownSerialMsg(providerLabel, sig) {
  return `Provider ${providerLabel} down (3 ep berurutan gagal: ${sig}), coba lagi nanti`;
}

// Streak serial: kembalikan array streak terbaru. Append bila sig sama dengan
// terakhir; reset ke [sig] bila sig baru; reset ke [] bila bukan sinyal down.
// Vonis (streak.length >= 3) diputuskan caller.
function pushStreak(streak, sig) {
  if (!sig) return [];
  const last = streak.length ? streak[streak.length - 1] : null;
  if (sig === last) return [...streak, sig];
  return [sig];
}

// Kumpulkan vonis dari kegagalan per-ep jalan paralel (Hook 1 & Hook 3).
// failedEps: array ep gagal; resolveErrors: Map/obj ep -> pesan error FASE
// RESOLVE. Ep tanpa catatan resolve (gagal di download/ffmpeg) -> null
// (jalur normal): vonis butuh bukti resolve 100%, bukan asumsi.
function collectVerdict(failedEps, resolveErrors, chunkLength, providerLabel) {
  if (!Array.isArray(failedEps) || failedEps.length !== chunkLength || chunkLength <= 0) return null;
  const errs = [];
  for (const ep of failedEps) {
    const msg = resolveErrors instanceof Map ? resolveErrors.get(ep) : resolveErrors?.[ep];
    if (msg == null) return null;
    errs.push({ error: msg });
  }
  return providerDownVerdict(errs, chunkLength, providerLabel);
}

// Pastikan video jadi .mp4 lokal: HLS (.m3u8) → ffmpeg stream-copy; bukan HLS → download langsung.
// Retry + resolveFresh: backend bisa flip-flop (URL valid saat probe tapi
// sampah saat download) — coba ulang dengan URL fresh per attempt.
// File hasil unduh WAJIB dicek sebelum di-upload. Tanpa ini, provider yang
// membalas halaman error dengan HTTP 200 (mis. gofile tanpa header auth →
// "Gofile needs JavaScript to run", 3358 byte HTML) akan diteruskan ke
// Vidoy dan baru gagal di sana dengan pesan yang tidak jelas
// ("Vidoy CDN status invalid ... explode(): Passing null").
// Yang dipulihkan di sini: error menyebut provider/ukuran/awal file.
const MIN_VIDEO_BYTES = 100 * 1024;
function assertLooksLikeVideo(destPath) {
  let st;
  try { st = fs.statSync(destPath); } catch { return; } // belum ada → biarkan
  let head = Buffer.alloc(0);
  try {
    const fd = fs.openSync(destPath, 'r');
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, 256, 0);
    fs.closeSync(fd);
    head = buf.slice(0, n);
  } catch { return; }
  const txt = head.toString('utf8').trimStart().slice(0, 120).toLowerCase();
  const isContainer = head.indexOf(Buffer.from('ftyp')) >= 0          // MP4/MOV
    || head.readUInt32BE(0) === 0x1a45dfa3;                           // Matroska/WebM
  // Signature container = bukti otoritatif. MP4 sah boleh kecil (fragmen/clip),
  // jadi JANGAN ditolak karena ukuran — hanya signature yang menentukan.
  if (isContainer) return;
  if (txt.startsWith('<!doctype') || txt.startsWith('<html') || txt.startsWith('<')) {
    throw new Error(`unduhan bukan video — dapat HTML (${st.size} byte, awal: "${txt.slice(0, 48).replace(/\s+/g, ' ')}"). Provider butuh header auth yang sesuai.`);
  }
  if (txt.startsWith('{') || txt.startsWith('[')) {
    let msg = '';
    try { msg = String(JSON.parse(head.toString('utf8')).message || '').slice(0, 80); } catch {}
    throw new Error(`unduhan ditolak provider — dapat JSON (${st.size} byte)${msg ? `: ${msg}` : ''}`);
  }
  if (st.size < MIN_VIDEO_BYTES) {
    throw new Error(`unduhan tidak dikenali dan terlalu kecil (${st.size} byte, minimal ${MIN_VIDEO_BYTES}) — kemungkinan halaman error, bukan file video.`);
  }
}

// iOS/Telegram inline playback butuh H.264 + yuv420p. .ts (MPEG-TS) tidak bisa
// diputar inline sama sekali (layar putih), jadi wajib dikonversi ke .mp4.
function isIosCompatible(videoPath) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,pix_fmt',
      '-of', 'json', videoPath,
    ], { timeout: 30000 }).toString();
    const stream = (JSON.parse(out).streams || [])[0];
    return !!stream && stream.codec_name === 'h264' && stream.pix_fmt === 'yuv420p';
  } catch {
    return false;
  }
}

function reencodeForIos(inputPath, onLog = null) {
  return new Promise((resolve) => {
    const outPath = inputPath.replace(/\.[^.]+$/, '') + '_ios.mp4';
    execFile('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      outPath,
    ], { maxBuffer: 100 * 1024 * 1024 }, (err) => {
      if (err || !fs.existsSync(outPath)) {
        if (onLog) onLog('re-encode iOS gagal: ' + String(err && err.message || 'file tidak ada').slice(0, 60));
        return resolve(null);
      }
      try { fs.unlinkSync(inputPath); } catch {}
      if (onLog) onLog('re-encode iOS selesai (h264+yuv420p)');
      resolve(outPath);
    });
  });
}

// opts: { retries=2, backoffMs=15000, resolveFresh=null (async()=>url), logCtx={} }
async function ensureMp4(url, destPath, opts = {}) {
  const retries = opts.retries ?? 2;
  const backoffMs = opts.backoffMs ?? 15000;
  const resolveFresh = opts.resolveFresh || null;
  const logCtx = opts.logCtx || {};
  let lastErr = null;
  for (let attempt = 1; attempt <= 1 + retries; attempt++) {
    try {
      if (isHlsUrl(url)) {
        await new Promise((resolve, reject) => {
          // UA browser penuh: CDN galak menolak UA default ffmpeg (Lavf) -> 403.
          execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-user_agent', BROWSER_UA, '-y', '-i', url, '-c', 'copy', destPath], { timeout: 3600000 }, (err) => {
            if (err) return reject(new Error(`HLS→mp4 gagal: ${err.message}`));
            resolve(destPath);
          });
        });
      } else {
        await downloadTo(url, destPath);
      }
      assertLooksLikeVideo(destPath);

      // Konversi .ts/.mkv → .mp4 (iOS tidak bisa putar .ts inline → layar putih)
      const ext = path.extname(destPath).toLowerCase();
      if (ext !== '.mp4') {
        // lazy require: memutus circular dependency downloader ↔ vidaraService
        const { remuxToMp4 } = require('../downloader');
        destPath = await remuxToMp4(destPath, (m) => logger.info({ ...logCtx, m }, 'remux ke .mp4'));
        assertLooksLikeVideo(destPath);
      }

      // Pastikan iOS-compatible: H.264 + yuv420p
      if (!isIosCompatible(destPath)) {
        const iosPath = await reencodeForIos(destPath, (m) => logger.info({ ...logCtx, m }, 're-encode iOS'));
        if (iosPath) destPath = iosPath;
        assertLooksLikeVideo(destPath);
      }
      return destPath;
    } catch (err) {
      lastErr = err;
      if (attempt > retries) break;
      logger.warn({ ...logCtx, attempt, err: err.message }, 'ensureMp4 gagal — retry dengan URL fresh');
      await new Promise((r) => setTimeout(r, backoffMs * attempt));
      if (resolveFresh) {
        try {
          const fresh = await resolveFresh();
          if (fresh) url = fresh;
        } catch {}
      }
    }
  }
  throw lastErr;
}

function ffmpegConcat(inputs, outPath) {
  const listPath = outPath + '.txt';
  const lines = inputs.map((f) => `file '${String(f).replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(listPath, lines.join('\n'));
  const cleanup = () => { try { fs.rmSync(listPath, { force: true }); } catch {} };
  // Percobaan pertama: stream-copy (cepat, tanpa re-encode)
  const copyArgs = ['-hide_banner', '-loglevel', 'error', '-fflags', '+genpts', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath];
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', copyArgs, { timeout: 3600000 }, (err) => {
      if (!err) { cleanup(); return resolve(outPath); }
      // Fallback: mp4 hasil HLS sering punya start-time/gaps → re-encode sekali
      const reArgs = ['-hide_banner', '-loglevel', 'error', '-fflags', '+genpts', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', outPath];
      execFile('ffmpeg', reArgs, { timeout: 7200000 }, (err2) => {
        cleanup();
        if (err2) return reject(new Error(`ffmpeg concat gagal (copy & re-encode): ${err.message}`));
        resolve(outPath);
      });
    });
  });
}

// Upload batch: gabung BATCH_SIZE episode jadi 1 video, upload via curl-multipart (metode VDL).
// Worker-pool download per chunk (diekstrak module-level agar bisa di-test
// tanpa side-effect fs/Vidara API; perilaku identik dengan versi nested lama).
async function downloadChunk(chunk, resolveVideoUrl, workDir, workers = 3, logCtx = {}) {
  const results = new Array(chunk.length);
  let idx = 0;
  async function worker() {
    while (idx < chunk.length) {
      const j = idx++;
      const epObj = chunk[j];
      try {
        const url = await resolveVideoUrl(epObj);
        if (!url) throw new Error('video URL kosong');
        const dest = path.join(workDir, `ep${pad(j + 1)}-${pad(Number(epObj.ep) || j + 1)}.mp4`);
        await ensureMp4(url, dest, { resolveFresh: () => resolveVideoUrl(epObj), logCtx: { ...logCtx, ep: epObj.ep } });
        results[j] = dest;
      } catch (e) { results[j] = { error: e.message || String(e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, chunk.length) }, worker));
  return results;
}

async function uploadDramaBatchesVidara(opts) {  const { dramaKey, title, subdomain, providerLabel, episodes, resolveVideoUrl, batchSize = 10, workers = 3, onBatch } = opts;

  const dirKey = String(subdomain || providerLabel || 'misc').replace(/^reelfren_/, '');
  const safeTitle = V.sanitizeDir(title || dirKey);
  const subDir = path.join(V.DOWNLOADS, dirKey, safeTitle);
  fs.mkdirSync(subDir, { recursive: true });
  const workDir = path.join(subDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });

  const track = V.loadPerDrama(subDir);
  if (!track.vidara) track.vidara = {};
  if (!track.vidaraBatches) track.vidaraBatches = {};

  const folderName = V.vidaraFolderName(title, providerLabel || dirKey);
  let fldId = null;
  try { fldId = await V.ensureFolder(folderName); } catch { fldId = null; }
  if (fldId && opts.onFolder) opts.onFolder(folderName, fldId);

  const total = episodes.length;
  const chunks = [];
  for (let i = 0; i < total; i += batchSize) chunks.push(episodes.slice(i, i + batchSize));

  let done = 0, fail = 0;
  const files = {};

  async function downloadAll(chunk) {
    return downloadChunk(chunk, resolveVideoUrl, workDir, workers);
  }

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const first = Number(chunk[0].ep) || ci * batchSize + 1;
    const last = Number(chunk[chunk.length - 1].ep) || ci * batchSize + chunk.length;
    const label = rangeLabel(first, last);

    if (track.vidaraBatches[label]) {
      files[label] = track.vidaraBatches[label];
      chunk.forEach((e) => { track.vidara[pad(Number(e.ep) || 0)] = track.vidaraBatches[label]; });
      V.savePerDrama(subDir, track);
      done++;
      if (onBatch) onBatch(label, 'skip', track.vidaraBatches[label], ci + 1, chunks.length);
      continue;
    }

    try {
      if (onBatch) onBatch(label, 'download', null, ci + 1, chunks.length);
      const filesPaths = await downloadAll(chunk);
      const ok = filesPaths.filter((f) => typeof f === 'string');
      const errors = filesPaths.filter((f) => typeof f !== 'string');
      if (ok.length !== chunk.length) {
        // Fail-fast: 100% gagal + error identik upstream -> vonis provider down.
        const verdict = providerDownVerdict(errors, chunk.length, providerLabel);
        throw verdict || new Error(`download gagal ${errors.length}/${chunk.length} (${errors[0]?.error || '?'})`);
      }

      const merged = path.join(workDir, `${safeTitle} — Ep ${label}.mp4`);
      if (onBatch) onBatch(label, 'concat', null, ci + 1, chunks.length);
      await ffmpegConcat(ok, merged);

      const sizeMb = Math.round(fs.statSync(merged).size / 1048576);
      if (onBatch) onBatch(label, 'upload', null, ci + 1, chunks.length);
      const fc = await V.uploadFileViaCurl(merged, () => {});

      await V.renameVideo(fc, `${title} — Ep ${label}`).catch(() => {});
      if (fldId) await V.moveToFolder(fc, fldId).catch(() => {});

      track.vidaraBatches[label] = fc;
      chunk.forEach((e) => { track.vidara[pad(Number(e.ep) || 0)] = fc; });
      V.savePerDrama(subDir, track);
      files[label] = fc;
      done++;
      if (onBatch) onBatch(label, 'ok', { filecode: fc, sizeMb }, ci + 1, chunks.length);
    } catch (e) {
      fail++;
      if (onBatch) onBatch(label, 'fail', e.message || String(e), ci + 1, chunks.length);
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); fs.mkdirSync(workDir, { recursive: true }); } catch {}
    }
  }

  if (done > 0) {
    const g = V.loadGlobal();
    g[dramaKey] = {
      ...(g[dramaKey] || {}),
      title,
      subdomain: dirKey,
      hasVidara: true,
      uploaded: Object.keys(track.vidara),
      uploadedEpisodes: Object.keys(track.vidara).length,
      batches: Object.keys(track.vidaraBatches).length,
    };
    V.saveGlobal(g);
  }

  return { done, fail, total: chunks.length, files, fldId, folderName, subDir, epsCount: total };
}

async function uploadToVidara(opts) {
  const { dramaKey, title, subdomain, providerLabel, episodes, resolveVideoUrl, onEp } = opts;

  const dirKey = String(subdomain || providerLabel || 'misc').replace(/^reelfren_/, '');
  const safeTitle = V.sanitizeDir(title || dirKey);
  const subDir = path.join(V.DOWNLOADS, dirKey, safeTitle);
  fs.mkdirSync(subDir, { recursive: true });

  const track = V.loadPerDrama(subDir);
  if (!track.vidara) track.vidara = {};

  const folderName = V.vidaraFolderName(title, providerLabel || dirKey);
  let fldId = null;
  try {
    fldId = await V.ensureFolder(folderName);
  } catch {
    fldId = null;
  }
  if (fldId && opts.onFolder) opts.onFolder(folderName, fldId);

  let done = 0, fail = 0, skipped = 0;
  const filecodes = {};
  const total = episodes.length;

  for (let i = 0; i < total; i++) {
    const epObj = episodes[i];
    const epStr = String(epObj.ep).padStart(2, '0');
    if (track.vidara[epStr]) {
      skipped++;
      filecodes[epStr] = track.vidara[epStr];
      if (onEp) onEp(epStr, 'skip', i + 1, total, track.vidara[epStr]);
      continue;
    }
    try {
      const url = await resolveVideoUrl(epObj);
      if (!url) throw new Error('video URL kosong');

      const fc = await V.uploadUrlToVidara(url);
      if (!fc) throw new Error('upload gagal (tidak ada filecode)');

      await V.renameVideo(fc, `${title} — Ep ${epStr}`).catch(() => {});
      if (fldId) await V.moveToFolder(fc, fldId).catch(() => {});

      await V.waitForEncoding(fc).catch(() => {});

      track.vidara[epStr] = fc;
      V.savePerDrama(subDir, track);
      filecodes[epStr] = fc;
      done++;
      if (onEp) onEp(epStr, 'ok', i + 1, total, fc);
    } catch (e) {
      fail++;
      if (onEp) onEp(epStr, 'fail', i + 1, total, e.message || String(e));
    }
  }

  const g = V.loadGlobal();
  g[dramaKey] = {
    ...(g[dramaKey] || {}),
    title,
    subdomain: dirKey,
    hasVidara: true,
    uploaded: Object.keys(track.vidara),
    uploadedEpisodes: Object.keys(track.vidara).length,
  };
  V.saveGlobal(g);

  return { done, fail, skipped, total, filecodes, fldId, folderName, subDir };
}

module.exports = {
  isIosCompatible,
  reencodeForIos,
  assertLooksLikeVideo, uploadToVidara, uploadDramaBatchesVidara, ensureMp4, ffmpegConcat, isHlsUrl, providerDownSig, providerDownVerdict, providerDownSerialMsg, pushStreak, collectVerdict, downloadChunk };