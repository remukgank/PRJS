#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getVideoUrl, getAllEpisodes } = require('./index');
const { createSession, destroySession } = require('./dramafren');

let DOWNLOADS = path.join(__dirname, 'downloads');
let GLOBAL_TRACK = path.join(DOWNLOADS, 'track.json');
function setDownloadsDir(dir) {
  DOWNLOADS = dir;
  GLOBAL_TRACK = path.join(dir, 'track.json');
}
function readEnv(name) {
  if (process.env[name]) return process.env[name];
  const sources = [
    '/run/replit/env/last',
    '/run/replit/env/latest',
    path.join(__dirname, '..', '.env'),
    path.join(__dirname, '.env'),
  ];
  for (const src of sources) {
    try {
      const content = fs.readFileSync(src, 'utf8');
      const m = content.match(new RegExp(name + '=(\\S+)'));
      if (m) return m[1];
    } catch {}
  }
  return '';
}
const VIDARA_KEY = readEnv('VIDARA_API') || readEnv('VIDARA_API_KEY');
const VIDARA_DOMAIN = readEnv('VIDARA_DOMAIN') || 'vidara.so';
const VIDARA_API_BASE = readEnv('VIDARA_API_BASE') || `https://api.${VIDARA_DOMAIN}/v1`;
const VIDARA_UPLOAD_TIMEOUT_MS = Number(readEnv('VIDARA_UPLOAD_TIMEOUT_MS') || 0) || 600000;

// ─── Vidara API ─────────────────────────────────────────────────────────────

async function vidaraCall(endpoint, params = {}) {
  const url = `${VIDARA_API_BASE}${endpoint}?api_key=${VIDARA_KEY}&${new URLSearchParams(params)}`;
  const res = await axios.get(url, { timeout: 600000 });
  return res.data;
}

async function getFolderList() {
  const data = await vidaraCall('/folder/list');
  return data?.result?.folders || [];
}

async function createFolder(name) {
  const data = await vidaraCall('/folder/create', { name });
  return data?.result?.folder_id || data?.result?.fld_id;
}

async function moveToFolder(filecode, fldId) {
  if (!fldId) return;
  await vidaraCall('/video/move', { filecode, fld_id: fldId }).catch(() => {});
}

async function renameVideo(filecode, title) {
  await vidaraCall('/video/rename', { filecode, title }).catch(() => {});
}

async function uploadUrlToVidara(directUrl) {
  const data = await vidaraCall('/upload/url', { url: directUrl });
  return data?.data?.filecode || data?.filecode;
}

// ─── Upload file via curl (metode VDL, dipakai upload batch) ─────────────────

const { execFile } = require('child_process');

async function getUploadServer() {
  const data = await vidaraCall('/upload/server');
  return data?.upload_server || data?.result?.upload_server;
}

function extractFilecode(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { parsed = { filecode: raw }; }
  }
  const root = parsed.result || parsed.data || parsed;
  const fc = root.filecode || parsed.filecode;
  if (!fc) return '';
  return String(fc).startsWith('http') ? String(fc).split('/').pop() : String(fc);
}

// POST {upload_server} multipart(api_key, file) via curl subprocess.
// Alasan curl (bukan node http): server upload Vidara tidak menutup koneksi
// secara reliable ke http.request node (hang) — divergen dengan metode VDL.
async function uploadFileViaCurl(filePath, onProgress = null) {
  if (!VIDARA_KEY) throw new Error('VIDARA_API kosong');
  const server = await getUploadServer();
  if (!server) throw new Error('upload_server tidak didapat');
  return new Promise((resolve, reject) => {
    const args = ['-sS', '-L', '-F', `api_key=${VIDARA_KEY}`, '-F', `file=@"${filePath}"`, server];
    const child = execFile('curl', args, { maxBuffer: 32 * 1024 * 1024, timeout: VIDARA_UPLOAD_TIMEOUT_MS }, (err, stdout) => {
      if (err && !stdout) return reject(new Error(`Vidara curl error: ${err.message}`));
      const fc = extractFilecode(stdout);
      if (!fc) return reject(new Error(`Vidara upload: filecode kosong — ${String(stdout).slice(0, 200)}`));
      resolve(fc);
    });
    if (onProgress && child.stderr) {
      let lastPct = -1;
      child.stderr.on('data', (chunk) => {
        const m = chunk.toString().match(/(\d+(?:\.\d+)?)%/);
        if (m) {
          const pct = Math.floor(parseFloat(m[1]));
          if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
        }
      });
    }
  });
}

