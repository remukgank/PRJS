const fs = require('fs');
const path = require('path');
const { logger } = require('../logger');
const Vidoy = require('../vidoy-uploader');
const db = require('../db');
const {
  downloadChunk, ffmpegConcat, ensureMp4, providerDownVerdict,
} = require('./vidaraService');

function pad(n) {
  return String(n).padStart(2, '0');
}

function rangeLabel(a, b) {
  return `${pad(a)}-${pad(b)}`;
}

function chunkEpisodes(episodes, batchSize) {
  const chunks = [];
  for (let i = 0; i < episodes.length; i += batchSize) chunks.push(episodes.slice(i, i + batchSize));
  return chunks;
}

function trackFileFor(workDir) {
  return path.join(path.dirname(workDir), 'track.json');
}

function loadTrack(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return {}; }
}

function saveTrack(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.warn({ err: err.message, file }, 'Vidoy: simpan track.json gagal');
  }
}

function normalizeTrackEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return { link: entry, mergedPath: null, tgSent: null };
  // Sumber kebenaran: track.json (tgSent) ATAU pointer Telegram di DB.
  // Kolom DB tidak bernama `tgSent` — kalau hanya dibaca dari situ, record yang
  // sudah terkirim akan dianggap belum dan video terkirim ulang.
  const sentByPointer = !!(entry.tg_chat_id && entry.tg_message_id);
  return {
    link: entry.link || null,
    mergedPath: entry.mergedPath || null,
    tgSent: entry.tgSent === true || sentByPointer,
  };
}

function planBatchWork(chunks, records = [], track = {}, batchSize = 10) {
  const byPart = new Map();
  for (const r of records || []) {
    if (r && r.link && r.part !== null && r.part !== undefined) byPart.set(Number(r.part), { ...normalizeTrackEntry(r), source: 'db' });
  }
  const tracked = (track && track.vidoyBatches) || {};
  return chunks.map((chunk, ci) => {
    const part = ci + 1;
    const first = Number(chunk[0]?.ep) || ci * batchSize + 1;
    const last = Number(chunk[chunk.length - 1]?.ep) || ci * batchSize + chunk.length;
    const label = rangeLabel(first, last);
    const known = byPart.get(part) || (tracked[label] ? { ...normalizeTrackEntry(tracked[label]), source: 'track' } : null);
    return { part, first, last, label, skip: !!(known && known.link), known };
  });
}

async function resolveFolder(kind, title) {
  const segments = kind === 'anime' ? Vidoy.animeFolderPath(title) : Vidoy.dramaFolderPath(title);
  const id = await Vidoy.getOrCreateFolderPath(segments);
  return { id, segments, url: Vidoy.buildFolderUrl(id) };
}

async function uploadFile(filePath, onProgress, folder) {
  const res = await Vidoy.upload(filePath, onProgress, folder ? folder.segments : null);
  if (!res.ok) throw new Error(res.error || 'Vidoy upload gagal');
  return res;
}

