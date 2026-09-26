/**
 * Download HLS/MP4 stream dengan ffmpeg, support merge multi-episode.
 *
 * iOS compatibility: menggunakan yuv420p + SAR 1:1 agar video tidak gepeng.
 * Burn-in subtitle: re-encode + hardcode subtitle ke video (opsi burnSubtitle).
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

const { logger: appLogger, ffmpegLogger } = require('./logger');
const backpressure = require('./lib/backpressure'); // lapis 1+2 gate sebelum tiap download
const { assertLooksLikeVideo } = require('./services/vidaraService');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
// UA browser penuh (bukan "Mozilla/5.0" saja): CDN galak (farsunpteltd dkk)
// menolak request ffmpeg default/Lavf maupun UA terpotong -> 403.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const TMP_DIR = path.join(os.homedir(), 'workspace', 'downloads');

fs.mkdirSync(TMP_DIR, { recursive: true });

/**
 * Ambil info video via ffprobe (width, height, duration, codec).
 */
function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath,
    ];
    execFile('ffprobe', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const data = JSON.parse(stdout);
        const stream = data.streams?.[0] || {};
        const format = data.format || {};
        resolve({
          width: stream.width || 0,
          height: stream.height || 0,
          duration: Math.round(parseFloat(format.duration) || 0),
          codec: stream.codec_name || 'unknown',
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Download satu stream (m3u8 atau mp4) ke file mp4 lokal.
 * Skip jika file sudah ada dan valid (> 1MB).
 * -c copy tanpa re-encode supaya cepat.
 */
async function downloadStream(streamUrl, outPath, onLog, subtitleUrl, opts = {}) {
  const { burnSubtitle = false, subtitleStyle = 'FontSize=20' } = opts;
  const fileName = path.basename(outPath);

  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024 * 1024) {
    const valid = await getVideoInfo(outPath).then(() => true).catch(() => false);
    if (valid) {
      appLogger.info({ file: fileName }, 'Skip download — already exists');
      if (onLog) onLog('skip: sudah ada');
      return outPath;
    }
    appLogger.warn({ file: fileName }, 'File exists but corrupted — re-downloading');
    fs.unlinkSync(outPath);
  }

  // Lapis 1+2: pause bila folder kerja/antrian penuh atau disk kritis.
  await backpressure.checkBeforeDownload();

  let subtitlePath = null;
  if (subtitleUrl) {
    try {
      const parsed = new URL(subtitleUrl);
      const ext = path.extname(parsed.pathname).split('?')[0] || '.vtt';
      subtitlePath = outPath.replace(/\.mp4$/, ext);
      const resp = await axios.get(subtitleUrl, { responseType: 'arraybuffer', timeout: 15000 });
      fs.writeFileSync(subtitlePath, Buffer.from(resp.data));
      appLogger.info({ file: path.basename(subtitlePath) }, 'Subtitle downloaded');
    } catch (err) {
      appLogger.warn({ err: err.message, url: subtitleUrl }, 'Subtitle download failed, skipping');
      subtitlePath = null;
    }
  }

  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-headers', `User-Agent: ${BROWSER_UA}`,
      '-i', streamUrl,
    ];
    if (subtitlePath) {
      args.push('-i', subtitlePath);
    }
    if (burnSubtitle && subtitlePath) {
      // Burn-in: hardcode subtitle ke video (re-encode), buang track subtitle asli
      args.push(
        '-vf', `subtitles=${escapeFilterPath(subtitlePath)}:force_style='${subtitleStyle}'`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'copy',
        '-sn',
        '-movflags', '+faststart'
      );
    } else {
      args.push('-c', 'copy', '-c:s', 'mov_text', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart');
      if (subtitlePath) {
        args.push('-metadata:s:s:0', 'language=ind');
      }
    }
    args.push(outPath);

    const proc = execFile(FFMPEG, args, { maxBuffer: 100 * 1024 * 1024 });
    const fileName = path.basename(outPath);

    let stderr = '';
    let lastProgressLog = 0;
    proc.stderr.on('data', (d) => {
      stderr += d;
      const timeMatch = d.match(/time=(\d{2}):(\d{2}):(\d{2})/);
      if (timeMatch) {
        const now = Date.now();
        if (now - lastProgressLog > 5000) {
          lastProgressLog = now;
          const t = `${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3]}`;
          if (onLog) onLog(`progress: ${t}`);
        }
      }
    });

    proc.on('close', (code) => {
      cleanupFiles(subtitlePath);
      if (code === 0 && fs.existsSync(outPath)) {
        const sizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
        ffmpegLogger.info({ file: fileName, sizeMb, status: 'done' }, 'Download complete');
        resolve(outPath);
      } else {
        ffmpegLogger.error({ file: fileName, exitCode: code, stderr: stderr.slice(-500) }, 'Download failed');
        reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`));
      }
    });

    proc.on('error', (err) => {
      cleanupFiles(subtitlePath);
      ffmpegLogger.error({ file: fileName, err: err.message }, 'Download error');
      reject(err);
    });
  });
}

/**
 * Merge beberapa file mp4 menjadi satu (stream copy, tanpa re-encode).
 */
function mergeVideos(inputPaths, outPath, opts = {}, onLog) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024 * 1024) {
      appLogger.info({ file: path.basename(outPath) }, 'Skip merge — already exists');
      if (onLog) onLog('skip: sudah ada');
      return resolve(outPath);
    }

    const listFile = path.join(TMP_DIR, `concat_${Date.now()}.txt`);
    const content = inputPaths.map((p) => `file '${p}'`).join('\n');
    fs.writeFileSync(listFile, content);

    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      '-movflags', '+faststart',
    ];

    if (opts.title) {
      args.push('-metadata', `title=${opts.title}`);
    }

    args.push(outPath);

    const proc = execFile(FFMPEG, args, { maxBuffer: 100 * 1024 * 1024 });
    const mergeName = path.basename(outPath);

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('close', (code) => {
      fs.unlinkSync(listFile);
      if (code === 0 && fs.existsSync(outPath)) {
        const sizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
        ffmpegLogger.info({ file: mergeName, sizeMb, files: inputPaths.length, status: 'merged' }, 'Merge complete');
        resolve(outPath);
      } else {
        ffmpegLogger.error({ file: mergeName, exitCode: code, stderr: stderr.slice(-500) }, 'Merge failed');
        reject(new Error(`ffmpeg merge exit ${code}: ${stderr.slice(-300)}`));
      }
    });

    proc.on('error', (err) => {
      ffmpegLogger.error({ file: mergeName, err: err.message }, 'Merge error');
      reject(err);
    });
  });
}

/**
 * Hapus file temp, abaikan error.
 */
function aria2ctlPath(filePath) {
  return filePath + '.aria2';
}

function cleanupFiles(...files) {
  for (const f of files) {
    try {
      if (f) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
        const ctl = aria2ctlPath(f);
        if (fs.existsSync(ctl)) fs.unlinkSync(ctl);
      }
    } catch {}
  }
}

/**
 * Remux mkv/webm/mov → mp4 (ffmpeg -c copy -movflags +faststart), tanpa re-encode.
 * Cepat, lossless, langsung preview/streaming di Telegram.
 * Return path mp4 hasil; jika gagal/gagal container, kembalikan input asli.
 */
async function remuxToMp4(inputPath, onLog = null) {
  const ext = path.extname(inputPath || '').toLowerCase();
  if (ext === '.mp4') return inputPath; // sudah mp4 — skip
  const ob = FFMPEG;
  const outPath = tempPath(path.basename(inputPath).replace(/\.[^.]+$/, '') + '_remux.mp4');

  function runFfmpeg(args) {
    return new Promise((resolve) => {
      const proc = execFile(ob, args, { maxBuffer: 100 * 1024 * 1024 });
      proc.on('error', () => resolve({ ok: false }));
      proc.on('close', (code) => resolve({ ok: code === 0 && fs.existsSync(outPath) }));
    });
  }

  // Pass 1: stream copy (cepat)
  let r = await runFfmpeg(['-y', '-i', inputPath, '-c', 'copy', '-movflags', '+faststart', outPath]);
  if (r.ok) {
    cleanupFiles(inputPath);
    if (onLog) onLog('remux: mkv→mp4 done (copy)');
    return outPath;
  }
  // Pass 2: re-encode h264+aac (iOS/Safari compatible)
  cleanupFiles(outPath);
  if (onLog) onLog('remux: copy gagal, re-encode h264+aac...');
  r = await runFfmpeg(['-y', '-i', inputPath, '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outPath]);
  if (r.ok) {
    cleanupFiles(inputPath);
    if (onLog) onLog('remux: mkv→mp4 done (re-encode)');
    return outPath;
  }
  // Gagal total → biarkan asli
  cleanupFiles(outPath);
  return inputPath;
}

/**
 * Download file via aria2c (untuk GoFile dll).
 * Support multi-connection, resume, dan progress parsing.
 */
const ARIA2C_MIN_SPEED_BPS = 300 * 1024; // ~300 KB/s, sangat konservatif

function calcAria2cTimeout(fileSizeBytes) {
  const MIN_TIMEOUT = 3 * 60 * 1000;   // 3 menit (handshake + retry)
  const MAX_TIMEOUT = 20 * 60 * 1000;  // 20 menit (file besar di host lambat)
  if (!fileSizeBytes || fileSizeBytes <= 0) {
    return MAX_TIMEOUT; // ukuran unknown (API kadang 0) → waktu longgar
  }
  const needMs = (fileSizeBytes / ARIA2C_MIN_SPEED_BPS) * 1000;
  return Math.max(MIN_TIMEOUT, Math.min(needMs, MAX_TIMEOUT));
}

// ─── Watchdog download (stall + speed floor) ─────────────────────────────────
// Sumber progres = downloaded bytes dari readout aria2c ([#gid xMiB/0B ...]),
// bukan ukuran file: dengan --file-allocation=none + koneksi paralel, ukuran file
// bisa "loncat" penuh duluan (segmen terakhir ditulis lebih dulu) di host yang
// support Range, sehingga watch berbasis statSync akan salah-positif.
const ARIA2C_WATCHDOG_MS = 15000;               // interval cek progres
const ARIA2C_STALL_MIN_RUN_MS = 30000;          // abaikan stall sebelum 30s jalan
const ARIA2C_STALL_FREEZE_MS = 90000;           // nol pertumbuhan downloaded => stuck
const ARIA2C_SPEED_MIN_RUN_MS = 90000;          // evaluasi speed floor setelah 90s
const ARIA2C_SPEED_MIN_BYTES = 5 * 1024 * 1024; // minimal downloaded sebelum eval
const ARIA2C_SPEED_WINDOW_MS = 90000;           // jendela trailing rata-rata
const ARIA2C_SPEED_FLOOR_BPS = 70 * 1024;       // 70 KiB/s

function aria2SizeToBytes(numStr, unitStr) {
  const units = { '': 1, K: 1024, M: 1024 * 1024, G: 1024 ** 3, T: 1024 ** 4 };
  return Math.round(parseFloat(numStr) * (units[(unitStr || '').toUpperCase()] || 1));
}

function downloadWithAria2c(url, outPath, onLog, extraHeaders = {}, fileSizeOrOpts = {}) {
  // Arg ke-5: bisa opts object {fileSize, disableSpeedFloor} atau angka legacy fileSize.
  const opts = typeof fileSizeOrOpts === 'object' && fileSizeOrOpts !== null
    ? fileSizeOrOpts
    : { fileSize: fileSizeOrOpts };
  const fileSize = opts.fileSize;
  const disableSpeedFloor = opts.disableSpeedFloor === true;
  // Lapis 1+2 gate dulu (bungkus async-IIFE agar signature sync->Promise tetap).
  return (async () => {
    await backpressure.checkBeforeDownload();
    return new Promise((resolve, reject) => {
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024 * 1024) {
      appLogger.info({ file: path.basename(outPath) }, 'Skip download — already exists');
      if (onLog) onLog('skip: sudah ada');
      return resolve(outPath);
    }

    const args = [
      url,
      '-x4', '-s4',
      '--continue',
      '--retry-wait', '3',
      '--max-tries', '5',
      '--connect-timeout=15',
      '--timeout=30',
      '--summary-interval=10',
      '--console-log-level=notice',
      '--auto-file-renaming=false',
      '--allow-overwrite=true',
      '--file-allocation=none',
      '--dir', path.dirname(outPath),
      '--out', path.basename(outPath),
    ];

    for (const [key, val] of Object.entries(extraHeaders)) {
      args.push('--header', `${key}: ${val}`);
    }

    const fileName = path.basename(outPath);
    const proc = execFile('aria2c', args, { maxBuffer: 1024 * 1024 });
    const startAt = Date.now();

    let output = '';
    let lastProgressLog = 0;
    let downloaded = 0;       // bytes ter-download (monotonik, dari readout aria2c)
    let lastDownAt = startAt; // kapan downloaded terakhir bertambah
    let lastHeartbeatAt = startAt;
    let killReason = null;    // diisi timeout/watchdog → SIGTERM + reject sekali
    const downSamples = [];   // rolling {at, bytes} untuk rata-rata trailing 90s

    const timeoutMs = calcAria2cTimeout(fileSize);
    const timeout = setTimeout(() => {
      if (killReason) return; // jangan double-kill
      killReason = `Download timeout (${Math.round(timeoutMs / 1000)} detik)`;
      proc.kill('SIGTERM');
    }, timeoutMs);

    // Watchdog: deteksi stuck (nol progres) & speed floor (rata-rata trailing lambat).
    const watchdog = setInterval(() => {
      if (killReason) return;
      const now = Date.now();
      downSamples.push({ at: now, bytes: downloaded });
      while (downSamples.length > 1 && now - downSamples[0].at > ARIA2C_SPEED_WINDOW_MS) downSamples.shift();
      const runMs = now - startAt;

      // 1) Stall: nol pertumbuhan downloaded (selalu aktif, termasuk paid).
      if (runMs > ARIA2C_STALL_MIN_RUN_MS && now - lastDownAt > ARIA2C_STALL_FREEZE_MS) {
        killReason = `server stuck — nol progres ${Math.round(ARIA2C_STALL_FREEZE_MS / 1000)} detik (host mati/gantung)`;
        proc.kill('SIGTERM');
        return;
      }
      // 2) Speed floor: rata-rata trailing < 70 KiB/s (dimatikan utk paid).
      if (!disableSpeedFloor && runMs > ARIA2C_SPEED_MIN_RUN_MS && downloaded >= ARIA2C_SPEED_MIN_BYTES) {
        const oldest = downSamples[0];
        const windowMs = now - oldest.at;
        const grown = downloaded - oldest.bytes;
        if (windowMs >= ARIA2C_SPEED_WINDOW_MS * 0.75) {
          const speed = (grown / windowMs) * 1000;
          if (speed < ARIA2C_SPEED_FLOOR_BPS) {
            killReason = `server terlalu lambat (rata-rata ${Math.round(speed / 1024)} KiB/s < 70 KiB/s selama 90 detik)`;
            proc.kill('SIGTERM');
            return;
          }
        }
      }
      // 3) Heartbeat ringan supaya user tidak lihat-diam.
      if (onLog && downloaded > 0 && now - lastHeartbeatAt >= 60000) {
        lastHeartbeatAt = now;
        onLog(`masih download, ${(downloaded / 1048576).toFixed(1)} MB terkumpul`);
      }
    }, ARIA2C_WATCHDOG_MS);

    function updateDownloaded(bytes) {
      if (bytes > downloaded) {
        downloaded = bytes;
        lastDownAt = Date.now();
      }
    }

    function onData(d) {
      output += d;
      const now = Date.now();
      const pctMatch = d.match(/\((\d+)%\)/);
      if (pctMatch) {
        if (now - lastProgressLog > 3000) {
          lastProgressLog = now;
          if (onLog) onLog(`progress: ${pctMatch[1]}%`);
        }
      }
      // Downloaded bytes dari readout [#gid <x>MiB/<total> ...] (prefix/i opsional).
      const dlProgRe = /\[#[0-9a-f]+\s+([\d.]+)\s*([KMGT]?)i?B\//g;
      let m;
      while ((m = dlProgRe.exec(d)) !== null) updateDownloaded(aria2SizeToBytes(m[1], m[2]));
      // Kecepatan DL:12MiB (baris lain, tanpa total) untuk log.
      const dlRe = /DL:([\d.]+)\s*([KMGT]?)i?B\b/g;
      const dl = dlRe.exec(d);
      if (dl && now - lastProgressLog > 5000) {
        lastProgressLog = now;
        if (onLog) onLog(`DL: ${dl[1]}${dl[2]}${dl[2] ? 'i' : ''}B/s`);
      }
    }

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('close', (code, signal) => {
      clearTimeout(timeout);
      clearInterval(watchdog);
      if (killReason) {
        const logData = { file: fileName, reason: killReason, exitCode: code };
        if (signal) logData.signal = signal;
        appLogger.warn(logData, 'aria2c killed');
        cleanupFiles(outPath);
        return reject(new Error(killReason));
      }
if (code === 0 && fs.existsSync(outPath)) {
  const sizeBytes = fs.statSync(outPath).size;
  if (sizeBytes < 1024) {
    cleanupFiles(outPath);
    return reject(new Error('File terlalu kecil — URL mungkin expired'));
  }
  // Validasi isi, bukan cuma ukuran. Provider yang balas HTTP 200 dengan halaman
  // error (mis. gofile tanpa header auth → "Gofile needs JavaScript to run")
  // lolos pengecekan ukuran 1 KB, lalu diteruskan ke upload/Telegram sebagai video.
  try {
    assertLooksLikeVideo(outPath);
  } catch (err) {
    cleanupFiles(outPath);
    return reject(err);
  }
  const sizeMb = (sizeBytes / 1024 / 1024).toFixed(1);
        appLogger.info({ file: fileName, sizeMb, status: 'done' }, 'aria2c download complete');
        resolve(outPath);
      } else {
        const rawErr = output.slice(-300).trim() || `aria2c exit ${code}`;
        // Deteksi HTTP 451 (takedown DMCA / legal unavailable) → pesan jelas
        if (/451|unavailable_for_legal|takedown|legal reasons/i.test(rawErr)) {
          appLogger.error({ file: fileName, exitCode: code, output: output.slice(-500) }, 'aria2c takedown (451)');
          return reject(new Error('File di-takedown DMCA (HTTP 451) — tidak bisa di-download dari host ini.'));
        }
        appLogger.error({ file: fileName, exitCode: code, output: output.slice(-500) }, 'aria2c download failed');
        reject(new Error(`Download gagal: ${rawErr}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      clearInterval(watchdog);
      appLogger.error({ file: fileName, err: err.message }, 'aria2c error');
      reject(err);
    });
    });
  })();
}

