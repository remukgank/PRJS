const { execFile } = require('child_process');

function isPixeldrainUrl(url) {
  try { return /(^|\.)pixeldrain\.com$/i.test(new URL(url).hostname); }
  catch { return false; }
}

function extractPixeldrainId(url) {
  const m = url.match(/pixeldrain\.com\/(?:u|api\/file)\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

function filenameFromPixeldrainUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/');
    return parts[parts.length - 1] || `pixeldrain_${Date.now()}.mp4`;
  } catch { return `pixeldrain_${Date.now()}.mp4`; }
}

function pixeldrainDirectUrl(id) {
  return `https://pixeldrain.com/api/file/${id}?download`;
}

function apiUrl(id) {
  return `https://pixeldrain.com/api/file/${id}/info`;
}

function curlJson(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '-s', '-m', '30', '-w', '\n%{http_code}',
      '-H', 'Accept: application/json',
      '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      url,
    ];

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
        return reject(new Error(`Pixeldrain HTTP ${status}: ${json?.message || body.slice(0, 100)}`));
      }
      if (!json) return reject(new Error(`Pixeldrain non-JSON (HTTP ${status}): ${body.slice(0, 200)}`));
      resolve(json);
    });
  });
}

async function getPixeldrainInfo(url) {
  const id = extractPixeldrainId(url);
  if (!id) throw new Error('URL Pixeldrain tidak valid');

  const info = await curlJson(apiUrl(id));
  if (!info.success) throw new Error(`Pixeldrain: ${info.message || 'gagal get info'}`);

  return {
    id: info.id,
    name: info.name,
    size: info.size,
    mimeType: info.mime_type,
    directUrl: pixeldrainDirectUrl(id),
  };
}

module.exports = {
  isPixeldrainUrl,
  extractPixeldrainId,
  filenameFromPixeldrainUrl,
  pixeldrainDirectUrl,
  getPixeldrainInfo,
};
