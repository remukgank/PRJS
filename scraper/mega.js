/**
 * mega.js — Resolve mega.nz/file/<id>#<key> ke info file + download stream.
 * Flow: megajs File.fromURL → loadAttributes (nama + ukuran tanpa download).
 */

const fs = require('fs');
const mega = require('megajs');

function isMegaUrl(url) {
  try {
    const u = new URL(url);
    return /mega\.nz$/i.test(u.hostname) && /^\/file\//i.test(u.pathname);
  } catch { return false; }
}

function extractMegaId(url) {
  const m = url.match(/mega\.nz\/file\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

function loadAttrs(file) {
  return new Promise((resolve, reject) => {
    file.loadAttributes((err, f) => (err ? reject(err) : resolve(f || file)));
  });
}

async function resolveMegaFile(url) {
  const id = extractMegaId(url);
  if (!id || !url.includes('#')) throw new Error('URL Mega tidak valid (perlu #key)');
  const file = mega.File.fromURL(url);
  const loaded = await loadAttrs(file).catch((err) => {
    throw new Error(`Mega gagal dibaca: ${err.message.slice(0, 100)}`);
  });
  if (loaded.directory) throw new Error('Link folder Mega belum didukung (baru file)');
  const name = loaded.name || `mega_${id}.mp4`;
  const size = Number(loaded.size) || 0;
  return { name, size, file: loaded };
}

// Download via megajs stream → file lokal. onProgress(bytesDone, bytesTotal).
function downloadMegaFile(megaFile, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const total = Number(megaFile.size) || 0;
    let done = 0;
    let stream;
    try {
      stream = megaFile.download();
    } catch (err) {
      return reject(err);
    }
    const out = fs.createWriteStream(destPath);
    stream.on('data', (chunk) => {
      done += chunk.length;
      if (onProgress) {
        try { onProgress(done, total); } catch {}
      }
    });
    stream.on('error', (err) => {
      try { out.destroy(); } catch {}
      reject(err);
    });
    out.on('error', reject);
    out.on('finish', () => resolve(destPath));
    stream.pipe(out);
  });
}

module.exports = { isMegaUrl, extractMegaId, resolveMegaFile, downloadMegaFile };
