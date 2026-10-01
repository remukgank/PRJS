'use strict';
// ─── Vidara dashboard session ───────────────────────────────────────────────
// REST API Vidara (api.vidara.so/v1) TIDAK mendukung folder bersarang —
// `folder/create` mengabaikan `parent_id` dan `/folder/list` datar
// (dokumentasi resmi: "Folders are flat — there is no nesting").
// Nesting hanya bisa lewat endpoint dashboard:
//
//   POST https://vidara.to/files
//   { action:'create', folder_name:'…', parent_id:'<fld_id induk>' }
//
// yang butuh session login (bukan API key). Login = POST /login dengan
// { username, password, fingerprint } + header X-CSRF-Token (cookie csrf_token,
// di-decodeURIComponent) + Origin — tanpa Origin ditolak 403.
//
// Semua fungsi di sini punya FALLBACK ke folder flat via API key: endpoint
// dashboard tidak terdokumentasi dan bisa berubah kapan saja, jadi upload
// tidak boleh ikut gagal cuma gara-gara nesting. Terverifikasi 1 Okt 2026
// (lihat .tests/vidara-folder-nesting.js).

const Vdara = require('./vidara-uploader');

const DASHBOARD_BASE = process.env.VIDARA_DASHBOARD_BASE || 'https://vidara.to';
const ROOT_FOLDER = process.env.VIDARA_ANIME_FOLDER || 'Anime';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// judul → fld_id (sekali resolve, dipakai sepanjang hidup proses — batch anime
// jalan sequential, jadi cache ini juga mencegah double-create)
const folderCache = new Map();
let session = null; // { cookies:{…}, csrf:'…' }

function cookieHeader(cookies) {
  return Object.entries(cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function dashFetch(path, opts = {}, cookies = {}) {
  const res = await fetch(DASHBOARD_BASE + path, {
    redirect: 'manual',
    ...opts,
    headers: {
      'user-agent': UA,
      origin: DASHBOARD_BASE,
      ...(opts.headers || {}),
      ...(cookieHeader(cookies) ? { cookie: cookieHeader(cookies) } : {}),
    },
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of setCookies) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) cookies[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return res;
}

// Login dashboard → cookie session_token + csrf. Gagal → null (pemanggil
// jatuh ke fallback flat, bukan error).
async function login() {
  try {
    const user = process.env.VIDARA_USERNAME;
    const pass = process.env.VIDARA_PASSWORD;
    if (!user || !pass) return null;
    const cookies = {};
    const page = await dashFetch('/login', {}, cookies);
    await page.text();
    const csrf = cookies.csrf_token ? decodeURIComponent(cookies.csrf_token) : '';
    if (!csrf) return null;
    const r = await dashFetch('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, accept: 'application/json' },
      body: JSON.stringify({
        username: user,
        password: pass,
        fingerprint: { browser: { name: 'Chrome', version: '131' } },
      }),
    }, cookies);
    const data = await r.json().catch(() => null);
    if (!data || data.success !== true) return null;
    session = { cookies, csrf: cookies.csrf_token ? decodeURIComponent(cookies.csrf_token) : csrf };
    return session;
  } catch {
    return null;
  }
}

async function getSession() {
  if (session) return session;
  return await login();
}

// Buat folder anak di bawah parentId. Mengembalikan fld_id atau null.
// Kalau session mati (303 → /login), login ulang lalu coba sekali lagi.
async function createNestedFolder(name, parentId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await getSession();
    if (!s) return null;
    try {
      const r = await dashFetch('/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': s.csrf, accept: 'application/json' },
        body: JSON.stringify({ action: 'create', folder_name: name, parent_id: String(parentId) }),
      }, s.cookies);
      if (r.status === 303 || r.status === 302) { session = null; continue; } // session expired
      const data = await r.json().catch(() => null);
      if (!data || data.success !== true) return null;
      // respons tidak memuat fld_id → resolve dari daftar (CARI NAMA PERSIS)
      const folders = await Vdara.getFolderList().catch(() => []);
      const hit = folders.filter(f => f.name === name).sort((a, b) => (b.fld_id || 0) - (a.fld_id || 0))[0];
      return hit ? hit.fld_id : null;
    } catch {
      session = null;
    }
  }
  return null;
}

// Cari folder per judul (Anime/<judul>), buat kalau belum ada.
// Urutan aman:
//   1. nama sudah ada di /folder/list (nested ATAU flat — sama fungsinya) → pakai
//   2. belum ada → buat sebagai anak folder root (nesting, via dashboard)
//   3. dashboard gagal → buat flat via API key (TETAP per judul — inti fix)
// Mengembalikan fld_id atau null (null = biar file di root, seperti perilaku lama).
async function getOrCreateSeriesFolder(judul) {
  const title = String(judul || '').trim();
  if (!title) return null;
  if (folderCache.has(title)) return folderCache.get(title);
  try {
    const folders = await Vdara.getFolderList().catch(() => []);
    const existing = folders.find(f => f.name === title);
    if (existing && existing.fld_id) { folderCache.set(title, existing.fld_id); return existing.fld_id; }

    const root = folders.find(f => f.name === ROOT_FOLDER);
    let rootId = root ? root.fld_id : 0;
    if (!rootId) rootId = await Vdara.ensureFolder(ROOT_FOLDER).catch(() => 0);

    let fldId = rootId ? await createNestedFolder(title, rootId) : null;
    if (!fldId) fldId = await Vdara.ensureFolder(title).catch(() => 0); // fallback flat
    if (fldId) { folderCache.set(title, fldId); return fldId; }
  } catch { /* jatuh ke bawah */ }
  return null;
}

// Dipakai tes untuk memaksa login baru
function resetSession() { session = null; }

module.exports = { getOrCreateSeriesFolder, createNestedFolder, login, resetSession, ROOT_FOLDER, DASHBOARD_BASE };