/**
 * Escape path untuk dipakai di dalam filter ffmpeg (-vf subtitles=...).
 * Path bisa berisi titik dua, backslash, tanda kutip, dll.
 */
function escapeFilterPath(filePath) {
  return filePath
    .replace(/\\/g, '/')
    .replace(/'/g, '\\\'')
    .replace(/:/g, '\\:');
}

/**
 * Buat path output temp.
 */
function tempPath(name) {
  return path.join(TMP_DIR, name);
}

/**
 * Sanitasi nama file server supaya aman untuk TMP_DIR & jadi nama file Telegram
 * (hilangkan traversal/karakter kontrol, batasi panjang). Fallback = nama acak
 * ber-timestamp kalau nama server kosong atau hanya junk.
 */
function safeFileName(name, fallback) {
  const clean = String(name || '')
    .normalize('NFC')
    .replace(/[\\/]/g, '_')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\.{2,}/g, '_')
    .trim()
    .slice(0, 150);
  return (clean && clean !== '.') ? clean : fallback;
}

/**
 * Path temp dengan fallback anti-bentrok (nama sudah ada di TMP_DIR).
 * Dipakai supaya file yang di-upload Telegram namanya beneran dari server
 * (mis. "One Piece Ep 1125.mp4"), bukan gofile_<ts>.mp4 — nama acak itu
 * bikin bug parsing di konsumen lain (fomo-drama).
 */
function tempUniquePath(name) {
  const base = tempPath(name);
  if (!fs.existsSync(base)) return base;
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  return tempPath(`${stem}_${Date.now()}${ext}`);
}

/**
 * Ukuran file dalam MB.
 */
function fileSizeMb(filePath) {
  try { return fs.statSync(filePath).size / 1024 / 1024; } catch { return 0; }
}

module.exports = { downloadStream, downloadWithAria2c, mergeVideos, getVideoInfo, cleanupFiles, tempPath, tempUniquePath, safeFileName, fileSizeMb, remuxToMp4, TMP_DIR };
