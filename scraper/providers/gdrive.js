/**
 * gdrive.js — Resolve Google Drive direct download URL.
 * Support:
 *   - https://drive.usercontent.google.com/download?id={id}&export=download
 *   - https://drive.google.com/file/d/{id}/view?usp=sharing
 * Flow: HEAD download?id={id}&export=download&confirm=t&authuser=0 dengan Cookie RU=1
 *       → ambil nama (content-disposition) + ukuran (content-length) TANPA unduh file.
 *       URL dikembalikan untuk download streaming via aria2c (hindari OOM buffer memori).
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

function extFromCt(ct) {
  if (/mp4/.test(ct)) return 'mp4';
  if (/mkv/.test(ct)) return 'mkv';
  if (/webm/.test(ct)) return 'webm';
  if (/mp3|mpeg/.test(ct)) return 'mp3';
  return 'bin';
}

/**
 * Resolve Google Drive file — HANYA baca header (nama + ukuran), tidak unduh body.
 * @returns {Promise<{ url: string, name: string, size: number }>}
 */
async function resolveGdriveFile(url) {
  const id = extractGdriveId(url);
  if (!id) throw new Error('URL Google Drive tidak valid');

  const dlUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t&authuser=0`;

  // HEAD dulu untuk content-disposition + content-length tanpa download body
  try {
    const head = await axios.head(dlUrl, {
      headers: { 'User-Agent': UA, 'Cookie': 'RU=1', Accept: '*/*' },
      timeout: 20000,
      validateStatus: (s) => s < 400,
    });
    const ct = head.headers['content-type'] || '';
    const cd = head.headers['content-disposition'];
    if (head.headers['content-length'] || cd) {
      const name = filenameFromDisposition(cd, `gdrive_${id}.${extFromCt(ct)}`);
      const size = Number(head.headers['content-length'] || 0);
      return { url: dlUrl, name, size };
    }
  } catch {}

  // Fallback: GET stream → baca header, langsung destroy body (tanpa buffer penuh)
  try {
    const res = await axios.get(dlUrl, {
      headers: { 'User-Agent': UA, 'Cookie': 'RU=1', Accept: '*/*' },
      timeout: 20000,
      validateStatus: (s) => s < 400,
      responseType: 'stream',
      maxRedirects: 0,
    });
    const ct = res.headers['content-type'] || '';
    const cd = res.headers['content-disposition'];
    // amankan: consume body se-minimal mungkin lalu destroy
    for (const h of ['content-length', 'content-type', 'content-disposition']) {
      if (res.headers[h]) break;
    }
    if (res.data?.destroy) {
      try { res.data.destroy(); } catch {}
    }
    if (res.headers['content-length'] || cd) {
      const name = filenameFromDisposition(cd, `gdrive_${id}.${extFromCt(ct)}`);
      const size = Number(res.headers['content-length'] || 0);
      return { url: dlUrl, name, size };
    }
  } catch {}

  throw new Error('Google Drive: gagal resolve (link mungkin private/non-downloadable)');
}

module.exports = { isGdriveUrl, extractGdriveId, resolveGdriveFile };