const crypto = require('crypto');
const { execFile } = require('child_process');
const { logger } = require('../logger');

const API_BASE = 'https://api.gofile.io';
const GOFILE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const GOFILE_LOCALE = 'en-US';
const TOKEN_WINDOW_SEC = 14400;
const TOKEN_SECRET = '12af056dacea0b';

function generateWebsiteToken(accountToken) {
  const timeWindow = String(Math.floor(Date.now() / 1000 / TOKEN_WINDOW_SEC));
  const seed = `${GOFILE_UA}::${GOFILE_LOCALE}::${accountToken}::${timeWindow}::${TOKEN_SECRET}`;
  return crypto.createHash('sha256').update(seed).digest('hex');
}

let guestToken = null;
let guestTokenExp = 0;

function isGofileUrl(url) {
  try { return /(^|\.)gofile\.io$/i.test(new URL(url).hostname); }
  catch { return false; }
}

function isGofileDirectUrl(url) {
  try {
    const host = new URL(url).hostname;
    return /^((cold|store|file)[\w-]*)\.gofile\.io$/i.test(host);
  } catch { return false; }
}

function filenameFromGofileUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/');
    return parts[parts.length - 1] || `gofile_${Date.now()}.mp4`;
  } catch { return `gofile_${Date.now()}.mp4`; }
}

function extractGofileId(url) {
  const m = url.match(/gofile\.io\/(?:d|c)\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

function curlJson(method, url, extraHeaders = [], body = null, timeoutSec = 30) {
  return new Promise((resolve, reject) => {
    const args = [
      '-s', '-m', String(timeoutSec), '-w', '\n%{http_code}',
      '-X', method,
      '-H', 'Accept: application/json',
      '-H', 'Origin: https://gofile.io',
      '-H', 'Referer: https://gofile.io/',
      '-H', `User-Agent: ${GOFILE_UA}`,
      ...extraHeaders,
    ];
    if (body) {
      args.push('-H', 'Content-Type: application/json');
      args.push('-d', typeof body === 'string' ? body : JSON.stringify(body));
    }
    args.push(url);

    execFile('curl', args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || '').trim().slice(0, 200) || err.message;
        return reject(new Error(`curl: ${detail}`));
      }

      const text = String(stdout || '');
      const lastNl = text.lastIndexOf('\n');
      let body = text, status = 0;
      if (lastNl >= 0) {
        const tail = text.slice(lastNl + 1).trim();
        if (/^\d{3}$/.test(tail)) { status = parseInt(tail, 10); body = text.slice(0, lastNl); }
      }

      let json = null;
      try { json = body ? JSON.parse(body) : null; } catch {}

      if (status >= 400) {
        return reject(new Error(`GoFile HTTP ${status}: ${json?.message || body.slice(0, 100)}`));
      }
      if (!json) return reject(new Error(`GoFile non-JSON (HTTP ${status}): ${body.slice(0, 200)}`));
      resolve(json);
    });
  });
}

async function getGuestToken() {
  if (guestToken && Date.now() < guestTokenExp) return guestToken;
  try {
    const res = await curlJson('POST', `${API_BASE}/accounts`, [], {});
    if (res?.status !== 'ok' || !res?.data?.token) {
      throw new Error(JSON.stringify(res).slice(0, 200));
    }
    guestToken = res.data.token;
    guestTokenExp = Date.now() + 9 * 24 * 60 * 60 * 1000;
    logger.info('Guest token GoFile dibuat');
    return guestToken;
  } catch (err) {
    logger.error({ err: err.message }, 'Gagal buat guest token');
    throw new Error('Gagal mendapatkan guest token');
  }
}

async function getToken() {
  const envToken = (process.env.GOFILE_TOKEN || '').trim();
  if (envToken) return envToken;
  return getGuestToken();
}

function invalidateToken() {
  if (!(process.env.GOFILE_TOKEN || '').trim()) {
    guestToken = null;
    guestTokenExp = 0;
  }
}

async function resolveViaWorker(id) {
  const worker = (process.env.GOFILE_WORKER_URL || '').trim();
  if (!worker) return null;
  const apiUrl = `${worker}/resolve?code=${encodeURIComponent(id)}`;
  const json = await curlJson('GET', apiUrl).catch(() => null);
  if (json?.ok && json?.data) return { status: 'ok', data: json.data };
  return null;
}

