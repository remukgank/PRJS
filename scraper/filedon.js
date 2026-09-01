/**
 * filedon.js — Resolve filedon.co/view/<slug> ke direct download URL.
 * Flow: GET /view/<slug> (ambil csrf + cookie XSRF-TOKEN), lalu POST /download/<slug> (Inertia).
 */

const axios = require('axios');
const crypto = require('crypto');

function isFiledonUrl(url) {
  try {
    const h = new URL(url).hostname;
    return /filedon\.co$/i.test(h);
  } catch { return false; }
}

function extractFiledonId(url) {
  const m = url.match(/filedon\.co\/view\/([A-Za-z0-9]+)/i);
  return m ? m[1] : null;
}

async function resolveFiledonFile(url) {
  const id = extractFiledonId(url);
  if (!id) throw new Error('URL Filedon tidak valid');

  const jar = {};
  // Helper to parse set-cookie
  const client = axios.create({
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36' },
    maxRedirects: 0,
    validateStatus: () => true,
  });

  // 1) GET view page
  const viewRes = await client.get(`https://filedon.co/view/${id}`, {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  if (viewRes.status >= 400) throw new Error(`Filedon page HTTP ${viewRes.status}`);
  const html = String(viewRes.data || '');
  // Collect cookies
  const setCookies = viewRes.headers['set-cookie'] || [];
  let cookieHeader = setCookies.map(c => c.split(';')[0]).join('; ');

  // Extract csrf from meta
  const csrfMatch = html.match(/name="csrf-token" content="([^"]+)"/);
  const csrf = csrfMatch ? csrfMatch[1] : null;

  // Extract file info + version from data-page
  const pageMatch = html.match(/data-page="([^"]+)"/);
  let fileName = `filedon_${id}.mp4`;
  let fileSize = 0;
  let version = '';
  if (pageMatch) {
    try {
      const raw = pageMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const data = JSON.parse(raw);
      const files = data?.props?.files || data?.props?.sharing?.files;
      if (files?.name) fileName = files.name;
      if (files?.size) fileSize = Number(files.size) || 0;
      if (data?.version) version = data.version;
    } catch {}
  }

  // Fallback version regex
  if (!version) {
    const vm = html.match(/"version"\s*:\s*"([a-f0-9]{32})"/);
    if (vm) version = vm[1];
  }

  // Extract XSRF-TOKEN from cookies
  let xsrf = null;
  for (const c of setCookies) {
    const m = c.match(/XSRF-TOKEN=([^;]+)/);
    if (m) xsrf = decodeURIComponent(m[1]);
  }

  // Helper to merge cookies
  const mergeCookies = (base, extra) => {
    const map = new Map();
    for (const c of [...base, ...extra]) {
      const kv = c.split(';')[0].trim();
      const k = kv.split('=')[0];
      if (k) map.set(k, kv);
    }
    return [...map.values()].join('; ');
  };

  // 2) POST /download/<id> — Inertia (flash download_url on next GET)
  const hdrs = {
    Accept: 'text/html, application/xhtml+xml',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Inertia': 'true',
    Origin: 'https://filedon.co',
    Referer: `https://filedon.co/view/${id}`,
    Cookie: cookieHeader,
  };
  if (version) hdrs['X-Inertia-Version'] = version;
  if (csrf) hdrs['X-CSRF-TOKEN'] = csrf;
  if (xsrf) hdrs['X-XSRF-TOKEN'] = xsrf;

  const postRes = await client.post(`https://filedon.co/download/${id}`, {}, {
    headers: hdrs,
    maxRedirects: 0,
    validateStatus: () => true,
  });

  let downloadUrl = null;
  // POST 302 location is just redirect to view, not download — ignore unless S3
  const loc = postRes.headers['location'] || postRes.headers['Location'] || null;
  if (loc && /r2\.cloudflarestorage\.com|response-content-disposition/i.test(loc)) downloadUrl = loc;
  try {
    const body = typeof postRes.data === 'string' ? JSON.parse(postRes.data) : postRes.data;
    if (body?.props?.flash?.download_url) downloadUrl = body.props.flash.download_url;
  } catch {}

  // Flash is on next GET view
  if (!downloadUrl) {
    const postCookies = postRes.headers['set-cookie'] || [];
    if (postCookies.length) cookieHeader = mergeCookies(setCookies, postCookies);
    const view2 = await client.get(`https://filedon.co/view/${id}`, {
      headers: { Accept: 'text/html,application/xhtml+xml', Cookie: cookieHeader },
      maxRedirects: 0,
      validateStatus: () => true,
    });
    const html2 = String(view2.data || '');
    const m2 = html2.match(/data-page="([^"]+)"/);
    if (m2) {
      try {
        const raw2 = m2[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        const data2 = JSON.parse(raw2);
        if (data2?.props?.flash?.download_url) downloadUrl = data2.props.flash.download_url;
      } catch {}
    }
  }

  if (!downloadUrl) throw new Error('Gagal mendapatkan link download Filedon (flash kosong — coba lagi atau file limit)');

  return { url: downloadUrl, name: fileName, size: fileSize };
}

module.exports = { isFiledonUrl, extractFiledonId, resolveFiledonFile };
