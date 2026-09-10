// lib/backpressure.js — Two-layer download backpressure (UploadBackpressure + DiskGuard).
//
// Lapis 1 — UploadBackpressure (tekanan antrian, lunak): sebelum tiap item
// download, cek (a) total ukuran folder kerja <= MAX_DOWNLOAD_DISK_GB dan
// (b) upload in-flight < MAX_PENDING_UPLOADS. Kalau melanggar -> worker tidur
// (poll BACKPRESSURE_POLL_MS) sampai kedua syarat lolos (AND). Download belum
// mulai saat pause -> tidak ada file .part nyangkut.
//
// Lapis 2 — DiskGuard (disk fisik, darurat): free < DISK_WARN_GB -> warn;
// free < DISK_MIN_FREE_GB -> emergency cleanup (hapus file umur >24 jam,
// KECUALI path di activePaths = file yang lagi di-upload/di-track) -> kalau
// masih kritis -> pause + poll.
//
// Cakupan counter (hasil audit 2026-09-09, lihat docs/audit):
// - Dihitung: SEMUA kiriman via sender lib/telegram.js (sendVideo/Audio/
//   Document/Photo) = seluruh handlers/download.js + handlers/vidara.js +
//   downloadAndSend + topic mirrors + poster-sender, PLUS 2 sender batch
//   (sendVideoToChannel/sendPhotoToChannel, track minimal tanpa re-routing).
// - TIDAK dihitung (gap yang diterima, alasan tertulis):
//   (c) admin shim replyWithPhoto (QR saweria, kecil+jarang+admin-only);
//   (d) kiriman file_id (server-side Telegram, NOL beban lokal);
//   (e) upload HTTP ke CDN Vidara (bukan antrian Telegram; disk ketutup `du`).
//
// Tidak require bot/telegram (anti circular). notify() di-inject via init().

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { logger } = require('../logger');

function numEnv(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

function getConfig() {
  return {
    maxDownloadDiskGb: numEnv('MAX_DOWNLOAD_DISK_GB', 45), // 0 = matikan lapis 1
    maxPendingUploads: Math.floor(numEnv('MAX_PENDING_UPLOADS', 10)),
    diskMinFreeGb: numEnv('DISK_MIN_FREE_GB', 5),
    diskWarnGb: numEnv('DISK_WARN_GB', 15),
    dryRun: process.env.BACKPRESSURE_DRY_RUN === '1',
    pollMs: Math.max(1000, Math.floor(numEnv('BACKPRESSURE_POLL_MS', 30000))),
  };
}

function defaultWatchDirs() {
  return [
    path.join(os.homedir(), 'workspace', 'downloads'), // TMP_DIR downloader.js
    path.join(__dirname, '..', 'downloads'), // OUTPUT_DIR batch-download.js
  ];
}

let _notify = null;
let _watchDirs = null; // null = pakai defaultWatchDirs()
let _pendingUploads = 0;
const _activePaths = new Set();
let _duCache = { bytes: 0, at: 0 };
let _paused = false; // episode pause aktif (untuk notif sekali)
let _pauseStart = 0;
let _lastResumeLog = 0;

function init({ notify = null, watchDirs = null } = {}) {
  if (notify) _notify = notify;
  if (watchDirs) _watchDirs = watchDirs;
}

function setWatchDirs(dirs) {
  _watchDirs = dirs;
}

function watchDirs() {
  return _watchDirs || defaultWatchDirs();
}

function getStatus() {
  return { pendingUploads: _pendingUploads, activePaths: _activePaths.size, paused: _paused };
}

function emit(msg) {
  try {
    if (_notify) _notify(msg);
    else logger.warn(msg, 'backpressure (no notifier)');
  } catch (err) {
    logger.warn({ err: err.message }, 'backpressure notify failed');
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Upload accounting ───────────────────────────────────────────────────────
function uploadStart(filePath) {
  _pendingUploads += 1;
  if (filePath) _activePaths.add(String(filePath));
}

function uploadDone(filePath) {
  _pendingUploads = Math.max(0, _pendingUploads - 1);
  if (filePath) _activePaths.delete(String(filePath));
}

// Bungkus promise kirim: hitung akurat tanpa ubah logic pengiriman.
function track(promise, filePath) {
  uploadStart(filePath);
  return promise.then(
    (v) => { uploadDone(filePath); return v; },
    (e) => { uploadDone(filePath); throw e; }
  );
}

// ─── Disk measurement (du cache 10 dtk, 2 folder kerja) ─────────────────────
function dirBytes(dir) {
  try {
    const out = execFileSync('du', ['-sb', dir], { encoding: 'utf8', timeout: 15000 });
    const n = Number(String(out).split('\t')[0]);
    if (Number.isFinite(n) && n >= 0) return n;
  } catch {}
  // Fallback: jalan manual (lambat, tapi jarang kepakai).
  let total = 0;
  try {
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let ents;
      try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const p = path.join(cur, e.name);
        try {
          if (e.isDirectory()) stack.push(p);
          else if (e.isFile()) total += fs.statSync(p).size;
        } catch {}
      }
    }
  } catch {}
  return total;
}

function workDirsBytes() {
  const now = Date.now();
  if (now - _duCache.at < 10000) return _duCache.bytes;
  let total = 0;
  for (const d of watchDirs()) {
    try { if (fs.existsSync(d)) total += dirBytes(d); } catch {}
  }
  _duCache = { bytes: total, at: now };
  return total;
}

function freeBytes() {
  const dir = watchDirs()[0];
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {}
  try {
    const out = execFileSync('df', ['-B1', '--output=avail', dir], { encoding: 'utf8', timeout: 10000 });
    const n = Number(String(out).trim().split('\n')[1]);
    if (Number.isFinite(n) && n >= 0) return n;
  } catch {}
  return Infinity; // tidak bisa ukur -> jangan blockir (fail-open, logged)
}

// ─── Lapis 2: emergency cleanup ──────────────────────────────────────────────
// Hapus file umur >24 jam di folder kerja. File in-flight aman otomatis karena
// mtime-nya fresh; activePaths = sabuk ganda untuk file tua yang masih
// ditunggu upload (kasus stall >24 jam).
function emergencyCleanup() {
  const cfg = getConfig();
  const cutoff = Date.now() - 24 * 3600 * 1000;
  let removed = 0;
  let freed = 0;
  const sample = [];
  for (const dir of watchDirs()) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isFile()) continue;
      const p = path.join(dir, e.name);
      if (_activePaths.has(p)) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs > cutoff) continue;
      try {
        fs.unlinkSync(p);
        removed += 1;
        freed += st.size;
        if (sample.length < 5) sample.push(e.name);
      } catch (err) {
        logger.warn({ file: e.name, err: err.message }, 'backpressure cleanup gagal hapus');
      }
    }
  }
  logger.warn({ removed, freedMb: (freed / 1048576).toFixed(1), sample }, 'backpressure emergency cleanup');
  return { removed, freed };
}

