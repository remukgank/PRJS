#!/usr/bin/env node
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}
try { require('dotenv').config(); } catch {}

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TelegramBotLib = require('node-telegram-bot-api');
const TelegramBot = TelegramBotLib.default || TelegramBotLib;
const { pool, initDatabase, savePartFileId, getSetting } = require('./db');
const { getVideoUrl, getAllEpisodes } = require('./index');
const { createSession, destroySession } = require('./dramafren');
const { downloadStream, mergeVideos, getVideoInfo, cleanupFiles, tempPath, fileSizeMb } = require('./downloader');

const CHANNEL_ID = process.env.CHANNEL_ID || '';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const LOCAL_API_PORT = process.env.TELEGRAM_API_PORT || '9091';
const CLOUD_LIMIT_MB = 49;

const OUTPUT_DIR = path.join(__dirname, 'downloads');
const MERGE_CHUNK_SIZE = 10;
const MIN_LAST_CHUNK = 6;
const DELAY_BETWEEN_EPS_MS = 0;
const DELAY_BETWEEN_DRAMAS_MS = 0;
// Cache detail-check: seberapa sering drama di-re-check jumlah episode-nya.
// 7 hari = safety net; detector utama growth = list dari sync-check (Lokal > Neon).
const DETAIL_CHECK_CACHE_MS = 7 * 24 * 3600 * 1000;
const CONCURRENCY = 15;
const LOG_INTERVAL_MS = 5000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Queue buat serialize request FlareSolverr (gak kuat paralel)
let fsQueue = Promise.resolve();
function enqueueFs(fn) {
  const run = fsQueue.then(fn, fn);
  fsQueue = run.catch(() => {});
  return run;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function sanitizeDir(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').slice(0, 100);
}

function parseDramaUrl(text) {
  const m = text.match(/https?:\/\/([^.\s]+)\.dramafren\.org[^\s]*/i);
  if (!m) return null;
  try {
    const url = new URL(m[0]);
    return {
      subdomain: m[1].toLowerCase(),
      page: url.searchParams.get('page') || 'watch',
      id: url.searchParams.get('id') || '',
      slug: url.searchParams.get('slug') || '',
      ep: Number(url.searchParams.get('ep') || 1),
      sv: Number(url.searchParams.get('sv') || 1),
      lang: url.searchParams.get('lang') || 'id',
    };
  } catch { return null; }
}

function dramaSourceUrl(params) {
  return `https://${params.subdomain}.dramafren.org/index.php?page=detail&id=${params.id}&lang=${params.lang}`;
}

function extractUrls(text) {
  const urls = [];
  const re = /https?:\/\/[^\s"'>)]+/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const u = m[0].replace(/[.,;!?]+$/, '');
    if (parseDramaUrl(u)) urls.push(u);
  }
  return [...new Set(urls)];
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function buildChunks(items, size, minLast = 6) {
  if (!items.length) return [];
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  if (chunks.length > 1 && chunks[chunks.length - 1].length < minLast) {
    const last = chunks.pop();
    chunks[chunks.length - 1] = [...chunks[chunks.length - 1], ...last];
  }
  return chunks;
}

// ─── Telegram upload ────────────────────────────────────────────────────────────

const bot = new TelegramBot(TOKEN, { polling: false });

function tgApi(method, payload) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const data = JSON.stringify(payload);
    const url = `http://127.0.0.1:${LOCAL_API_PORT}/bot${TOKEN}/${method}`;
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.ok) resolve(json.result);
          else reject(new Error(json.description || `${method} failed`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function ensureLocalApi() {
  const http = require('http');
  try {
    await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${LOCAL_API_PORT}/`, res => { res.resume(); resolve(); });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  } catch {
    console.log('  ⚠️  Local API mati, restart...');
    require('child_process').execFileSync('bash', [path.join(__dirname, 'start-local-api.sh')], { stdio: 'ignore', timeout: 15000 });
    await new Promise(r => setTimeout(r, 8000));
    console.log('  ✅ Local API di-restart');
  }
}

async function sendVideoToChannel(chatId, filePath, opts = {}) {
  const { caption, supports_streaming, duration, width, height } = opts;
  const sizeMb = fileSizeMb(filePath);

  if (sizeMb <= CLOUD_LIMIT_MB) {
    return bot.sendVideo(chatId, filePath, {
      caption, parse_mode: 'HTML',
      supports_streaming: supports_streaming ?? true,
      ...(duration && { duration }),
      ...(width && { width }),
      ...(height && { height }),
    });
  }

  await ensureLocalApi();
  return tgApi('sendVideo', {
    chat_id: chatId,
    video: `file://${filePath}`,
    caption, parse_mode: 'HTML',
    supports_streaming: supports_streaming ?? true,
    ...(duration && { duration }),
    ...(width && { width }),
    ...(height && { height }),
  });
}

async function sendPhotoToChannel(chatId, photoPath, caption) {
  const sizeMb = fileSizeMb(photoPath);
  if (sizeMb <= CLOUD_LIMIT_MB) {
    return bot.sendPhoto(chatId, photoPath, { caption, parse_mode: 'HTML' });
  }
  await ensureLocalApi();
  return tgApi('sendPhoto', {
    chat_id: chatId,
    photo: `file://${photoPath}`,
    caption, parse_mode: 'HTML',
  });
}

function checkTelegram() {
  return !!TOKEN;
}

// ─── Readline prompts ─────────────────────────────────────────────────────────

function autoDetectFiles() {
  const files = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.md'))
    .filter(f => extractUrls(fs.readFileSync(path.join(__dirname, f), 'utf-8')).length > 0);
  return files;
}

// ─── CLI mode (args) ──────────────────────────────────────────────────────────

function showHelp() {
  console.log(`Usage: node batch-download.js [urls-file] [options]

Without arguments: auto-detect semua file .md di folder ini

Options:
  --merge         Merge episodes in chunks (default)
  --per-ep        Download each episode individually
  --merge-size N  Chunk size (default ${MERGE_CHUNK_SIZE})
  --delay N       Delay between episodes in ms (default ${DELAY_BETWEEN_EPS_MS})
  --drama-delay N Delay between dramas in ms (default ${DELAY_BETWEEN_DRAMAS_MS})
  --output DIR    Output directory (default ${OUTPUT_DIR})
  --no-upload     Jangan upload ke Telegram (skip channel)
  -j, --jobs N    Concurrent downloads (default ${CONCURRENCY})
  --refresh       Force detail-check semua drama (skip cache 24 jam)
  --help, -h      Show this help

urls-file: path to .md or .txt file with drama URLs

File format: .md or .txt — URL akan diekstrak otomatis`);
}

function parseArgs() {
  const args = process.argv.slice(2);

  if (!args.length) return null; // interactive mode
  if (args.includes('--help') || args.includes('-h')) { showHelp(); process.exit(0); }

  const result = { urlFile: null, mode: 'merge', chunkSize: MERGE_CHUNK_SIZE, epDelay: DELAY_BETWEEN_EPS_MS, dramaDelay: DELAY_BETWEEN_DRAMAS_MS, outputDir: OUTPUT_DIR, channelId: CHANNEL_ID, concurrency: CONCURRENCY, refresh: false };

  // Skip leading flags untuk cari urlFile
  let argIdx = 0;
  while (argIdx < args.length && args[argIdx].startsWith('-')) {
    const flag = args[argIdx];
    if (flag === '--merge-size' || flag === '--delay' || flag === '--drama-delay' || flag === '--output' || flag === '--jobs' || flag === '-j') {
      argIdx += 2;
    } else {
      argIdx++;
    }
  }
  if (argIdx < args.length) result.urlFile = args[argIdx];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--per-ep': result.mode = 'per_ep'; break;
      case '--merge': result.mode = 'merge'; break;
      case '--merge-size': result.chunkSize = Number(args[++i]) || MERGE_CHUNK_SIZE; break;
      case '--delay': result.epDelay = Number(args[++i]) || DELAY_BETWEEN_EPS_MS; break;
      case '--drama-delay': result.dramaDelay = Number(args[++i]) || DELAY_BETWEEN_DRAMAS_MS; break;
      case '--output': result.outputDir = path.resolve(args[++i]); break;
      case '--no-upload': result.channelId = ''; break;
      case '--jobs': case '-j': result.concurrency = Math.max(1, Number(args[++i]) || CONCURRENCY); break;
      case '--refresh': result.refresh = true; break;
    }
  }

  return result;
}

