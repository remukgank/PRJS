const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const API_BASE = 'https://api.vidara.so/v1';
const VIDARA_KEY = process.env.VIDARA_API || '';

function getKey() {
  if (!VIDARA_KEY) {
    const fromLast = '/run/replit/env/last';
    if (fs.existsSync(fromLast)) {
      const content = fs.readFileSync(fromLast, 'utf8');
      const m = content.match(/VIDARA_API=(\S+)/);
      if (m) return m[1];
    }
  }
  return VIDARA_KEY;
}

function apiUrl(endpoint, params = {}) {
  const qs = new URLSearchParams({ api_key: getKey(), ...params }).toString();
  return `${API_BASE}${endpoint}?${qs}`;
}

async function uploadFile(filePath) {
  const key = getKey();
  if (!key) throw new Error('VIDARA_API key not found');

  const stat = fs.statSync(filePath);
  if (stat.size > 2 * 1024 * 1024 * 1024) throw new Error('File > 2GB');

  const form = new FormData();
  form.append('api_key', key);
  form.append('file', fs.createReadStream(filePath));

  const { data: uploadServer } = await axios.get(apiUrl('/upload/server')).catch(() => ({ data: { result: { upload_server: 'https://s1.vidara.so/api/upload' } } }));
  const serverUrl = uploadServer?.result?.upload_server || 'https://s1.vidara.so/api/upload';

  const res = await axios.post(serverUrl, form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 3600000,
  });

  return res.data;
}

async function uploadUrl(directUrl, title = '') {
  const res = await axios.get(apiUrl('/upload/url', { url: directUrl }), { timeout: 30000 });
  return res.data;
}

async function fileInfo(filecode) {
  const res = await axios.get(apiUrl('/video/info', { filecode }), { timeout: 10000 });
  return res.data;
}

async function renameVideo(filecode, title) {
  const res = await axios.get(apiUrl('/video/rename', { filecode, title }), { timeout: 10000 });
  return res.data;
}

async function listVideos(page = 1, limit = 100) {
  const res = await axios.get(apiUrl('/video/list', { page, limit }), { timeout: 15000 });
  return res.data;
}

async function waitForEncoding(filecode, maxWaitMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const info = await fileInfo(filecode);
    const encodings = info?.result?.[0]?.encodings;
    if (!encodings || encodings.length === 0) {
      const status = info?.result?.[0]?.status;
      if (status === 'active') return true;
      if (status === 'error') throw new Error('Encoding error');
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Encoding timeout');
}

function makeEmbedUrl(filecode) {
  return `https://vidara.so/e/${filecode}`;
}

module.exports = {
  uploadFile,
  uploadUrl,
  fileInfo,
  renameVideo,
  listVideos,
  waitForEncoding,
  makeEmbedUrl,
  getKey,
};