async function uploadBatches(opts) {
  const {
    kind = 'drama', mediaKey, title, episodes, resolveVideoUrl,
    batchSize = 10, workers = 3, workDir, onBatch, onFolder, afterUpload, deps,
  } = opts || {};
  const io = { downloadChunk, ffmpegConcat, ...(deps || {}) };
  if (!Array.isArray(episodes) || !episodes.length) {
    return { done: 0, fail: 0, total: 0, items: [] };
  }
  fs.mkdirSync(workDir, { recursive: true });
  let folder = null;
  try {
    folder = await resolveFolder(kind, title);
    if (onFolder) onFolder(folder);
  } catch (err) {
    logger.warn({ err: err.message, title, kind }, 'Vidoy: folder gagal disiapkan — upload ke root');
    folder = null;
  }
  const chunks = chunkEpisodes(episodes, batchSize);
  const records = await db.listVidoyUploads(mediaKey, kind).catch(() => []);
  const trackFile = trackFileFor(workDir);
  const track = loadTrack(trackFile);
  if (!track.vidoyBatches) track.vidoyBatches = {};
  const plan = planBatchWork(chunks, records, track, batchSize);
  const items = [];
  let done = 0;
  let skipped = 0;
  let fail = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const step = plan[ci];
    const { first, last, label, part } = step;
    if (step.skip) {
      const entry = step.known;
      const needChannelSend = typeof afterUpload === 'function' && entry.tgSent !== true;
      if (needChannelSend) {
        let pendingFile = entry.mergedPath && fs.existsSync(entry.mergedPath) ? entry.mergedPath : null;
        let redownloaded = false;
        if (!pendingFile) {
          // File lokal tak ada (mis. proses sebelumnya mati / dibersihkan) → unduh ulang
          // batch ini HANYA untuk mengirim ke Telegram. Tidak upload ulang ke host.
          if (onBatch) onBatch(label, 'redownload', null, ci + 1, chunks.length);
          try {
            const results = await io.downloadChunk(chunk, resolveVideoUrl, workDir, workers);
            const okFiles = results.filter((f) => typeof f === 'string');
            if (okFiles.length !== chunk.length) {
              const verdict = providerDownVerdict(results.filter((f) => typeof f !== 'string'), chunk.length, opts.providerLabel || 'provider');
              throw verdict || new Error(`unduh ulang gagal ${chunk.length - okFiles.length}/${chunk.length}`);
            }
            if (onBatch) onBatch(label, 'concat', null, ci + 1, chunks.length);
            pendingFile = path.join(workDir, `${Vidoy.sanitizeFolderName(title || mediaKey)} \u2014 Ep ${label}.mp4`);
            await io.ffmpegConcat(okFiles, pendingFile);
            redownloaded = true;
          } catch (err) {
            logger.error({ title, ep: label, err: err.message }, 'Vidoy: unduh ulang untuk Telegram gagal');
            items.push({ epStart: first, epEnd: last, part, label, link: entry.link, skipped: true, telegramPending: true, telegramError: err.message });
            skipped++;
            if (onBatch) onBatch(label, 'skip', entry, ci + 1, chunks.length);
            continue;
          }
        }
        const retryItem = { epStart: first, epEnd: last, part, label, link: entry.link, filePath: pendingFile, skipped: true };
        let channelOk = false;
        try {
          channelOk = (await afterUpload(retryItem)) !== false;
        } catch (err) {
          channelOk = false;
          logger.warn({ ep: label, err: err.message }, 'Vidoy: kirim ulang ke channel gagal');
        }
        if (channelOk) {
          try { fs.rmSync(pendingFile, { force: true }); } catch { /* ignore */ }
          track.vidoyBatches[label] = { link: entry.link, mergedPath: null, tgSent: true };
          saveTrack(trackFile, track);
          items.push({ ...retryItem, filePath: null, tgResent: true, redownloaded });
        } else {
          track.vidoyBatches[label] = { link: entry.link, mergedPath: pendingFile, tgSent: false };
          saveTrack(trackFile, track);
          items.push({ ...retryItem, telegramPending: true, redownloaded });
        }
      } else {
        items.push({ epStart: first, epEnd: last, part, label, link: entry.link, skipped: true });
      }
      skipped++;
      if (onBatch) onBatch(label, 'skip', step.known, ci + 1, chunks.length);
      continue;
    }
    try {
      if (onBatch) onBatch(label, 'download', null, ci + 1, chunks.length);
      const results = await io.downloadChunk(chunk, resolveVideoUrl, workDir, workers);
      const ok = results.filter((f) => typeof f === 'string');
      const errors = results.filter((f) => typeof f !== 'string');
      if (ok.length !== chunk.length) {
        const verdict = providerDownVerdict(errors, chunk.length, opts.providerLabel || 'provider');
        throw verdict || new Error(`download gagal ${errors.length}/${chunk.length}${errors[0]?.error ? `: ${errors[0].error}` : ''}`);
      }
      if (onBatch) onBatch(label, 'concat', null, ci + 1, chunks.length);
      const merged = path.join(workDir, `${Vidoy.sanitizeFolderName(title || mediaKey)} — Ep ${label}.mp4`);
      await io.ffmpegConcat(ok, merged);
      if (onBatch) onBatch(label, 'upload', null, ci + 1, chunks.length);
      const up = await uploadFile(merged, (p) => {
        if (onBatch) onBatch(label, 'uploadProgress', p, ci + 1, chunks.length);
      }, folder);
      const item = {
        epStart: first, epEnd: last, part: ci + 1, label,
        filecode: up.filecode, link: up.link, dashboard: up.dashboardLink,
        folderId: up.folderId, folderUrl: folder ? folder.url : '',
        sizeMb: Math.round(fs.statSync(merged).size / 1048576), filePath: merged,
      };
      items.push(item);
      done++;
      if (onBatch) onBatch(label, 'ok', item, ci + 1, chunks.length);
      if (db && db.saveVidoyUpload) {
        await db.saveVidoyUpload({
          mediaKey, kind, part: item.part, epStart: first, epEnd: last, title,
          folderId: item.folderId, folderUrl: item.folderUrl, link: item.link, dashboard: item.dashboard,
        });
      }
      let channelOk = true;
      if (typeof afterUpload === 'function') {
        try {
          channelOk = (await afterUpload(item)) !== false;
        } catch (err) {
          channelOk = false;
          logger.warn({ ep: label, err: err.message }, 'Vidoy: kirim ke channel gagal — file ditahan untuk retry');
        }
      }
      if (channelOk) {
        track.vidoyBatches[label] = { link: up.link, mergedPath: null, tgSent: typeof afterUpload === 'function' };
        try { fs.rmSync(merged, { force: true }); } catch { /* ignore */ }
        saveTrack(trackFile, track);
      } else {
        track.vidoyBatches[label] = { link: up.link, mergedPath: merged, tgSent: false };
        saveTrack(trackFile, track);
        item.telegramPending = true;
        item.filePath = merged;
        logger.warn({ ep: label, file: merged }, 'Vidoy: file ditahan, kirim channel tertunda');
      }
    } catch (err) {
      fail++;
      try { fs.rmSync(path.join(workDir, `${V.sanitizeFolderName(title || mediaKey)} — Ep ${label}.mp4`), { force: true }); } catch { /* ignore */ }
      items.push({ epStart: first, epEnd: last, part, label, error: err.message || String(err) });
      logger.error({ title, kind, ep: label, err: err.message }, 'Vidoy batch gagal');
      if (onBatch) onBatch(label, 'fail', err.message || String(err), ci + 1, chunks.length);
    }
  }
  saveTrack(trackFile, track);
  return { done, skipped, fail, total: chunks.length, items, folder };
}

