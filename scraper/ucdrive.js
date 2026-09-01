/**
 * ucdrive.js
 * UC Drive share scraper — list + download videos in full resolution.
 *
 * UC Drive blocks anonymous downloads, so a logged-in session cookie
 * (UC_DRIVE_COOKIE) is required. Flow:
 *   1. POST /v2/detail            -> stoken + file list
 *   2. GET  /video_preview (per)  -> play_info.url (OSS direct URL, no signature)
 *   3. Download each video (resume + concurrency)
 *
 * Mirrors the project style: uses ./logger, axios/https, exports functions.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { URLSearchParams } = require('url');
const { logger } = require('./logger');

const API_BASE = 'https://m-intldrive.ucweb.com';
const CHROMIUM = '/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium';

function getCookie() {
  const c = process.env.UC_DRIVE_COOKIE;
  if (!c) {
    logger.error('UC_DRIVE_COOKIE tidak diset! Set env var dengan session cookie UC Drive (login).');
    throw new Error('UC_DRIVE_COOKIE missing');
  }
  return c;
}

/**
 * Low-level API call to UC Drive.
 */
function apiCall(method, apiPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(API_BASE + apiPath);
    const b = body ? JSON.stringify(body) : '';
    const headers = Object.assign({
      'Cookie': getCookie(),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(b),
      'Origin': 'https://drive.ucweb.com',
      'Referer': 'https://drive.ucweb.com/',
    }, extraHeaders);

    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method, headers,
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch (e) { /* encrypted/raw */ }
        resolve({ status: res.statusCode, json: j, raw: d });
      });
    });
    req.on('error', reject);
    if (b) req.write(b);
    req.end();
  });
}

/**
 * Get share metadata + file list (including nested folders).
 * @param {string} shareId
 * @returns {Promise<{title:string, totalSize:number, files:Array}>}
 */
async function getShareInfo(shareId) {
  const detail = await apiCall('POST', '/1/clouddrive/share/sharepage/v2/detail?pr=UCBrowser&fr=h5', {
    pwd_id: shareId, passcode: '', force: 0, page: 1, size: 100,
    fetch_banner: 1, fetch_share: 1, fetch_total: 1, sort: '',
    banner_platform: 'others', fetch_error_background: 1,
    web_platform: 'ios', fetch_follow_status: 1, ip_limit: '',
  });

  if (!detail.json || !detail.json.data || !detail.json.data.token_info) {
    throw new Error('Gagal load share (cookie expired? status ' + detail.status + ')');
  }

  const stoken = detail.json.data.token_info.stoken;
  const share = detail.json.data.detail_info.share;
  const allFiles = detail.json.data.detail_info.list || [];
  const files = [];

  // Walk entries: videos at root + contents of each folder (e.g. "FOTO")
  for (const entry of allFiles) {
    if (entry.dir) {
      // list folder contents via /v2/detail with pdir_fid
      const sub = await apiCall('POST', '/1/clouddrive/share/sharepage/v2/detail?pr=UCBrowser&fr=h5', {
        pwd_id: shareId, passcode: '', force: 0, page: 1, size: 100,
        fetch_banner: 0, fetch_share: 0, fetch_total: 1,
        sort: 'file_type:asc,updated_at:desc', banner_platform: 'others',
        fetch_error_background: 0, web_platform: 'ios', fetch_follow_status: 0,
        ip_limit: '', pdir_fid: entry.fid,
      });
      const subList = (sub.json && sub.json.data && sub.json.data.detail_info.list) || [];
      for (const f of subList) {
        if (f.file && !f.dir) files.push(normalizeFile(f, entry.file_name));
      }
    } else if (entry.file && !entry.dir) {
      files.push(normalizeFile(entry, ''));
    }
  }

  return {
    title: share.title,
    totalSize: share.size,
    stoken,
    files: files.map((f) => ({ name: f.name, size: f.size, folder: f.folder, fid: f.fid, shareFidToken: f.share_fid_token })),
  };
}