// ─── Core batch logic ─────────────────────────────────────────────────────────

async function processDrama(url, index, total, mode, chunkSize, epDelay, outputDir, channelId, concurrency, refresh) {
  const params = parseDramaUrl(url);
  if (!params || !params.id) {
    console.log(`  ⚠️  URL tidak valid, dilewati`);
    return { title: 'unknown', total: 0, done: 0, fail: 0, size: 0, uploaded: 0, uploadFail: 0 };
  }

  // Global track — skip kalo udah selesai sebelumnya (via DB)
  let mediaSlug = `${params.subdomain}:${params.id}`;

  async function loadUploadedParts() {
    try {
      const r = await pool.query('SELECT part FROM media_parts WHERE media_slug = $1', [mediaSlug]);
      return r.rows.map(x => x.part);
    } catch { return []; }
  }

  async function markPartUploaded(part) {
    try {
      await pool.query(
        'INSERT INTO media_parts (media_slug, part) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [mediaSlug, part]
      );
    } catch {}
  }

  async function upsertMedia(nama, totalEps, epMin, sourceUrl) {
    try {
      await pool.query(
        `INSERT INTO media (slug, nama, total_eps, ep_min, source_url, detail_checked_at, created_by) VALUES ($1, $2, $3, $4, $5, NOW(), 'scraper')
         ON CONFLICT (slug) DO UPDATE SET
           nama = $2,
           total_eps = GREATEST(COALESCE(media.total_eps, 0), COALESCE($3, 0)),
           ep_min = LEAST(COALESCE(media.ep_min, 1), COALESCE($4, 1)),
           source_url = COALESCE(media.source_url, $5)`,
        [mediaSlug, nama, totalEps ?? null, epMin ?? 1, sourceUrl ?? null]
      );
    } catch {}
  }

  // Cek DB — skip kalo udah komplit (cek gap dari ep_min, bukan cuma jumlah)
  // Detail-check di-cache 24 jam via detail_checked_at; cache fresh = gak perlu fetch ulang
  try {
    const row = await pool.query(
      `SELECT total_eps, COALESCE(ep_min, 1) AS ep_min, detail_checked_at FROM media WHERE slug = $1`,
      [mediaSlug]
    );
    if (row.rows.length > 0 && row.rows[0].total_eps !== null) {
      const { total_eps, ep_min, detail_checked_at } = row.rows[0];
      const cacheFresh = detail_checked_at &&
        (Date.now() - new Date(detail_checked_at).getTime()) < DETAIL_CHECK_CACHE_MS;
      if (cacheFresh && !refresh) {
        const parts = await pool.query(
          'SELECT COUNT(*)::int AS cnt FROM media_parts WHERE media_slug = $1 AND part BETWEEN $2 AND $3',
          [mediaSlug, ep_min, ep_min + total_eps - 1]
        );
        if (parts.rows[0].cnt === total_eps) {
          console.log(`  ⏭️  ${params.subdomain}:${params.id} — udah lengkap di DB, skip`);
          return { title: 'cached', total: 0, done: 0, fail: 0, size: 0, uploaded: 0, uploadFail: 0 };
        }
      }
    }
  } catch {}

  // Cek FlareSolverr, restart nek mati
  try {
    const http = require('http');
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
    await sleep(8000);
    console.log('  ✅ FlareSolverr di-restart');
  }

  console.log(`\n📺 [${index + 1}/${total}] ${params.subdomain} — scraping...`);
  let episodes, meta, lastErr, session;
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await getAllEpisodes(params.subdomain, params.id, params.slug, params.lang, session);
      episodes = result.episodes;
      meta = result.meta;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        const delay = attempt * 10000;
        console.log(`  ⚠️  Percobaan ${attempt}/3 gagal: ${err.message.slice(0, 80)} — coba lagi ${delay / 1000} detik...`);
        await sleep(delay);
      }
    }
  }
  if (!episodes) {
    console.log(`  ❌ Gagal scrape setelah 3 percobaan: ${lastErr.message.slice(0, 100)}`);
    return { title: params.subdomain, total: 0, done: 0, fail: 0, size: 0, uploaded: 0, uploadFail: 0 };
  }

  if (!episodes.length) {
    console.log(`  ⚠️  Tidak ada episode`);
    return { title: meta?.title || params.subdomain, total: 0, done: 0, fail: 0, size: 0, uploaded: 0, uploadFail: 0 };
  }

  // Detail fetch sukses → tandai sudah dicek (cache detail_checked_at, sekali per drama)
  try {
    await pool.query('UPDATE media SET detail_checked_at = NOW() WHERE slug = $1', [mediaSlug]);
  } catch {}

  // Filter judul generik sisa CF (NetShort Player / netshort) — skip drama agar tidak bikin folder ngaco
  if (!meta?.title || (/player/i.test(meta.title) && meta.title.length < 30)) {
    const bad = meta?.title || 'null';
    console.log(`  ⏭️  ${params.subdomain}:${params.id} — judul generik "${bad}" — skip`);
    try { await pool.query('UPDATE media SET detail_checked_at = NOW() WHERE slug = $1', [mediaSlug]); } catch {}
    return { title: bad, total: 0, done: 0, fail: 0, size: 0, uploaded: 0, uploadFail: 0 };
  }
  const title = meta.title;
  const safeTitle = sanitizeDir(title);
  const subDir = path.join(outputDir, params.subdomain, safeTitle);

  // Cek DB — skip kalo semua episode udah pernah diupload (jangan bikin folder dulu)
  const existingParts = await loadUploadedParts();
  const allDone = episodes.every(ep => existingParts.includes(ep.ep));
  if (allDone) {
    await upsertMedia(title, episodes.length, episodes[0].ep, dramaSourceUrl(params));
    console.log(`  ⏭️  ${title} — ${existingParts.length}/${episodes.length} eps udah di DB, skip`);
    return { title, total: episodes.length, done: episodes.length, fail: 0, size: 0, uploaded: existingParts.length, uploadFail: 0 };
  }
  fs.mkdirSync(subDir, { recursive: true });

  // Drama beneran mau di-scrape → baru buat session (cuma kepake buat ep watch,
  // bukan detail). Drama lengkap gak perlu session.
  session = await createSession();
  if (session) console.log(`  🔑 FlareSolverr session: ${session.slice(0, 8)}...`);

  const epFirst = episodes[0].ep;
  const epLast = episodes[episodes.length - 1].ep;
  console.log(`  🎬 ${title}`);
  console.log(`  🎞 ${episodes.length} episode (Ep ${epFirst}–${epLast})`);
  console.log(`  📁 ${subDir}`);

  // Reload parts dari DB
  const uploadedParts = await loadUploadedParts();

  async function sendDramaInfo() {
    if (!channelId) return;
    const synopsis = meta?.synopsis ? escHtml(meta.synopsis.trim()) : '';
    const caption = `<b>${escHtml(title)}</b>\n${synopsis ? synopsis + '\n' : ''}\n🎞 ${episodes.length} eps`;

    if (meta?.poster) {
      let posterPath;
      try {
        const ext = meta.poster.match(/\.(jpe?g|png|webp|gif)(?:[@?#]|$)/i)?.[1]?.toLowerCase() || 'jpg';
        posterPath = tempPath(`poster_${Date.now()}.${ext}`);
        const resp = await axios({ url: meta.poster, responseType: 'stream', timeout: 15000 });
        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(posterPath);
          resp.data.pipe(ws);
          ws.on('finish', resolve);
          ws.on('error', reject);
        });
        await sendPhotoToChannel(channelId, posterPath, caption);
      } catch {
        await bot.sendMessage(channelId, caption, { parse_mode: 'HTML' });
      } finally {
        cleanupFiles(posterPath);
      }
    } else {
      await bot.sendMessage(channelId, caption, { parse_mode: 'HTML' });
    }
  }

  let done = 0, fail = 0, totalBytes = 0, uploaded = 0, uploadFail = 0;
  let progressTimer;

  let lastProgressLog = 0;
  function printProgress() {
    const pct = episodes.length ? ((done + fail) / episodes.length * 100).toFixed(1) : 0;
    const barLen = 30;
    const filled = Math.floor((done + fail) / episodes.length * barLen);
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
    const sizeStr = totalBytes ? formatBytes(totalBytes) : '';
    const upStr = channelId ? ` 📤${uploaded}` : '';
    const line = `  ${bar} ${pct}% | ✅ ${done} ❌ ${fail} 📦 ${sizeStr}${upStr}`;
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${line}`);
    } else {
      // pm2 / non-TTY: throttle biar tidak spam log tiap 5 detik
      const now = Date.now();
      if (now - lastProgressLog > 30000) {
        lastProgressLog = now;
        console.log(line);
      }
    }
  }

  async function uploadFile(filePath, label, trackKey) {
    if (!channelId || !fs.existsSync(filePath)) return;
    if (trackKey) {
      const epInt = parseInt(trackKey, 10);
      if (!isNaN(epInt) && uploadedParts.includes(epInt)) {
        done++;
        if (fs.existsSync(filePath)) totalBytes += fs.statSync(filePath).size;
        cleanupFiles(filePath);
        return;
      }
    }
    const sizeMb = fileSizeMb(filePath);
    if (sizeMb > 2000) {
      console.log(`\n  ⚠️  ${label}: ${sizeMb.toFixed(1)} MB > 2GB limit — skip upload`);
      uploadFail++;
      return;
    }

    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (attempt > 1) await ensureLocalApi();
        const info = await getVideoInfo(filePath).catch(() => ({}));
        // label = "{title} — Ep 01" / "{title} — Part N (...)" → ambil bagian setelah " — "
        const epPart = label.includes(' — ') ? label.split(' — ').slice(1).join(' — ') : label;
        const cleanProvider = params.subdomain.replace(/^reelfren_/, '');
        const sent = await sendVideoToChannel(channelId, filePath, {
          caption: [
            `➧ Judul :- <b>${title}</b>`,
            `➧ Episode/Part :- <b>${epPart}</b>`,
            `➧ Provider :- <tg-spoiler>${cleanProvider}</tg-spoiler>`,
          ].join('\n'),
          supports_streaming: true,
          ...(info.duration && { duration: info.duration }),
          ...(info.width && { width: info.width }),
          ...(info.height && { height: info.height }),
        });
        uploaded++;
        // Simpan file_id ke library jika libsimpan ON
        if (sent?.video?.file_id && (await getSetting('libsimpan')) === 'on') {
          let partNum = parseInt(trackKey, 10);
          if (trackKey && trackKey.startsWith('p')) partNum = parseInt(trackKey.slice(1), 10);
          if (partNum) await savePartFileId(mediaSlug, partNum, sent.video.file_id, Math.round(sizeMb * 1024 * 1024), `${epPart}.mp4`);
        }
        if (trackKey) {
          const epInt = parseInt(trackKey, 10);
          if (!isNaN(epInt)) {
            await upsertMedia(label.replace(/ —.*$/, ''), episodes.length, undefined, dramaSourceUrl(params));
            await markPartUploaded(epInt);
            uploadedParts.push(epInt);
          }
        }
        cleanupFiles(filePath);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < 3) {
          const wait = attempt * 5000;
          console.log(`\n  ⚠️  ${label}: percobaan ${attempt}/3 — ${err.message.slice(0, 50)} — coba lagi ${wait / 1000}s`);
          await sleep(wait);
        }
      }
    }

    console.log(`\n  ⚠️  ${label}: gagal upload — ${lastErr.message.slice(0, 60)}`);
    uploadFail++;
  }

  await sendDramaInfo();

  if (mode === 'per_ep') {
    progressTimer = setInterval(printProgress, LOG_INTERVAL_MS);

    let consecutiveTimeouts = 0;
    const resolveFailed = [];

    const rotateSessionIfStale = async () => {
      if (consecutiveTimeouts >= 2) {
        console.log(`  ⚠️  ${consecutiveTimeouts}x timeout beruntun — rotasi session FlareSolverr`);
        await destroySession(session);
        session = null;
        await sleep(2000);
        session = await createSession();
        if (session) console.log(`  🔑 Session baru: ${session.slice(0, 8)}...`);
        consecutiveTimeouts = 0;
      }
    };

    for (let i = 0; i < episodes.length; i += concurrency) {
      const batch = episodes.slice(i, i + concurrency);

      // Phase 1: sequential resolve (FlareSolverr — 1 at a time)
      const resolved = [];
      for (const episode of batch) {
        const { ep, urlEp } = episode;
        const epStr = String(ep).padStart(episodes.length >= 100 ? 3 : 2, '0');
        const outPath = path.join(subDir, `Ep ${epStr}.mp4`);
        const label = `${title} — Ep ${epStr}`;

        if (uploadedParts.includes(ep)) {
          resolved.push({ type: 'skip', epStr, outPath, label });
          continue;
        }

        try {
          const result = await getVideoUrl(params.subdomain, params.id, params.slug, urlEp, 1, params.lang, session);
          if (!result?.videoUrl) {
            if (result?.timeout) {
              consecutiveTimeouts++;
              await rotateSessionIfStale();
              resolveFailed.push({ ep, epStr, outPath, label, urlEp });
            } else {
              consecutiveTimeouts = 0;
            }
            resolved.push({ type: 'fail' });
            continue;
          }
          consecutiveTimeouts = 0;
          resolved.push({ type: 'ok', epStr, outPath, label, videoUrl: result.videoUrl, subtitleUrl: result.subtitleUrl });
        } catch {
          consecutiveTimeouts = 0;
          resolved.push({ type: 'fail' });
        }
      }

      // Phase 2: parallel download (ffmpeg)
      const dlResults = await Promise.all(resolved.map(async (r) => {
        if (r.type !== 'ok') return r;
        try {
          await downloadStream(r.videoUrl, r.outPath, null, r.subtitleUrl);
          return r;
        } catch {
          return { type: 'fail' };
        }
      }));

      // Phase 3: sequential upload
      for (const r of dlResults) {
        if (r.type === 'skip') { done++; continue; }
        if (r.type === 'fail') { fail++; continue; }
        done++;
        if (fs.existsSync(r.outPath)) totalBytes += fs.statSync(r.outPath).size;
        await uploadFile(r.outPath, r.label, r.epStr);
      }

      if (i + concurrency < episodes.length && epDelay) await sleep(epDelay);
    }

    // Retry sekali episode yang gagal resolve (session basi) — session sudah dirotasi
    if (resolveFailed.length) {
      console.log(`  🔁 Retry ${resolveFailed.length} ep yang gagal resolve (session baru)...`);
      for (const f of resolveFailed) {
        if (uploadedParts.includes(f.ep)) continue;
        try {
          const result = await getVideoUrl(params.subdomain, params.id, f.urlEp, 1, params.lang, session);
          if (!result?.videoUrl) continue;
          await downloadStream(result.videoUrl, f.outPath, null, result.subtitleUrl);
          done++;
          fail--;
          if (fs.existsSync(f.outPath)) totalBytes += fs.statSync(f.outPath).size;
          await uploadFile(f.outPath, f.label, f.epStr);
        } catch {
          // tetap gagal — biarkan fail count
        }
      }
    }
  } else {
    const chunks = buildChunks(episodes, chunkSize, MIN_LAST_CHUNK);
    progressTimer = setInterval(printProgress, LOG_INTERVAL_MS);

    let dramaAborted = false;
    let abortedPart = null;
    const MAX_CHUNK_RETRY = 3;
    let consecutiveTimeouts = 0;
    const rotateSessionIfStale = async () => {
      if (consecutiveTimeouts >= 2) {
        console.log(`  ⚠️  ${consecutiveTimeouts}x timeout beruntun — rotasi session FlareSolverr`);
        await destroySession(session);
        session = null;
        await sleep(2000);
        session = await createSession();
        if (session) console.log(`  🔑 Session baru: ${session.slice(0, 8)}...`);
        consecutiveTimeouts = 0;
      }
    };

    for (let ci = 0; ci < chunks.length; ci++) {
      if (dramaAborted) break;
      const chunk = chunks[ci];
      const epStart = chunk[0].ep;
      const epEnd = chunk[chunk.length - 1].ep;
      const epStrStart = String(epStart).padStart(3, '0');
      const epStrEnd = String(epEnd).padStart(3, '0');
      const mergedPath = path.join(subDir, `Part ${ci + 1} (Ep ${epStrStart}-${epStrEnd}).mp4`);
      const partKey = `p${ci + 1}`;

      // Skip if already uploaded (merge mode) — cek semua ep di chunk sudah di DB
      if (chunk.every(ep => uploadedParts.includes(ep.ep))) {
        done += chunk.length;
        continue;
      }

      if (fs.existsSync(mergedPath) && fs.statSync(mergedPath).size > 1024 * 1024) {
        await uploadFile(mergedPath, `${title} — Part ${ci + 1} (Ep ${epStrStart}-${epStrEnd})`, partKey);
        if (fs.existsSync(mergedPath)) {
          console.log(`\n  ❌ Part ${ci + 1} gagal upload — hentikan drama cegah rongga`);
          fail += chunk.length;
          dramaAborted = true;
          abortedPart = ci + 1;
          break;
        }
        done += chunk.length;
        continue;
      }

      // ——— Blocking retry per chunk: wajib lengkap baru lanjut ci+1 ———
      let chunkSuccess = false;
      for (let attempt = 1; attempt <= MAX_CHUNK_RETRY && !chunkSuccess; attempt++) {
        if (attempt > 1) {
          console.log(`\n  🔁 Part ${ci + 1}: percobaan ${attempt}/${MAX_CHUNK_RETRY}...`);
          await sleep(5000);
        }

        // Kumpulkan file yang sudah ada dari attempt sebelumnya (hemat disk, tidak download ulang)
        const existingOnDisk = [];
        for (const ep of chunk) {
          const epFile = tempPath(`batch_${params.subdomain}_${params.id}_ep${ep}.mp4`);
          if (fs.existsSync(epFile) && fs.statSync(epFile).size > 10240) {
            existingOnDisk.push(epFile);
          }
        }
        const needEps = chunk.filter(ep => !existingOnDisk.some(p => p.includes(`_ep${ep.ep}.mp4`)));
        const downloaded = [...existingOnDisk];
        const failedInChunk = [];

        // Download yang belum ada (batched, concurrency)
        for (let i = 0; i < needEps.length; i += concurrency) {
          const batch = needEps.slice(i, i + concurrency);
          const batchResults = await Promise.all(batch.map(async (episode) => {
            const { ep, urlEp } = episode;
            const epFile = tempPath(`batch_${params.subdomain}_${params.id}_ep${ep}.mp4`);
            try {
              const result = await enqueueFs(() => getVideoUrl(params.subdomain, params.id, params.slug, urlEp, 1, params.lang, session));
              if (!result?.videoUrl) {
                if (result?.timeout) consecutiveTimeouts++;
                else consecutiveTimeouts = 0;
                cleanupFiles(epFile);
                return { type: 'fail', ep, urlEp, timeout: !!result?.timeout };
              }
              consecutiveTimeouts = 0;
              await downloadStream(result.videoUrl, epFile, null, result.subtitleUrl);
              return { type: 'ok', path: epFile };
            } catch (err) {
              consecutiveTimeouts = 0;
              cleanupFiles(epFile);
              return { type: 'fail', ep, urlEp };
            }
          }));
          // Rotasi session jika 2x timeout beruntun (FlareSolverr 60s)
          if (batchResults.some(r => r.timeout)) await rotateSessionIfStale();
          for (const r of batchResults) {
            if (r.type === 'ok') downloaded.push(r.path);
            else failedInChunk.push({ ep: r.ep, urlEp: r.urlEp });
          }
          if (i + concurrency < needEps.length && epDelay) await sleep(epDelay);
        }

        // Jika masih ada gagal, jangan merge — akan retry attempt berikutnya
        if (failedInChunk.length > 0) {
          console.log(`\n  ⚠️  Part ${ci + 1}: ${failedInChunk.length} ep gagal (attempt ${attempt}/${MAX_CHUNK_RETRY}) — ${downloaded.length}/${chunk.length} terkumpul`);
          if (attempt === MAX_CHUNK_RETRY) {
            console.log(`  ❌ Part ${ci + 1} gagal setelah ${MAX_CHUNK_RETRY}x — hentikan drama cegah rongga (Ep 43 contoh akan stop di Part 5)`);
            const toClean = [];
            for (const ep of chunk) {
              const epFile = tempPath(`batch_${params.subdomain}_${params.id}_ep${ep}.mp4`);
              if (fs.existsSync(epFile)) toClean.push(epFile);
            }
            cleanupFiles(...toClean);
            if (fs.existsSync(mergedPath)) cleanupFiles(mergedPath);
            fail += chunk.length;
            dramaAborted = true;
            abortedPart = ci + 1;
          }
          continue; // retry loop
        }

        // Semua episode lengkap — guard anti-rongga: wajib 10/10 atau 14/14
        if (downloaded.length !== chunk.length) {
          console.log(`\n  ⚠️  Part ${ci + 1}: ${chunk.length - downloaded.length} ep hilang — retry`);
          continue;
        }

        // Merge + upload — blocking
        try {
          if (downloaded.length === 1) {
            fs.renameSync(downloaded[0], mergedPath);
          } else {
            await mergeVideos(downloaded, mergedPath, { title: `Part ${ci + 1}` });
            cleanupFiles(...downloaded);
          }
          if (fs.existsSync(mergedPath)) totalBytes += fs.statSync(mergedPath).size;
          const partLabel = `${title} — Part ${ci + 1} (Ep ${epStrStart}-${epStrEnd})`;
          await uploadFile(mergedPath, partLabel, partKey);
          if (!fs.existsSync(mergedPath)) {
            await upsertMedia(title, episodes.length, episodes[0].ep, dramaSourceUrl(params));
            for (const ep of chunk) await markPartUploaded(ep.ep);
            done += chunk.length;
            chunkSuccess = true;
          } else {
            console.log(`\n  ⚠️  Part ${ci + 1}: upload gagal — retry`);
            // merged file masih ada, attempt berikutnya akan coba upload lagi
            if (attempt === MAX_CHUNK_RETRY) {
              console.log(`  ❌ Part ${ci + 1} upload gagal ${MAX_CHUNK_RETRY}x — hentikan drama`);
              cleanupFiles(mergedPath);
              fail += chunk.length;
              dramaAborted = true;
              abortedPart = ci + 1;
            }
          }
        } catch (err) {
          cleanupFiles(...downloaded.filter(p => fs.existsSync(p) && p !== mergedPath));
          if (fs.existsSync(mergedPath)) cleanupFiles(mergedPath);
          console.log(`\n  ⚠️  Part ${ci + 1}: merge gagal — ${err.message.slice(0,60)} — retry`);
          if (attempt === MAX_CHUNK_RETRY) {
            fail += chunk.length;
            dramaAborted = true;
            abortedPart = ci + 1;
          }
        }
      }
      if (dramaAborted) break;
    }

    if (dramaAborted) {
      clearInterval(progressTimer);
      printProgress();
      process.stdout.write('\n');
      await upsertMedia(title, episodes.length, episodes[0]?.ep ?? 1, dramaSourceUrl(params));
      try { if (fs.existsSync(subDir) && fs.readdirSync(subDir).length === 0) fs.rmdirSync(subDir); } catch {}
      console.log(`  ⏹️  Drama dihentikan di Part ${abortedPart} — ada rongga, akan retry drama dari awal di runBatch`);
      return { title, total: episodes.length, done, fail, size: totalBytes, uploaded, uploadFail, aborted: true, abortedPart };
    }
  }

  clearInterval(progressTimer);
  printProgress();
  process.stdout.write('\n');

  // Simpan ke media table
  await upsertMedia(title, episodes.length, episodes[0]?.ep ?? 1, dramaSourceUrl(params));

  // Hapus folder kalo kosong
  try { if (fs.existsSync(subDir) && fs.readdirSync(subDir).length === 0) fs.rmdirSync(subDir); } catch {}

  const sizeStr = totalBytes ? ` (${formatBytes(totalBytes)})` : '';
  const upStr = channelId ? `, 📤${uploaded} terkirim` : '';
  console.log(`  ✅ ${done} selesai, ❌ ${fail} gagal${sizeStr}${upStr}`);
  return { title, total: episodes.length, done, fail, size: totalBytes, uploaded, uploadFail };
  } finally {
    await destroySession(session);
  }
}

async function runBatch(urls, mode, chunkSize, epDelay, dramaDelay, outputDir, channelId, concurrency, refresh) {
  fs.mkdirSync(outputDir, { recursive: true });
  await initDatabase();

  const t0 = Date.now();
  let totalDone = 0, totalFail = 0, totalEps = 0, totalBytes = 0, dramaDone = 0, dramaFail = 0;
  let totalUploaded = 0, totalUploadFail = 0;

  const MAX_DRAMA_RETRY = 3;
  for (let i = 0; i < urls.length; i++) {
    let result;
    let dramaAttempt = 0;
    let dramaSuccess = false;
    do {
      dramaAttempt++;
      if (dramaAttempt > 1) {
        console.log(`\n🔁 Retry drama [${i + 1}/${urls.length}] percobaan ${dramaAttempt}/${MAX_DRAMA_RETRY} — tuntaskan dulu cegah rongga...`);
        await sleep(8000);
      }
      result = await processDrama(urls[i], i, urls.length, mode, chunkSize, epDelay, outputDir, channelId, concurrency, refresh);
      // sukses = tidak abort dan fail==0 atau total==0 (skip/cache)
      if (!result.aborted && result.fail === 0) {
        dramaSuccess = true;
      } else if (result.total === 0 && result.fail === 0) {
        dramaSuccess = true; // skip/cache dianggap sukses
      } else {
        console.log(`  ⚠️  Drama ${result.title} belum tuntas (✅${result.done}/${result.total} ❌${result.fail})${result.aborted ? ` — abort di Part ${result.abortedPart}` : ''}`);
        if (dramaAttempt < MAX_DRAMA_RETRY) {
          console.log(`  ⏳ Akan ulang drama yang sama sebelum lanjut ke drama berikutnya...`);
        }
      }
    } while (!dramaSuccess && dramaAttempt < MAX_DRAMA_RETRY);

    totalEps += result.total;
    totalDone += result.done;
    totalFail += result.fail;
    totalBytes += result.size;
    totalUploaded += result.uploaded || 0;
    totalUploadFail += result.uploadFail || 0;
    if (dramaSuccess) dramaDone++;
    else {
      dramaFail++;
      if (!dramaSuccess && result.fail > 0) {
        console.log(`\n❌ Drama [${i + 1}/${urls.length}] gagal total setelah ${MAX_DRAMA_RETRY}x — hentikan batch cegah rongga antar drama`);
        console.log(`   Sisa ${urls.length - i - 1} drama tidak diproses. Jalankan ulang batch untuk resume.`);
        break;
      }
    }

    if (i < urls.length - 1 && dramaSuccess) {
      if (dramaDelay) console.log(`  ⏳ Tunggu ${dramaDelay}ms sebelum drama berikutnya...`);
      if (dramaDelay) await sleep(dramaDelay);
    }
  }

  const elapsed = Math.floor((Date.now() - t0) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  const upStr = channelId ? `\n📤 ${totalUploaded} terupload ke channel` : '';
  const upFailStr = totalUploadFail ? ` (❌ ${totalUploadFail} gagal upload)` : '';

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✅ Batch selesai!`);
  console.log(`📺 ${dramaDone}/${urls.length} drama`);
  console.log(`🎞 ${totalDone}/${totalEps} episode (❌ ${totalFail} gagal)`);
  console.log(`💾 ${formatBytes(totalBytes)}`);
  console.log(`⏱ ${mm}:${ss}`);
  console.log(`📁 ${outputDir}${upStr}${upFailStr}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}

// ─── Entry ────────────────────────────────────────────────────────────────────

(async () => {
  let urls = [];
  let config;

  config = parseArgs();

  // Auto-detect files kalo gak ada urlFile (termasuk kalo cuma flags kayak -j 5)
  if (!config || !config.urlFile) {
    if (!config) config = {};
    const files = autoDetectFiles();
    if (!files.length) {
      console.log('❌ Tidak ada file .md dengan URL drama di folder ini.');
      console.log('   Gunakan: node batch-download.js <file.md>');
      process.exit(1);
    }
    console.log(`📂 ${files.length} file terdeteksi, mengumpulkan URL...`);
    for (const f of files) {
      const u = extractUrls(fs.readFileSync(path.join(__dirname, f), 'utf-8'));
      urls.push(...u);
      console.log(`   ${f}: ${u.length} drama`);
    }
    config = { mode: 'merge', chunkSize: MERGE_CHUNK_SIZE, epDelay: DELAY_BETWEEN_EPS_MS, dramaDelay: DELAY_BETWEEN_DRAMAS_MS, outputDir: OUTPUT_DIR, channelId: CHANNEL_ID, concurrency: CONCURRENCY, ...config };
  } else {
    urls = extractUrls(fs.readFileSync(config.urlFile, 'utf-8'));
    if (!urls.length) {
      console.log('❌ Tidak ada URL drama ditemukan di file tersebut.');
      process.exit(1);
    }
  }

  if (config.channelId && !checkTelegram()) {
    console.log('⚠️  TELEGRAM_BOT_TOKEN tidak diset — upload ke Telegram dilewati.');
    config.channelId = '';
  }

  const channelInfo = config.channelId ? `\n📢 Channel: ${config.channelId}` : '';
  console.log(`\n📥 Batch Download
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📺 ${urls.length} drama URLs
📁 Output: ${config.outputDir}
📦 Mode: ${config.mode}${config.mode === 'merge' ? ` (${config.chunkSize} ep/chunk)` : ''}
⚡ Concurrency: ${config.concurrency}
⏱  Ep delay: ${config.epDelay}ms | Drama delay: ${config.dramaDelay}ms${channelInfo}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  await runBatch(urls, config.mode, config.chunkSize, config.epDelay, config.dramaDelay, config.outputDir, config.channelId, config.concurrency, config.refresh);
})();