async function uploadSingle(opts) {
  const { kind = 'anime', mediaKey, title, episodeUrl, ep, outDir, onProgress, onFolder } = opts || {};
  fs.mkdirSync(outDir, { recursive: true });
  const num = Number(ep) || 0;
  const existing = (await db.listVidoyUploads(mediaKey, kind).catch(() => []))
    .find((r) => Number(r.part) === num && r.link);
  if (existing) {
    return { ok: true, skipped: true, link: existing.link, dashboard: existing.dashboard, epStart: num, epEnd: num, part: num, filecode: existing.link };
  }
  let folder = null;
  try {
    folder = await resolveFolder(kind, title);
    if (onFolder) onFolder(folder);
  } catch (err) {
    logger.warn({ err: err.message, title, kind }, 'Vidoy: folder gagal disiapkan — upload ke root');
  }
  const filePath = path.join(outDir, `${Vidoy.sanitizeFolderName(title || mediaKey)} — Ep ${pad(num)}.mp4`);
  if (!fs.existsSync(filePath)) {
    const ok = await ensureMp4(episodeUrl, filePath);
    if (!ok) return { ok: false, error: 'gagal menyiapkan video (ensureMp4)' };
  }
  const up = await uploadFile(filePath, onProgress, folder);
  if (!up.ok) return up;
  const item = {
    epStart: num, epEnd: num, part: num, filecode: up.filecode, link: up.link,
    dashboard: up.dashboardLink, folderId: up.folderId,
    folderUrl: folder ? folder.url : '', filePath,
  };
  if (db && db.saveVidoyUpload) {
    await db.saveVidoyUpload({
      mediaKey, kind, part: num, epStart: num, epEnd: num, title,
      folderId: item.folderId, folderUrl: item.folderUrl, link: item.link, dashboard: item.dashboard,
    });
  }
  return { ok: true, ...item };
}

module.exports = { uploadBatches, uploadSingle, resolveFolder, chunkEpisodes, rangeLabel, planBatchWork, trackFileFor, loadTrack, saveTrack, normalizeTrackEntry };