async function waitForEncoding(filecode, maxMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const data = await vidaraCall('/video/info', { filecode });
    const status = data?.result?.[0]?.status;
    if (status === 'active') return true;
    if (status === 'error') throw new Error('Encoding error');
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Encoding timeout');
}

async function ensureFolder(name) {
  const folders = await getFolderList();
  const existing = folders.find(f => f.name === name);
  if (existing) return existing.fld_id;
  return await createFolder(name);
}

// ─── Track ──────────────────────────────────────────────────────────────────

function loadGlobal() {
  try { return JSON.parse(fs.readFileSync(GLOBAL_TRACK, 'utf-8')); } catch { return {}; }
}

function saveGlobal(t) {
  fs.writeFileSync(GLOBAL_TRACK, JSON.stringify(t, null, 2));
}

function loadPerDrama(subDir) {
  const p = path.join(subDir, 'track.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return { uploaded: [], vidara: {} }; }
}

function savePerDrama(subDir, t) {
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'track.json'), JSON.stringify(t, null, 2));
}

function sanitizeDir(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').slice(0, 100);
}

function vidaraFolderName(title, providerLabel) {
  const prov = String(providerLabel || 'Misc').replace(/^reelfren_/, '');
  return `${prov} — ${title}`.slice(0, 100);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function processDrama(dramaKey, info, session) {
  const { subdomain, id, slug, title } = info;
  const safeTitle = sanitizeDir(title || subdomain);
  const subDir = path.join(DOWNLOADS, subdomain, safeTitle);
  fs.mkdirSync(subDir, { recursive: true });

  const track = loadPerDrama(subDir);
  if (!track.vidara) track.vidara = {};
  const hasUploaded = track.uploaded && track.uploaded.length > 0;

  if (!hasUploaded) {
    console.log(`  ⏭️  ${title}: no Telegram uploads, skip`);
    return { done: 0, fail: 0 };
  }

  const pending = track.uploaded.filter(ep => !track.vidara[ep]);
  if (!pending.length) {
    console.log(`  ✅ ${title}: ${Object.keys(track.vidara).length} eps done`);
    const gt = loadGlobal();
    if (gt[dramaKey]) { gt[dramaKey].hasVidara = true; saveGlobal(gt); }
    return { done: 0, fail: 0 };
  }

  // Buat folder di Vidara — rapi per provider + judul
  const folderName = vidaraFolderName(title, subdomain);
  let fldId;
  try {
    fldId = await ensureFolder(folderName);
    console.log(`  📁 Folder: "${folderName}" (ID: ${fldId})`);
  } catch {
    console.log(`  ⚠️  Gagal bikin folder, upload ke root`);
  }

  console.log(`  🎬 ${title}: ${pending.length}/${track.uploaded.length} eps ke Vidara`);

  let episodes;
  try {
    const result = await getAllEpisodes(subdomain, id, slug || '', 'id', session)
      .catch(() => getAllEpisodes(subdomain, id, slug || '', 'in', session));
    episodes = result.episodes;
  } catch (e) {
    console.log(`  ❌ ${title}: scrape gagal - ${e.message.slice(0, 60)}`);
    return { done: 0, fail: 1 };
  }

  if (!episodes || !episodes.length) {
    console.log(`  ❌ ${title}: 0 episode`);
    return { done: 0, fail: 1 };
  }

  let done = 0, fail = 0;
  for (const ep of episodes) {
    const epStr = String(ep.ep).padStart(2, '0');
    if (!pending.includes(epStr)) continue;

    try {
      process.stdout.write(`    Ep ${epStr}...`);
      const result = await getVideoUrl(subdomain, id, slug || '', ep.urlEp, 1, 'id', session);
      if (!result?.videoUrl) { process.stdout.write(' ❌ no URL\n'); fail++; continue; }

      const fc = await uploadUrlToVidara(result.videoUrl);
      if (!fc) { process.stdout.write(' ❌ upload gagal\n'); fail++; continue; }

      await renameVideo(fc, `${title} — Ep ${epStr}`);
      if (fldId) await moveToFolder(fc, fldId);
      await waitForEncoding(fc).catch(() => {});

      track.vidara[epStr] = fc;
      savePerDrama(subDir, track);

      process.stdout.write(` ✅ ${fc}\n`);
      done++;
    } catch (e) {
      process.stdout.write(` ❌ ${e.message.slice(0, 60)}\n`);
      fail++;
    }
  }

  console.log(`  📊 ${title}: +${done} vidara, ❌${fail} gagal`);
  return { done, fail };
}

async function ensureFlareSolverr() {
  const http = require('http');
  try {
    await new Promise((resolve, reject) => {
      const req = http.get('http://127.0.0.1:8191/', res => { res.resume(); resolve(); });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  } catch {
    console.log('  ⚠️  FlareSolverr mati, restart...');
    const { execSync } = require('child_process');
    try {
      execSync('bash scraper/start-flaresolverr.sh &', { stdio: 'ignore', cwd: __dirname });
    } catch {
      try { execSync('docker restart flaresolverr', { stdio: 'ignore' }); } catch {}
    }
    await new Promise(r => setTimeout(r, 8000));
    console.log('  ✅ FlareSolverr di-restart');
  }
}

async function main() {
  if (!VIDARA_KEY) {
    console.error('❌ VIDARA_API key tidak ditemukan. Set di Replit Secrets atau .env');
    process.exit(1);
  }
  console.log(`🔑 VIDARA_API: ${VIDARA_KEY.slice(0, 8)}...`);
  await ensureFlareSolverr();
  const session = await createSession();
  console.log(`🔑 FlareSolverr session: ${session?.slice(0, 8) || 'none (tanpa session)'}`);

  const gtrack = loadGlobal();
  const all = Object.entries(gtrack).filter(([k, v]) => v.uploadedEpisodes > 0);
  console.log(`📋 ${all.length} dramas dengan upload Telegram`);

  let totalDone = 0, totalFail = 0;
  for (let i = 0; i < all.length; i++) {
    const [key, info] = all[i];
    if (info.hasVidara) {
      if (i < 5 || all.length - i <= 3) console.log(`  ⏭️  ${info.title}: sudah`);
      continue;
    }
    process.stdout.write(`\n[${i + 1}/${all.length}] `);
    const r = await processDrama(key, info, session);
    if (r) { totalDone += r.done; totalFail += r.fail; }
  }

  console.log(`\n✅ Selesai! +${totalDone} Vidara, ❌${totalFail} gagal`);
  await destroySession(session);
}

module.exports = {
  readEnv, vidaraCall, getFolderList, createFolder, moveToFolder, renameVideo,
  uploadUrlToVidara, getUploadServer, uploadFileViaCurl, extractFilecode,
  waitForEncoding, ensureFolder, vidaraFolderName, setDownloadsDir,
  loadGlobal, saveGlobal, loadPerDrama, savePerDrama, sanitizeDir,
  VIDARA_KEY, VIDARA_DOMAIN, VIDARA_API_BASE,
  VIDARA_UPLOAD_TIMEOUT_MS,
};
Object.defineProperty(module.exports, 'DOWNLOADS', { get: () => DOWNLOADS, enumerable: true });
Object.defineProperty(module.exports, 'GLOBAL_TRACK', { get: () => GLOBAL_TRACK, enumerable: true });

if (require.main === module) {
  main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
}
