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
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
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
      '-headers', 'User-Agent: Mozilla/5.0',
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

function downloadWithAria2c(url, outPath, onLog, extraHeaders = {}, fileSize) {
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

    let output = '';
    let lastProgressLog = 0;
    let timedOut = false;
    const timeoutMs = calcAria2cTimeout(fileSize);
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    function onData(d) {
      output += d;
      const pctMatch = d.match(/\((\d+)%\)/);
      if (pctMatch) {
        const now = Date.now();
        if (now - lastProgressLog > 3000) {
          lastProgressLog = now;
          if (onLog) onLog(`progress: ${pctMatch[1]}%`);
        }
        return;
      }
      const dlMatch = d.match(/DL:([\d\.]+)(\w+)/);
      if (dlMatch) {
        const now = Date.now();
        if (now - lastProgressLog > 5000) {
          lastProgressLog = now;
          if (onLog) onLog(`DL: ${dlMatch[1]}${dlMatch[2]}`);
        }
      }
    }

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        cleanupFiles(outPath);
        return reject(new Error(`Download timeout (${Math.round(timeoutMs / 1000)} detik)`));
      }
      if (code === 0 && fs.existsSync(outPath)) {
        const sizeBytes = fs.statSync(outPath).size;
        if (sizeBytes < 1024) {
          cleanupFiles(outPath);
          return reject(new Error('File terlalu kecil — URL mungkin expired'));
        }
        const sizeMb = (sizeBytes / 1024 / 1024).toFixed(1);
        appLogger.info({ file: fileName, sizeMb, status: 'done' }, 'aria2c download complete');
        resolve(outPath);
      } else {
        const errMsg = output.slice(-300).trim() || `aria2c exit ${code}`;
        appLogger.error({ file: fileName, exitCode: code, output: output.slice(-500) }, 'aria2c download failed');
        reject(new Error(`Download gagal: ${errMsg}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      appLogger.error({ file: fileName, err: err.message }, 'aria2c error');
      reject(err);
    });
  });
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
 * Ukuran file dalam MB.
 */
function fileSizeMb(filePath) {
  try { return fs.statSync(filePath).size / 1024 / 1024; } catch { return 0; }
}

module.exports = { downloadStream, downloadWithAria2c, mergeVideos, getVideoInfo, cleanupFiles, tempPath, fileSizeMb, TMP_DIR };