async function resolveGofileFiles(url) {
  const id = extractGofileId(url);
  if (!id) throw new Error('URL GoFile tidak valid');

  const token = await getToken();
  const wt = generateWebsiteToken(token);
  const apiUrl = `${API_BASE}/contents/${id}?page=1&pageSize=1000&sortField=name&sortDirection=1`;
  const authHeaders = () => [
    '-H', `Authorization: Bearer ${token}`,
    '-H', `X-Website-Token: ${wt}`,
    '-H', 'X-BL: en-US',
  ];

  let json;
  try {
    json = await curlJson('GET', apiUrl, authHeaders(), null, 25);
    if (json?.status === 'error-rateLimit') throw new Error('GoFile HTTP 429: error-rateLimit');
  } catch (err) {
    const isNotPremium = /error-notPremium/.test(err.message);
    const isNetworkBlock = /curl:/.test(err.message);
    if (isNotPremium) {
      // Fallback: file publik sering bisa tanpa Authorization, hanya WT
      try {
        json = await curlJson('GET', apiUrl, [
          '-H', `X-Website-Token: ${wt}`,
          '-H', 'X-BL: en-US',
        ], null, 25);
      } catch {}
      if (!json || json?.status !== 'ok') {
        // Network block (Replit tidak bisa ke api.gofile.io) — coba scrape share page
        if (isNetworkBlock || !json) json = await scrapeGofileSharePage(id).catch(() => null);
        if (!json || json?.status !== 'ok') {
          const hint = (process.env.GOFILE_TOKEN || '').trim()
            ? 'Akun tidak premium atau token expired'
            : 'Set GOFILE_TOKEN dengan token akun premium (gofile.io → Account → API)';
          throw Object.assign(new Error(`GoFile: butuh akun premium. ${hint}`), { permanent: true });
        }
      }
    } else if (/HTTP 401/.test(err.message) || /error-auth/.test(err.message)) {
      invalidateToken();
      const newToken = await getToken();
      json = await curlJson('GET', apiUrl, [
        '-H', `Authorization: Bearer ${newToken}`,
        '-H', `X-Website-Token: ${generateWebsiteToken(newToken)}`,
        '-H', 'X-BL: en-US',
      ], null, 25);
    } else if (/429|rateLimit/.test(err.message)) {
      logger.warn({ id, err: err.message }, 'GoFile rate limit, retry dengan backoff');
      await new Promise(r => setTimeout(r, 5000));
      json = await curlJson('GET', apiUrl, authHeaders(), null, 25).catch(() => null);
      if (!json || json?.status === 'error-rateLimit') {
        // Fallback ke worker relay, lalu scrape jika rate limit persist
        json = await resolveViaWorker(id);
        if (!json) json = await scrapeGofileSharePage(id);
      }
    } else if (isNetworkBlock) {
      // api.gofile.io tidak bisa diakses dari Replit (timeout) — coba Cloudflare Worker relay, lalu scrape
      json = await resolveViaWorker(id);
      if (!json) json = await scrapeGofileSharePage(id);
    } else {
      throw err;
    }
  }

  if (json?.status !== 'ok') throw new Error(`GoFile API: ${json?.message || JSON.stringify(json).slice(0, 200)}`);

  const data = json.data;
  const files = [];

  if (data.type === 'file') {
    if (!data.link) throw new Error('GoFile response tidak punya link');
    files.push({ url: data.link, name: data.name || `gofile_${id}`, size: data.size || 0 });
  } else if (data.type === 'folder') {
    const items = Object.values(data.children || {}).filter(c => c.type === 'file');
    for (const child of items) {
      files.push({ url: child.link, name: child.name || `gofile_${child.id}`, size: child.size || 0 });
    }
  }

  if (!files.length) throw new Error('Tidak ada file ditemukan');
  return files;
}

function scrapeGofileSharePage(id) {
  // Fallback saat api.gofile.io tidak bisa diakses (Replit/network block)
  // Langsung via FlareSolverr — gofile share page render JS, curl biasa tidak ada link
  return new Promise((resolve, reject) => {
    const flared = process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191';
    const body = JSON.stringify({ cmd: 'request.get', url: `https://gofile.io/d/${id}`, maxTimeout: 45000 });
    const flArgs = ['-s', '-m', '60', '-H', 'Content-Type: application/json', '-d', body, `${flared}/v1`];
    execFile('curl', flArgs, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      try {
        const j = JSON.parse(String(stdout || '{}'));
        const h2 = j.solution?.response || j.response || '';
        const m2 = String(h2).match(/https:\/\/store[^\s"']+\.gofile\.io\/download[^"\s']+/i);
        if (m2) {
          const url = m2[0];
          const name = decodeURIComponent(url.split('/').pop().split('?')[0] || `gofile_${id}.mp4`);
          return resolve({
            status: 'ok',
            data: { type: 'file', link: url, name, size: 0 },
          });
        }
      } catch {}
      if (err) return reject(err);
      reject(new Error('Scrape share page tidak menemukan download link'));
    });
  });
}

async function resolveGofileFirstFile(url) {
  const files = await resolveGofileFiles(url);
  return files[0];
}

module.exports = {
  isGofileUrl,
  isGofileDirectUrl,
  filenameFromGofileUrl,
  extractGofileId,
  resolveGofileFiles,
  resolveGofileFirstFile,
};
