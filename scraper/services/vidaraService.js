"use strict";
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const { logger } = require('../logger');
const V = require('../vidara-uploader');

const pad = (n) => String(n).padStart(2, '0');

function rangeLabel(a, b) { return `${pad(a)}-${pad(b)}`; }

async function downloadTo(url, destPath) {
  const lib = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
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

// Pastikan video jadi .mp4 lokal: HLS (.m3u8) → ffmpeg stream-copy; bukan HLS → download langsung.
// Retry + resolveFresh: backend bisa flip-flop (URL valid saat probe tapi
// sampah saat download) — coba ulang dengan URL fresh per attempt.
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
          execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', url, '-c', 'copy', destPath], { timeout: 3600000 }, (err) => {
            if (err) return reject(new Error(`HLS→mp4 gagal: ${err.message}`));
            resolve(destPath);
          });
        });
      } else {
        await downloadTo(url, destPath);
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
async function uploadDramaBatchesVidara(opts) {
  const { dramaKey, title, subdomain, providerLabel, episodes, resolveVideoUrl, batchSize = 10, workers = 3, onBatch } = opts;

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
          await ensureMp4(url, dest, { resolveFresh: () => resolveVideoUrl(epObj), logCtx: { ep: epObj.ep } });
          results[j] = dest;
        } catch (e) { results[j] = { error: e.message || String(e) }; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(workers, chunk.length) }, worker));
    return results;
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
        throw new Error(`download gagal ${errors.length}/${chunk.length} (${errors[0]?.error || '?'})`);
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

module.exports = { uploadToVidara, uploadDramaBatchesVidara, ensureMp4, ffmpegConcat, isHlsUrl };