// Cek satu putaran, return null bila lolos atau string alasan bila blockir.
function checkOnce() {
  const cfg = getConfig();
  // Lapis 2 dulu (darurat fisik didahulukan).
  const free = freeBytes();
  const freeGb = free / 1e9;
  if (freeGb < cfg.diskMinFreeGb) {
    emergencyCleanup();
    const free2 = freeBytes() / 1e9;
    if (free2 < cfg.diskMinFreeGb) {
      return `disk kritis (free ${free2.toFixed(1)} GB < ${cfg.diskMinFreeGb} GB)`;
    }
  } else if (freeGb < cfg.diskWarnGb) {
    logger.warn({ freeGb: freeGb.toFixed(1), warnGb: cfg.diskWarnGb }, 'backpressure disk warn');
  }
  // Lapis 1 (tekanan antrian). 0 = dimatikan.
  if (cfg.maxDownloadDiskGb > 0) {
    const usedGb = workDirsBytes() / 1e9;
    if (usedGb >= cfg.maxDownloadDiskGb) {
      return `folder kerja ${usedGb.toFixed(1)} GB >= ${cfg.maxDownloadDiskGb} GB`;
    }
  }
  if (_pendingUploads >= cfg.maxPendingUploads && cfg.maxPendingUploads > 0) {
    return `antrian upload ${_pendingUploads}/${cfg.maxPendingUploads} penuh`;
  }
  return null;
}

// Gate utama: dipanggil sebelum tiap item download mulai.
async function checkBeforeDownload() {
  const cfg = getConfig();
  for (;;) {
    const reason = checkOnce();
    if (!reason) {
      if (_paused) {
        _paused = false;
        emit('▶️ Download lanjut — kapasitas pulih');
      }
      return;
    }
    if (cfg.dryRun) {
      logger.warn({ reason }, 'backpressure [dry-run] would pause');
      return;
    }
    const now = Date.now();
    if (!_paused) {
      _paused = true;
      _pauseStart = now;
      _lastResumeLog = now;
      emit(`⏸ Download pause — ${reason}. Lanjut otomatis bila pulih.`);
      logger.warn({ reason }, 'backpressure pause');
    } else if (now - _lastResumeLog >= 120000) {
      _lastResumeLog = now;
      logger.warn({ reason, waitedSec: Math.floor((now - _pauseStart) / 1000) }, 'backpressure masih pause');
    }
    await sleep(cfg.pollMs);
  }
}

module.exports = {
  init,
  setWatchDirs,
  getConfig,
  getStatus,
  uploadStart,
  uploadDone,
  track,
  checkBeforeDownload,
  emergencyCleanup, // diekspos untuk test
};
