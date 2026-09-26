/**
 * samehadaku.js — handler link v2.samehadaku.how via Cloudflare Worker relay.
 */

const { execFile } = require('child_process');

function curlJson(method, url, extraHeaders = [], timeoutSec = 30) {
  return new Promise((resolve, reject) => {
    const args = ['-s', '-m', String(timeoutSec), '-w', '\n%{http_code}', '-X', method, '-H', 'Accept: application/json', ...extraHeaders, url];
    execFile('curl', args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`curl: ${err.message.slice(0, 80)}`));
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
        const workerMsg = json?.message || json?.ok === false ? json.message : null;
        return reject(new Error(workerMsg || `Worker HTTP ${status}`));
      }
      if (!json) return reject(new Error(`Worker non-JSON (len=${body.length})`));
      resolve(json);
    });
  });
}

function isSamehadakuUrl(url) {
  try { return /samehadaku\.how$/i.test(new URL(url).hostname) || url.includes('samehadaku.how'); } catch { return false; }
}

// Flag ringkasan yg bukan daftar episode — movie/single jangan dikira ep 1.
const SUMMARY_FLAG_RE = /-(movie|movie-seasons|ova|ona|special|end|batch)[\w-]*$/i;

function parseSamehadakuEpisode(url) {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    // Kasus normal: ...-episode-N/ (termasuk -end/-END, sejajar pola worker epRe)
    const m = path.match(/\/([^\/]+?)(?:-episode-|-エピソード-|-episode)(\d+)(?:-?(?:end|END|End))?\/?$/i);
    // Kasus ep 1: halaman /<slug>/ tanpa prefix /anime/ dan tanpa -episode-N
    const slugM = !m && !/\/anime\//i.test(path) ? path.match(/^\/([^\/]+)\/?$/) : null;
    const fullSlug = m ? m[1] : (slugM && !SUMMARY_FLAG_RE.test(slugM[1]) ? slugM[1] : null);
    if (!fullSlug) return null;
    const ep = m ? parseInt(m[2], 10) : 1;
    const seasonMatch = fullSlug.match(/-season-(\d+)(?:-part-\d+)?$/i);
    const season = seasonMatch ? parseInt(seasonMatch[1], 10) : null;
    const partMatch = fullSlug.match(/-part-(\d+)$/i);
    const part = partMatch ? parseInt(partMatch[1], 10) : null;
    // Judul TIDAK boleh memuat season/part: pemanggil (mis. samehadakuAnimeSlug)
    // sudah menambahkannya sendiri sebagai ` S{n}`/` P{n}`. Kalau judul ikut
    // memuatnya, slug library terduplikasi ("-s4-s4") dan deteksi "sudah masuk"
    // gagal.suffix season untuk folder Vidoy disusun di handlers/vidoy.js.
    let titleSlug = fullSlug
      .replace(/-season-\d+(?:-part-\d+)?$/i, '')
      .replace(/-part-\d+$/i, '');
    const title = titleSlug.split('-').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return { title, season, part, episode: ep, provider: 'samehadaku', slug: fullSlug };
  } catch { return null; }
}

function parseSamehadakuAnime(url) {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    const m = path.match(/\/anime\/([^\/]+)\/?$/i);
    if (!m) return null;
    const fullSlug = m[1];
    const seasonMatch = fullSlug.match(/-season-(\d+)(?:-part-\d+)?$/i);
    const season = seasonMatch ? parseInt(seasonMatch[1], 10) : null;
    const partMatch = fullSlug.match(/-part-(\d+)$/i);
    const part = partMatch ? parseInt(partMatch[1], 10) : null;
    // Judul TIDAK boleh memuat season/part: pemanggil (mis. samehadakuAnimeSlug)
    // sudah menambahkannya sendiri sebagai ` S{n}`/` P{n}`. Kalau judul ikut
    // memuatnya, slug library terduplikasi ("-s4-s4") dan deteksi "sudah masuk"
    // gagal.suffix season untuk folder Vidoy disusun di handlers/vidoy.js.
    let titleSlug = fullSlug
      .replace(/-season-\d+(?:-part-\d+)?$/i, '')
      .replace(/-part-\d+$/i, '');
    const title = titleSlug.split('-').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return { title, season, part, provider: 'samehadaku', slug: fullSlug };
  } catch { return null; }
}

async function resolveSamehadakuFullhd(url) {
  const worker = (process.env.GOFILE_WORKER_URL || '').trim();
  if (!worker) throw new Error('GOFILE_WORKER_URL belum diset');
  const apiUrl = `${worker}/samehadaku?url=${encodeURIComponent(url)}`;
  const json = await curlJson('GET', apiUrl);
  if (!json?.ok) throw new Error(json?.message || 'Gagal resolve Samehadaku (cek Worker deploy & CF_CLEARANCE)');
  return json;
}

module.exports = { isSamehadakuUrl, resolveSamehadakuFullhd, parseSamehadakuEpisode, parseSamehadakuAnime };
