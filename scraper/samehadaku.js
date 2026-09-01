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
      if (status >= 400) return reject(new Error(`Worker HTTP ${status}: ${body.slice(0, 100)}`));
      if (!json) return reject(new Error(`Worker non-JSON: ${body.slice(0, 100)}`));
      resolve(json);
    });
  });
}

function isSamehadakuUrl(url) {
  try { return /samehadaku\.how$/i.test(new URL(url).hostname) || url.includes('samehadaku.how'); } catch { return false; }
}

function parseSamehadakuEpisode(url) {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    // /tensei-shitara-slime-datta-ken-season-4-episode-1/  or  /...-エピソード-1/  or  /tensei-...-episode-10/
    const m = path.match(/\/([^\/]+?)(?:-episode-|-エピソード-|-episode)(\d+)\/?$/i);
    if (!m) return null;
    const fullSlug = m[1]; // tensei-shitara-slime-datta-ken-season-4
    const ep = parseInt(m[2], 10);
    const seasonMatch = fullSlug.match(/-season-(\d+)$/i);
    const season = seasonMatch ? parseInt(seasonMatch[1], 10) : null;
    let titleSlug = fullSlug;
    if (seasonMatch) titleSlug = fullSlug.replace(/-season-\d+$/i, '');
    const title = titleSlug.split('-').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return { title, season, episode: ep, provider: 'samehadaku', slug: fullSlug };
  } catch { return null; }
}

function parseSamehadakuAnime(url) {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    const m = path.match(/\/anime\/([^\/]+)\/?$/i);
    if (!m) return null;
    const fullSlug = m[1];
    const seasonMatch = fullSlug.match(/-season-(\d+)$/i);
    const season = seasonMatch ? parseInt(seasonMatch[1], 10) : null;
    let titleSlug = fullSlug;
    if (seasonMatch) titleSlug = fullSlug.replace(/-season-\d+$/i, '');
    const title = titleSlug.split('-').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return { title, season, provider: 'samehadaku', slug: fullSlug };
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