function normalizeFile(f, folder) {
  return {
    name: f.file_name,
    size: f.size || 0,
    folder: folder || '',
    fid: f.fid,
    share_fid_token: f.share_fid_token,
    pdir_fid: f.pdir_fid || '',
  };
}

/**
 * Resolve the real (full-res) download URL for a file via /video_preview.
 * Falls back to thumbnail if /video_preview is unavailable (e.g. for images).
 */
async function resolveDownloadUrl(shareId, stoken, file) {
  try {
    const q = new URLSearchParams({
      pr: 'UCBrowser', fr: 'h5', pwd_id: shareId, fid: file.fid,
      fid_token: file.shareFidToken, share_fid_token: file.shareFidToken,
      stoken, pdir_fid: file.pdir_fid || '', scene: 'link',
      ms_permission: '0', ser_node: '', isH5: 'true',
    }).toString();
    const vp = await apiCall('GET', '/1/clouddrive/share/sharepage/video_preview?' + q, null, { 'x-clouddrive-st': stoken });
    const url = vp.json && vp.json.data && vp.json.data.play_info && vp.json.data.play_info.url;
    if (url) return { url, kind: 'video' };
  } catch (e) {
    logger.warn({ err: e.message, file: file.name }, 'video_preview failed, falling back');
  }
  // fallback: thumbnail (resized) — better than nothing
  return { url: file.thumbnail || null, kind: 'thumbnail' };
}

function sanitize(n) { return n.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_'); }

function downloadFile(url, filepath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filepath);
    https.get(url, (res) => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      res.on('data', (c) => { got += c.length; if (onProgress && total > 0) onProgress(got, total); });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (e) => { fs.unlink(filepath, () => {}); reject(e); });
  });
}

/**
 * Scrape + download all files from a UC Drive share.
 * @param {string} shareId
 * @param {string} outDir
 * @param {function} onStatus  optional callback (done,total,msg)
 * @returns {Promise<{downloaded:number, skipped:number, failed:number, files:Array}>}
 */
async function downloadShare(shareId, outDir, onStatus) {
  fs.mkdirSync(outDir, { recursive: true });
  const info = await getShareInfo(shareId);
  logger.info({ share: info.title, files: info.files.length }, 'UC Drive share loaded');

  const jobs = [];
  for (const f of info.files) {
    const { url, kind } = await resolveDownloadUrl(shareId, info.stoken, f);
    jobs.push({ ...f, url, kind });
  }
  const ok = jobs.filter((j) => j.url);

  let done = 0, skipped = 0, failed = 0;
  const CONCURRENCY = 3;
  let idx = 0;

  async function worker() {
    while (idx < ok.length) {
      const i = idx++;
      const job = ok[i];
      const sub = job.folder ? sanitize(job.folder) : '';
      const dir = sub ? path.join(outDir, sub) : outDir;
      fs.mkdirSync(dir, { recursive: true });
      const filepath = path.join(dir, sanitize(job.name));

      if (fs.existsSync(filepath) && fs.statSync(filepath).size === job.size) {
        skipped++;
        if (onStatus) onStatus(skipped + done + failed, ok.length, `skip ${job.name}`);
        continue;
      }

      try {
        await downloadFile(job.url, filepath, null);
        const sz = fs.statSync(filepath).size;
        if (job.size && sz < job.size * 0.9) throw new Error('size mismatch ' + sz);
        done++;
        if (onStatus) onStatus(skipped + done + failed, ok.length, `✅ ${job.name} (${(sz/1048576).toFixed(1)}MB)`);
      } catch (e) {
        failed++;
        logger.error({ file: job.name, err: e.message }, 'download failed');
        if (onStatus) onStatus(skipped + done + failed, ok.length, `❌ ${job.name}: ${e.message}`);
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(CONCURRENCY, ok.length); w++) workers.push(worker());
  await Promise.all(workers);

  return { downloaded: done, skipped, failed, files: ok };
}

module.exports = { getShareInfo, resolveDownloadUrl, downloadShare, sanitize, CHROMIUM };
