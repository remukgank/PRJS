/**
 * gdrive.js — Resolve Google Drive direct download URL.
 * Support:
 *   - https://drive.usercontent.google.com/download?id={id}&export=download
 *   - https://drive.google.com/file/d/{id}/view?usp=sharing
 * Flow: GET download?id={id}&export=download&confirm=t&authuser=0 dengan Cookie RU=1
 *       → langsung streaming mp4/mkv (skips virus-scan warning utk file publik besar).
 * Akses publik (bukan folder pribadi yang butuh share per-user).
 */

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36';

function extractGdriveId(url) {
  // drive.usercontent.google.com/download?id=XXX
  let m = url.match(/drive\.usercontent\.google\.com\/download\?id=([A-Za-z0-9_-]+)/i);
  if (m) return m[1];
  // drive.google.com/file/d/{id}/view
  m = url.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/i);
  if (m) return m[1];
  // drive.google.com/open?id=XXX
  m = url.match(/drive\.google\.com\/open\?id=([A-Za-z0-9_-]+)/i);
  if (m) return m[1];
  // uc?export=download&id=
  m = url.match(/[?&]id=([A-Za-z0-9_-]+)/i);
  if (m && /drive\.google|googleusercontent/.test(url)) return m[1];
  return null;
}

function isGdriveUrl(url) {
  try {
    const h = new URL(url).hostname;
    return /(?:drive\.google\.com|drive\.usercontent\.google\.com|docs\.google\.com|\.googleusercontent\.com)$/i.test(h) && /[?&]id=[A-Za-z0-9_-]+|file\/d\//.test(url);
  } catch { return false; }
}

function filenameFromDisposition(cd, fallback) {
  if (!cd) return fallback;
  const m = cd.match(/filename="?([^"]+)"?$/i);
  return m ? m[1].replace(/^"|"$/g, '') : fallback;
}

/**
 * Resolve Google Drive file.
 * @returns {Promise<{ url: string, name: string, size: number }>}
 */
async function resolveGdriveFile(url) {
  const id = extractGdriveId(url);
  if (!id) throw new Error('URL Google Drive tidak valid');

  const client = axios.create({
    maxRedirects: 0,
    validateStatus: () => true,
    headers: { 'User-Agent': UA, 'Cookie': 'RU=1' },
  });

  const dlUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t&authuser=0`;
  const res = await client.get(dlUrl, {
    headers: { 'User-Agent': UA, 'Cookie': 'RU=1', Accept: '*/*', Referer: `https://drive.usercontent.google.com/download?id=${id}&export=download&authuser=0` },
  });

  const ct = res.headers['content-type'] || '';
  const loc = res.headers['location'] || res.headers['Location'];
  const cd = res.headers['content-disposition'];

  // Kasus 1: streaming langsung (mp4/mkv webm) — content-type video + content-length
  if (/video\/|application\/octet-stream|audio\//.test(ct) && (res.headers['content-length'] || res.data)) {
    if (!/video\/|application\/octet-stream|audio\//.test(ct)) {}
    const name = filenameFromDisposition(cd, `gdrive_${id}.${extFromCt(ct)}`);
    const size = Number(res.headers['content-length'] || 0) || (Buffer.isBuffer(res.data) ? res.data.length : 0);
    return { url: dlUrl, name, size };
  }

  // Kasus 2: redirect (302) ke file saat resolve proxy — follow manual
  if (loc && /^https?:/.test(loc)) {
    const r2 = await client.get(loc, { responseType: 'arraybuffer' });
    const ct2 = r2.headers['content-type'] || '';
    const cd2 = r2.headers['content-disposition'];
    if (/video\/|application\/octet-stream/.test(ct2)) {
      const name = filenameFromDisposition(cd2, `gdrive_${id}.mp4`);
      const size = Number(r2.headers['content-length'] || 0) || (Buffer.isBuffer(r2.data) ? r2.data.length : 0);
      return { url: loc, name, size };
    }
  }

  throw new Error('Google Drive: gagal resolve (link mungkin private/non-downloadable)');
}

function extFromCt(ct) {
  if (/mp4/.test(ct)) return 'mp4';
  if (/mkv/.test(ct)) return 'mkv';
  if (/webm/.test(ct)) return 'webm';
  if (/mp3|mpeg/.test(ct)) return 'mp3';
  return 'bin';
}

module.exports = { isGdriveUrl, extractGdriveId, resolveGdriveFile };