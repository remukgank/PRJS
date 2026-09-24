// handlers/download.js — E4a GoFile family (ctx injection, no require ../bot)
const fs = require('fs');
const path = require('path');
const { logger } = require('../logger');
const { isGofileUrl, isGofileDirectUrl, filenameFromGofileUrl, resolveGofileFirstFile } = require('../providers/gofile');
const { cacheUrl, resolveFileName } = require('../lib/urlCache');
const { isPixeldrainUrl, extractPixeldrainId, getPixeldrainInfo } = require('../providers/pixeldrain');
const { isFiledonUrl, resolveFiledonFile } = require('../providers/filedon');
const { isGdriveUrl, resolveGdriveFile } = require('../providers/gdrive');
const { isMegaUrl, resolveMegaFile, downloadMegaFile } = require('../providers/mega');
const { isGdrivePlayerUrl, resolveGdrivePlayerFile, GPLAYER_UA, GPLAYER_REF } = require('../providers/gdriveplayer');
const { getShareInfo, downloadShare, sanitize } = require('../providers/ucdrive');
const axios = require('axios');
const { downloadWithAria2c, fileSizeMb, getVideoInfo, cleanupFiles, tempPath, tempUniquePath, safeFileName, remuxToMp4 } = require('../downloader');
const { cleanCaption, parseKuronimeSeasonEpisode, extractPartFromFilename, sanitizeSlug, extractSourcePattern, extractProvider, parseSamehadakuFilename } = require('../lib/parser');
const { detectTitleFromFilename } = require('../lib/titleDetect');

// sendVideo/sendAudio/sendDocument injected via ctx (masih di bot.js, belum E3)
const { getPartFileId, savePartFileId, upsertMedia, getSetting, findMediaByPattern } = require('../db');

function hashUrl(url) {
  return require('crypto').createHash('md5').update(url).digest('hex');
}

// Extract UC share ID dari URL (uc-share.com / drive.ucweb.com) — duplikat kecil dari bot.js
// agar handler mandiri tanpa require ../bot (E5 ctx injection).
function ucShareId(text) {
  const m = text.match(/(?:uc-share\.com|drive\.ucweb\.com)\/s\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

// ctx: { bot, config: { MAX_UPLOAD_MB }, samehadakuEpisodeMap }
let _ctx = null;
function initDownload(ctx) {
  _ctx = ctx;
}
function ensureCtx(caller) {
  if (!_ctx || !_ctx.bot) throw new Error(`handlers/download belum di-init — panggil initDownload({ bot, config, samehadakuEpisodeMap, ... }) dulu (dari ${caller})`);
}

// Mode batch senyap: leaf handler tdk kirim pesan ⚠️ (cukup di tabel RichProgress batch).
// Di-toggle oleh downloadSamehadakuFile saat dipanggil dgn opts.silent = { silent-visibility }
let _samQuiet = false;
function leafAlert(chatId, text) {
  if (_samQuiet) return Promise.resolve();
  return _ctx.bot.sendMessage(chatId, text).catch(() => {});
}

// Saat batch: leaf handler TIDAK bikin RichProgress per-episode (trafik edit pesan)
// cukup tabel batch utama. noopRp = object no-op agar kode leaf tetap jalan polos.
function noopRp() {
  return {
    updateEpisode() {}, updateLabel() {}, update() {}, tick() {},
    note() { return this; },
    done() { return Promise.resolve(); },
  };
}

async function handleGofileUrl(chatId, url, customTitle = null) {
  ensureCtx('handleGofileUrl');
  const gofileToken = (process.env.GOFILE_TOKEN || '').trim();
  const urlHash = hashUrl(url);
  const extraHeaders = {
    'Referer': 'https://gofile.io/',
    ...(gofileToken && { 'Authorization': `Bearer ${gofileToken}` }),
  };
  // Deteksi Samehadaku: pakai season/episode dari map (provider samehadaku)
  const sami = _ctx.samehadakuEpisodeMap.get(url);
  const isSame = !!sami;

  if (isGofileDirectUrl(url)) {
    const fileName = resolveFileName(url) || filenameFromGofileUrl(url);

    if (!customTitle) {
      const { title } = await detectTitleFromFilename(fileName);
      if (title) customTitle = title;
    }

    const cap = customTitle || cleanCaption(fileName);
    const goPartInit = sami?.episode ?? parseSamehadakuFilename(fileName)?.episode ?? extractPartFromFilename(fileName);
    const capWithEp = customTitle ? `${cap} — Episode ${goPartInit}` : cap;
    const cacheInfo = { urlHash, source: 'gofile', fileName };
    const rp = _samQuiet ? noopRp() : await new _ctx.RichProgress(chatId, cap, [{ ep: capWithEp }]).start();
    const outPath = tempPath(fileName);

    try {
      rp.updateEpisode(capWithEp, 'download');
      await downloadWithAria2c(url, outPath, (log) => {
        if (log.includes('progress:')) {
          rp.updateEpisode(capWithEp, 'download', log.split('progress: ')[1]);
        } else if (log.startsWith('DL:')) {
          rp.updateEpisode(capWithEp, 'download', log);
        }
      }, extraHeaders);

      const sizeMb = fileSizeMb(outPath);
      logger.info({ chatId, file: fileName, sizeMb: sizeMb.toFixed(1) }, 'GoFile download selesai');

      if (sizeMb > _ctx.config.MAX_UPLOAD_MB) {
        rp.updateEpisode(capWithEp, 'fail', `${sizeMb.toFixed(1)} MB > limit`);
        return { ok: false, error: `${sizeMb.toFixed(1)} MB > limit` };
      }

      rp.updateEpisode(capWithEp, 'upload', `${sizeMb.toFixed(1)} MB`);

      const info = await getVideoInfo(outPath).catch(() => ({}));
      const ext = path.extname(outPath).toLowerCase();
      let sendResult = null;

      // Build caption: Samehadaku prioritas, lalu kuronime Season detect, else generic
      const kurSame = parseKuronimeSeasonEpisode(fileName);
      const goPart = sami?.episode ?? parseSamehadakuFilename(fileName)?.episode ?? extractPartFromFilename(fileName);
      let finalCap = cap;
      if (customTitle) {
        if (isSame && sami) {
          const cleanTitle = (customTitle && !/S\d/i.test(sami.title||'')) ? customTitle : (sami.title || customTitle || '');
          const partSuffix = sami.part ? ` Part ${sami.part}` : '';
          if (sami.movie) {
            finalCap = [
              `➧ Judul :- ${cleanTitle}`,
              `➧ Tipe :- Movie`,
              `➧ Provider :- samehadaku`,
            ].join('\n');
          } else if (sami.season) {
            finalCap = [
              `➧ Judul :- ${cleanTitle}`,
              `➧ Season :- ${sami.season}${partSuffix} Episode ${sami.episode}`,
              `➧ Provider :- samehadaku`,
            ].join('\n');
          } else {
            finalCap = [
              `➧ Judul :- ${cleanTitle}`,
              `➧ Episode :- ${sami.episode}`,
              `➧ Provider :- samehadaku`,
            ].join('\n');
          }
        } else if (kurSame) {
          const cleanTitle = customTitle.replace(/\s*(?:Episode|Ep|Part|E)\s*\d+\s*/gi, ' ').trim();
          finalCap = [
            `➧ Judul :- ${cleanTitle || customTitle}`,
            `➧ Season :- ${kurSame.season} Episode ${kurSame.episode}`,
            `➧ Provider :- ${extractProvider(fileName)}`,
          ].join('\n');
        } else {
          const cleanTitle = customTitle.replace(/\s*(?:Episode|Ep|Part|E)\s*\d+\s*/gi, ' ').trim();
          finalCap = [
            `➧ Judul :- ${cleanTitle || customTitle}`,
            `➧ Episode :- ${goPart}`,
            `➧ Provider :- ${extractProvider(fileName)}`,
          ].join('\n');
        }
      }

      sendResult = await _ctx.sendAnimeMedia(chatId, outPath, {
        caption: finalCap,
        supports_streaming: true,
        ...(info.duration && { duration: info.duration }),
        ...(info.width && { width: info.width }),
        ...(info.height && { height: info.height }),
      }, cacheInfo);
      // Simpan ke library jika custom title
      if (customTitle && sendResult?.video?.file_id) {
        const cleanTitle = customTitle.replace(/\s*(?:Episode|Ep|Part|E)\s*\d+\s*/gi, ' ').trim();
        const slug = `anime:${sanitizeSlug(cleanTitle || customTitle)}`;
        const existing = await getPartFileId(slug, goPart);
        if (existing) {
          logger.info({ slug, part: goPart, existingFile: existing.file_name }, 'Skip save: part already exists');
        } else {
          const sourcePattern = extractSourcePattern(fileName);
          await upsertMedia(slug, cleanTitle || customTitle, 0, url, sourcePattern);
          await savePartFileId(slug, goPart, sendResult.video.file_id, Math.round(sizeMb * 1024 * 1024), fileName, finalCap);
        }
      }
      rp.updateEpisode(capWithEp, 'done', `${sizeMb.toFixed(1)} MB`);
      rp.done();
    } catch (err) {
      logger.error({ chatId, file: fileName, err: err.message }, 'GoFile direct gagal');
      rp.updateEpisode(capWithEp, 'fail', err.message.slice(0, 30));
      rp.done().catch(() => {});
      return { ok: false, error: err.message };
    } finally {
      cleanupFiles(outPath);
    }
    return { ok: true, file: fileName, sizeMb, part: goPart };
  }

  let outPath = null;
  let cap = '';
  let capWithEp = '';
  let rp;
  try {
    const file = await resolveGofileFirstFile(url);
    const sizeMb = (file.size / 1024 / 1024).toFixed(1);
    if (!customTitle) {
      const { title } = await detectTitleFromFilename(file.name);
      if (title) customTitle = title;
    }
    cap = customTitle || cleanCaption(file.name);
    const fileName = file.name;
    const cacheInfo = { urlHash, source: 'gofile', fileName };
    capWithEp = customTitle ? `${cap} — Episode ${sami?.episode ?? parseSamehadakuFilename(file.name)?.episode ?? extractPartFromFilename(file.name)}` : cap;
    rp = _samQuiet ? noopRp() : await new _ctx.RichProgress(chatId, cap, [{ ep: capWithEp }]).start();

    if (file.size / 1024 / 1024 > _ctx.config.MAX_UPLOAD_MB) {
      rp.updateEpisode(capWithEp, 'fail', `${sizeMb} MB > limit`);
      rp.done();
      return { ok: false, error: `${sizeMb} MB > limit` };
    }

    const ext = path.extname(file.name) || '';
    outPath = tempUniquePath(safeFileName(file.name, `gofile_${Date.now()}${ext}`));

    rp.updateEpisode(capWithEp, 'download');
    await downloadWithAria2c(file.url, outPath, (log) => {
      if (log.includes('progress:')) {
        rp.updateEpisode(cap, 'download', log.split('progress: ')[1]);
      }
    }, extraHeaders, file.size);

    const finalSize = fileSizeMb(outPath);
    logger.info({ chatId, file: file.name, sizeMb: finalSize.toFixed(1) }, 'GoFile download selesai');

    rp.updateEpisode(capWithEp, 'upload', `${finalSize.toFixed(1)} MB`);

    const info = await getVideoInfo(outPath).catch(() => ({}));
    const fext = path.extname(outPath).toLowerCase();
    let sendResult = null;

    // Build caption: Samehadaku > kuronime Season > generic Episode
    const kurSame2 = parseKuronimeSeasonEpisode(file.name);
    const batchPart = sami?.episode ?? parseSamehadakuFilename(file.name)?.episode ?? extractPartFromFilename(file.name);
    let finalCap = cap;
    if (customTitle) {
      if (isSame && sami) {
        const cleanTitle = (customTitle && !/S\d/i.test(sami.title||'')) ? customTitle : (sami.title || customTitle || '');
        const partSuffix2 = sami.part ? ` Part ${sami.part}` : '';
        if (sami.season) {
          finalCap = [
            `➧ Judul :- ${cleanTitle}`,
            `➧ Season :- ${sami.season}${partSuffix2} Episode ${sami.episode}`,
            `➧ Provider :- samehadaku`,
          ].join('\n');
        } else {
          finalCap = [
            `➧ Judul :- ${cleanTitle}`,
            `➧ Episode :- ${sami.episode}`,
            `➧ Provider :- samehadaku`,
          ].join('\n');
        }
      } else {
        const cleanTitle = customTitle.replace(/\s*(?:Episode|Ep|Part|E)\s*\d+\s*/gi, ' ').trim();
        finalCap = [
          `➧ Judul :- ${cleanTitle || customTitle}`,
          `➧ Episode :- ${batchPart}`,
          `➧ Provider :- ${extractProvider(file.name)}`,
        ].join('\n');
      }
    }

    sendResult = await _ctx.sendAnimeMedia(chatId, outPath, {
        caption: finalCap,
        supports_streaming: true,
        ...(info.duration && { duration: info.duration }),
        ...(info.width && { width: info.width }),
        ...(info.height && { height: info.height }),
      }, cacheInfo);
    // Simpan ke library jika custom title
    if (customTitle && sendResult?.video?.file_id) {
      const cleanTitle = customTitle.replace(/\s*(?:Episode|Ep|Part|E)\s*\d+\s*/gi, ' ').trim();
      const slug = `anime:${sanitizeSlug(cleanTitle || customTitle)}`;
      const existing = await getPartFileId(slug, batchPart);
      if (existing) {
        logger.info({ slug, part: batchPart, existingFile: existing.file_name }, 'Skip save: part already exists');
      } else {
        const sourcePattern = extractSourcePattern(file.name);
        await upsertMedia(slug, cleanTitle || customTitle, 0, url, sourcePattern);
          await savePartFileId(slug, batchPart, sendResult.video.file_id, Math.round(finalSize * 1024 * 1024), file.name, finalCap);
      }
    }
    rp.updateEpisode(capWithEp, 'done', `${finalSize.toFixed(1)} MB`);
    rp.done();
    return { ok: true, file: file.name, sizeMb: finalSize, part: batchPart };
  } catch (err) {
    logger.error({ chatId, url: url.slice(0, 80), err: err.message }, 'GoFile content gagal');
    if (rp) {
      rp.updateEpisode(capWithEp, 'fail', err.message.slice(0, 50));
      rp.done().catch(() => {});
    }
    throw err;
  } finally {
    cleanupFiles(outPath);
  }
}

async function handleGofileBatch(chatId, urls) {
  ensureCtx('handleGofileBatch');
  const episodes = urls.map((u, i) => {
    const name = filenameFromGofileUrl(u);
    return { ep: name, label: `File ${i + 1}`, name };
  });

  const gofileToken = (process.env.GOFILE_TOKEN || '').trim();
  const extraHeaders = {
    'Referer': 'https://gofile.io/',
    ...(gofileToken && { 'Authorization': `Bearer ${gofileToken}` }),
  };

  const rp = await new _ctx.RichProgress(chatId, `Batch ${urls.length} file`, episodes).start();
  let done = 0, fail = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const ep = episodes[i];
    const outPath = tempPath(ep.name);
    const urlHash = hashUrl(url);
    const cacheInfo = { urlHash, source: 'gofile', fileName: ep.name };

    try {
      rp.updateEpisode(ep.ep, 'download');
      await downloadWithAria2c(url, outPath, (log) => {
        if (log.includes('progress:')) {
          rp.updateEpisode(ep.ep, 'download', log.split('progress: ')[1]);
        }
      }, extraHeaders);

      const sizeMb = fileSizeMb(outPath);
      if (sizeMb > _ctx.config.MAX_UPLOAD_MB) {
        rp.updateEpisode(ep.ep, 'fail', `${sizeMb.toFixed(1)} MB > limit`);
        fail++;
        continue;
      }

      rp.updateEpisode(ep.ep, 'upload', `${sizeMb.toFixed(1)} MB`);
      const cap = cleanCaption(ep.name);
      const epMatch = ep.name.match(/(\d+)\.[a-z0-9]+$/i);
      const epLabel = epMatch ? `Ep ${epMatch[1]}` : `#${i + 1}`;
      const caption = `${epLabel} — ${cap}`;
      const info = await getVideoInfo(outPath).catch(() => ({}));
      const ext = path.extname(outPath).toLowerCase();
      await _ctx.sendAnimeMedia(chatId, outPath, {
        caption,
        supports_streaming: true,
        ...(info.duration && { duration: info.duration }),
        ...(info.width && { width: info.width }),
        ...(info.height && { height: info.height }),
      }, cacheInfo);
      rp.updateEpisode(ep.ep, 'done', `${sizeMb.toFixed(1)} MB`);
      done++;
    } catch (err) {
      logger.error({ chatId, file: ep.name, err: err.message }, 'GoFile batch item gagal');
      rp.updateEpisode(ep.ep, 'fail', err.message.slice(0, 30));
      fail++;
    } finally {
      cleanupFiles(outPath);
    }
  }

  rp.done();
  logger.info({ chatId, total: urls.length, done, fail }, 'GoFile batch selesai');
}

async function handleUcDriveUrl(chatId, text) {
  ensureCtx('handleUcDriveUrl');
  const shareId = ucShareId(text);
  if (!shareId) {
    return _ctx.bot.sendMessage(chatId, '⚠️ Link UC Drive tidak valid.');
  }
  logger.info({ chatId, shareId }, 'UC Drive share requested');

  const status = await _ctx.bot.sendMessage(chatId, '🔍 Mengambil info share UC Drive...');
  let outDir;
  try {
    const info = await getShareInfo(shareId);
    const videoCount = info.files.length;
    await _ctx.bot.editMessageText(
      `📋 <b>${info.title}</b>\n🎞 ${videoCount} file ditemukan\n⬇️ Memulai download...`,
      { chat_id: chatId, message_id: status.message_id, parse_mode: 'HTML' }
    );
    outDir = tempPath(`ucdrive_${shareId}`);
    fs.mkdirSync(outDir, { recursive: true });

    const result = await downloadShare(shareId, outDir, async (done, total, msg) => {
      if (done % 1 === 0) {
        await _ctx.bot.editMessageText(`⬇️ Download ${done}/${total}\n${msg}`, {
          chat_id: chatId, message_id: status.message_id, parse_mode: 'HTML',
        }).catch(() => {});
      }
    });

    await _ctx.bot.editMessageText(
      `✅ Download selesai: ${result.downloaded} file (${result.skipped} skip, ${result.failed} gagal)\n📤 Mengirim ke chat...`,
      { chat_id: chatId, message_id: status.message_id, parse_mode: 'HTML' }
    );

    // Send each downloaded file
    let sent = 0, fail = 0;
    const allFiles = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(mp4|mkv|mov|avi|webm)$/i.test(e.name)) allFiles.push(p);
      }
    };
    walk(outDir);

    for (const f of allFiles) {
      try {
        const cap = cleanCaption(path.basename(f));
        const info = await getVideoInfo(f).catch(() => ({}));
        await _ctx.sendAnimeMedia(chatId, f, {
          caption: cap, supports_streaming: true,
          ...(info.duration && { duration: info.duration }),
          ...(info.width && { width: info.width }),
          ...(info.height && { height: info.height }),
        });
        sent++;
      } catch (e) {
        fail++;
        logger.error({ file: path.basename(f), err: e.message }, 'sendVideo failed');
      }
    }

    await _ctx.sendRichMessage(chatId, `📤 Terkirim ${sent} video (${fail} gagal).`, { format: 'markdown' });
  } catch (err) {
    logger.error({ chatId, shareId, err: { message: err.message, stack: err.stack } }, 'UC Drive handler failed');
    await _ctx.bot.editMessageText(`❌ Gagal: ${err.message.slice(0, 150)}`, {
      chat_id: chatId, message_id: status.message_id, parse_mode: 'HTML',
    }).catch(() => {});
  } finally {
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
  }
}


async function handlePixeldrainUrl(chatId, url, customTitle = null, expectedEp = null) {
  ensureCtx('handlePixeldrainUrl');
  let outPath = null;
  const sami = _ctx.samehadakuEpisodeMap.get(url);
  const isSame = !!sami;
  let rp;
  let cap = '';
  const urlHash = hashUrl(url);
  try {
    const info = await getPixeldrainInfo(url);
    const sizeMb = (info.size / 1024 / 1024).toFixed(1);
    const fileName = info.name;

    if (!customTitle) {
      const { title } = await detectTitleFromFilename(fileName);
      if (title) customTitle = title;
    }

    cap = customTitle || cleanCaption(fileName);
    // utk file samehadaku pakai sami.episode (extractPartFromFilename gagal utk format SHORT-S2-N-FULLHD-SAMEHADAKU)
    const pixPart = sami?.episode ?? parseSamehadakuFilename(info.name)?.episode ?? extractPartFromFilename(info.name);
    const mismatch = partMismatch(expectedEp, pixPart);
    if (mismatch) {
      await leafAlert(chatId, `⚠️ Pixeldrain utk Ep ${expectedEp} menunjuk file salah (${info.name}).\n${mismatch}\nPakai server lain.`);
      return { ok: false, error: mismatch };
    }
    const capWithEp = customTitle ? `${cap} — Episode ${pixPart}` : cap;
    const cacheInfo = { urlHash, source: 'pixeldrain', fileName };
    rp = _samQuiet ? noopRp() : await new _ctx.RichProgress(chatId, cap, [{ ep: capWithEp }]).start();

    const capWithEpForLimit = capWithEp;
    if (info.size / 1024 / 1024 > _ctx.config.MAX_UPLOAD_MB) {
      rp.updateEpisode(capWithEpForLimit, 'fail', `${sizeMb} MB > limit`);
      rp.done();
      return { ok: false, error: `${sizeMb} MB > limit` };
    }

    const ext = path.extname(info.name) || '';
    outPath = tempUniquePath(safeFileName(info.name, `pixeldrain_${Date.now()}${ext}`));

    rp.updateEpisode(cap, 'download');
    const capEp = cap;
    // Pre-check header — pixeldrain: 451 = takedown DMCA, kasih pesan jelas bukan aria2c cryptic
    try {
      const head = await axios.head(info.directUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, timeout: 15000, validateStatus: () => true });
      if (head.status === 451 || /unavailable_for_legal|takedown|legal/i.test(String(head.headers['content-type'] || '') + (head.headers['content-disposition'] || ''))) {
        throw new Error('File di-takedown DMCA (HTTP 451) — tidak bisa di-download dari Pixeldrain.');
      }
    } catch (e) {
      if (/takedown|451|legal/i.test(e.message)) {
        rp.updateEpisode(capEp, 'fail', 'takedown DMCA');
        rp.done().catch(() => {});
        cleanupFiles(outPath);
        await leafAlert(chatId, `⚠️ Pixeldrain: file di-takedown DMCA (HTTP 451) — tidak bisa didownload di server ini. \nCoba pilih server lain di pesan daftar episode.`);
        return { ok: false, error: 'takedown DMCA (HTTP 451)' };
      }
    }
    await downloadWithAria2c(info.directUrl, outPath, (log) => {
      if (log.includes('progress:')) {
        rp.updateEpisode(capEp, 'download', log.split('progress: ')[1]);
      } else if (log.startsWith('DL:')) {
        rp.updateEpisode(capEp, 'download', log);
      }
    }, { 'Referer': 'https://pixeldrain.com/' }, info.size);

    const finalSize = fileSizeMb(outPath);
    logger.info({ chatId, file: info.name, sizeMb: finalSize.toFixed(1) }, 'Pixeldrain selesai');

    rp.updateEpisode(capWithEp, 'upload', `${finalSize.toFixed(1)} MB`);

    // Build caption: Samehadaku > kuronime Season > generic Episode
    const kurSamePix = parseKuronimeSeasonEpisode(info.name);
    const part = sami?.episode ?? parseSamehadakuFilename(info.name)?.episode ?? extractPartFromFilename(info.name);
    let finalCap = cap;
    if (customTitle) {
      if (isSame && sami) {
        const cleanTitle = (customTitle && !/S\d/i.test(sami.title||'')) ? customTitle : (sami.title || customTitle || '');
        const partSuffix3 = sami.part ? ` Part ${sami.part}` : '';
        if (sami.season) {
          finalCap = [
            `➧ Judul :- ${cleanTitle}`,
            `➧ Season :- ${sami.season}${partSuffix3} Episode ${sami.episode}`,
            `➧ Provider :- samehadaku`,
          ].join('\n');
        } else {
          finalCap = [
            `➧ Judul :- ${cleanTitle}`,
            `➧ Episode :- ${sami.episode}`,
            `➧ Provider :- samehadaku`,
          ].join('\n');
        }
      } else if (kurSamePix) {
        const cleanTitle = customTitle.replace(/\s*(?:Episode|Ep|Part|E)\s*\d+\s*/gi, ' ').trim();
        finalCap = [
          `➧ Judul :- ${cleanTitle || customTitle}`,
          `➧ Season :- ${kurSamePix.season} Episode ${kurSamePix.episode}`,
          `➧ Provider :- ${extractProvider(info.name)}`,
        ].join('\n');
      } else {
        const cleanTitle = customTitle.replace(/\s*(?:Episode|Ep|Part|E)\s*\d+\s*/gi, ' ').trim();
        finalCap = [
          `➧ Judul :- ${cleanTitle || customTitle}`,
          `➧ Episode :- ${part}`,
          `➧ Provider :- ${extractProvider(info.name)}`,
        ].join('\n');
      }
    }

    const vinfo = await getVideoInfo(outPath).catch(() => ({}));
    const fext = path.extname(outPath).toLowerCase();
    let sendResult = null;
    sendResult = await _ctx.sendAnimeMedia(chatId, outPath, {
        caption: finalCap,
        supports_streaming: true,
        ...(vinfo.duration && { duration: vinfo.duration }),
        ...(vinfo.width && { width: vinfo.width }),
        ...(vinfo.height && { height: vinfo.height }),
      }, cacheInfo);
    // Simpan ke library jika custom title
    if (customTitle && sendResult?.video?.file_id) {
      const cleanTitle = customTitle.replace(/\s*(?:Episode|Ep|Part|E)\s*\d+\s*/gi, ' ').trim();
      const slug = `anime:${sanitizeSlug(cleanTitle || customTitle)}`;
      const existing = await getPartFileId(slug, part);
      if (existing) {
        logger.info({ slug, part, existingFile: existing.file_name }, 'Skip save: part already exists');
      } else {
        const sourcePattern = extractSourcePattern(info.name);
        await upsertMedia(slug, cleanTitle || customTitle, 0, url, sourcePattern);
        await savePartFileId(slug, part, sendResult.video.file_id, Math.round(finalSize * 1024 * 1024), info.name, finalCap);
      }
    }
    rp.updateEpisode(capEp, 'done', `${finalSize.toFixed(1)} MB`);
    rp.done();
    return { ok: true, file: info.name, sizeMb: finalSize, part };
  } catch (err) {
    logger.error({ chatId, url: url.slice(0, 80), err: err.message }, 'Pixeldrain gagal');
    if (rp) {
      rp.updateEpisode(cap || 'file', 'fail', err.message.slice(0, 50));
      rp.done().catch(() => {});
    }
    // Feedback ke Telegram (jangan silent) — kirim pesan error agar user tahu
    await leafAlert(chatId, `⚠️ Pixeldrain gagal: ${err.message.slice(0, 120)}\n\nLink mungkin expired/private. Coba server/URL lain.`);
    return { ok: false, error: err.message };
  } finally {
    cleanupFiles(outPath);
  }
}


async function handleFiledonUrl(chatId, url, customTitle = null, expectedEp = null) {
  ensureCtx('handleFiledonUrl');
  let outPath = null;
  let cap = '';
  let capWithEp = '';
  let rp = null;
  try {
    const fd = await resolveFiledonFile(url);
    const fdName = fd.name;
    const fdSame = parseSamehadakuFilename(fdName);
    const partN = fdSame?.episode ?? extractPartFromFilename(fdName);
    const mismatch = partMismatch(expectedEp, partN);
    if (mismatch) {
      await leafAlert(chatId, `⚠️ Filedon utk Ep ${expectedEp} menunjuk file salah (${fdName}).\n${mismatch}\nPakai server lain.`);
      return { ok: false, error: mismatch };
    }
    const patFile = fdSame?.short ? fdSame.short : extractSourcePattern(fdName);
    let title = null;
    // Utk file Samehadaku: base title = S1 (kuronime-tssdk / samehadaku short), lalu tambah suffix S{season}.
    // JANGAN pakai findMediaByPattern('TSS') karena source_pattern TSS dipakai multi-season (collide bug DB).
    if (fdSame) {
      // Alias: short file Samehadaku (TSS) → S1 kuronime pattern. TSS→tssdk, dst.
      const SHORT_ALIAS = { tss: 'tssdk', tssdk: 'tssdk', yntg: 'ymintsgai', ymintsgai: 'ymintsgai' };
      const baseShort = SHORT_ALIAS[fdSame.short] || fdSame.short;
      const baseLook = await findMediaByPattern(`kuronime-${baseShort}`).catch(() => null)
        || await findMediaByPattern(`samehadaku-${baseShort}`).catch(() => null)
        || await findMediaByPattern(`kuronime-${fdSame.short}`).catch(() => null);
      title = baseLook ? baseLook.nama : null;
      if (fdSame.season && title) title = `${title} S${fdSame.season}${fdSame.part ? ` P${fdSame.part}` : ''}`;
    } else {
      const pat = extractSourcePattern(fdName);
      if (pat) {
        const m = await findMediaByPattern(pat).catch(() => null);
        if (m) title = m.nama;
      }
    }
    // Fallback: customTitle dari alur samehadaku (sudah "... S2") bila DB lookup gagal —
    // anti-dobel: jangan tambah S suffix kalau customTitle sudah mengandungnya.
    if (!title && customTitle) {
      title = customTitle;
      if (fdSame?.season && !new RegExp(`\\bS${fdSame.season}\\b`, 'i').test(title)) {
        title = `${title} S${fdSame.season}${fdSame.part ? ` P${fdSame.part}` : ''}`;
      }
    }
    const titleForCap = title; // title sudah incl S{season} (anti-dobel)
    cap = titleForCap || cleanCaption(fdName);
    capWithEp = titleForCap ? `${cap} — Episode ${partN}` : cap;
    const cacheInfo = { urlHash: hashUrl(url), source: 'filedon', fileName: fdName };
    rp = _samQuiet ? noopRp() : await new _ctx.RichProgress(chatId, cap, [{ ep: capWithEp }]).start();
    rp.updateEpisode(capWithEp, 'download');
    outPath = tempPath(fdName);
    await downloadWithAria2c(fd.url, outPath, (log) => {
      if (log.includes('progress:')) rp.updateEpisode(capWithEp, 'download', log.split('progress: ')[1]);
      else if (log.startsWith('DL:')) rp.updateEpisode(capWithEp, 'download', log);
    }, { 'Referer': 'https://filedon.co/' }, fd.size);
    // remux mkv → mp4 utk preview (Filedon kadang mkv)
    if (/\.mkv$/i.test(outPath)) outPath = await remuxToMp4(outPath);
    const finalSize = fileSizeMb(outPath);
    logger.info({ chatId, file: fdName, sizeMb: finalSize.toFixed(1) }, 'Filedon download selesai');
    rp.updateEpisode(capWithEp, 'upload', `${finalSize.toFixed(1)} MB`);
    const info = await getVideoInfo(outPath).catch(() => ({}));
    const fext = path.extname(outPath).toLowerCase();
    let finalCap = cap;
    if (titleForCap) {
      const epLineFd = fdSame?.season
        ? `➧ Season :- ${fdSame.season}${fdSame.part ? ` Part ${fdSame.part}` : ''} Episode ${partN}`
        : `➧ Episode :- ${partN}`;
      finalCap = [
        `➧ Judul :- ${titleForCap}`,
        epLineFd,
        `➧ Provider :- ${fdSame ? 'samehadaku' : extractProvider(fdName)}`,
      ].join('\n');
    }
    let sendResult = null;
    sendResult = await _ctx.sendAnimeMedia(chatId, outPath, {
        caption: finalCap, supports_streaming: true,
        ...(info.duration && { duration: info.duration }),
        ...(info.width && { width: info.width }),
        ...(info.height && { height: info.height }),
      }, cacheInfo);
    if (title && sendResult?.video?.file_id && (await getSetting('libsimpan')) === 'on') {
      const slug = `anime:${sanitizeSlug(title)}`;
      const existing = await getPartFileId(slug, partN);
      if (!existing) {
        await upsertMedia(slug, title, 0, url, patFile);
        await savePartFileId(slug, partN, sendResult.video.file_id, Math.round(finalSize * 1024 * 1024), fdName, finalCap);
      }
    }
    rp.updateEpisode(capWithEp, 'done', `${finalSize.toFixed(1)} MB`);
    rp.done();
    return { ok: true, file: fdName, sizeMb: finalSize, part: partN };
  } catch (err) {
    logger.error({ chatId, url: url.slice(0, 90), err: err.message }, 'Filedon gagal');
    if (rp) { rp.updateEpisode(capWithEp || cap || 'file', 'fail', err.message.slice(0, 50)); rp.done().catch(() => {}); }
    await leafAlert(chatId, `⚠️ Filedon gagal: ${err.message.slice(0, 120)}\n\nLink mungkin private/expired.`);
    return { ok: false, error: err.message };
  } finally {
    cleanupFiles(outPath);
  }
}


async function handleMegaUrl(chatId, url, customTitle = null) {
  ensureCtx('handleMegaUrl');
  let outPath = null;
  let cap = '';
  let capWithEp = '';
  let rp = null;
  try {
    const mf = await resolveMegaFile(url);
    const mfName = mf.name;
    const partN = extractPartFromFilename(mfName);
    const patFile = extractSourcePattern(mfName);
    let title = customTitle || null;
    if (!title) {
      const { title: detected } = await detectTitleFromFilename(mfName);
      if (detected) title = detected;
    }
    const titleForCap = title;
    cap = titleForCap || cleanCaption(mfName);
    capWithEp = titleForCap ? `${cap} — Episode ${partN}` : cap;
    const cacheInfo = { urlHash: hashUrl(url), source: 'mega', fileName: mfName };
    rp = await new _ctx.RichProgress(chatId, cap, [{ ep: capWithEp }]).start();
    if (mf.size / 1024 / 1024 > _ctx.config.MAX_UPLOAD_MB) {
      rp.updateEpisode(capWithEp, 'fail', `${(mf.size / 1024 / 1024).toFixed(1)} MB > limit`);
      rp.done();
      return;
    }
    rp.updateEpisode(capWithEp, 'download');
    outPath = tempPath(mfName);
    let lastPct = -1;
    await downloadMegaFile(mf.file, outPath, (done, total) => {
      if (!total) return;
      const pct = Math.floor((done / total) * 100);
      if (pct !== lastPct && pct % 10 === 0) {
        lastPct = pct;
        rp.updateEpisode(capWithEp, 'download', `${pct}%`);
      }
    });
    const finalSize = fileSizeMb(outPath);
    logger.info({ chatId, file: mfName, sizeMb: finalSize.toFixed(1) }, 'Mega download selesai');
    rp.updateEpisode(capWithEp, 'upload', `${finalSize.toFixed(1)} MB`);
    const info = await getVideoInfo(outPath).catch(() => ({}));
    const fext = path.extname(outPath).toLowerCase();
    let finalCap = cap;
    if (titleForCap) {
      const cleanTitle = titleForCap.replace(/\s*(?:Episode|Ep|Part|E)\s*\d+\s*/gi, ' ').trim();
      finalCap = [
        `➧ Judul :- ${cleanTitle || titleForCap}`,
        `➧ Episode :- ${partN}`,
        `➧ Provider :- ${extractProvider(mfName)}`,
      ].join('\n');
    }
    let sendResult = null;
    sendResult = await _ctx.sendAnimeMedia(chatId, outPath, {
        caption: finalCap, supports_streaming: true,
        ...(info.duration && { duration: info.duration }),
        ...(info.width && { width: info.width }),
        ...(info.height && { height: info.height }),
      }, cacheInfo);
    if (title && sendResult?.video?.file_id && (await getSetting('libsimpan')) === 'on') {
      const slug = `anime:${sanitizeSlug(title)}`;
      const existing = await getPartFileId(slug, partN);
      if (!existing) {
        await upsertMedia(slug, title, 0, url, patFile);
        await savePartFileId(slug, partN, sendResult.video.file_id, Math.round(finalSize * 1024 * 1024), mfName, finalCap);
      }
    }
    rp.updateEpisode(capWithEp, 'done', `${finalSize.toFixed(1)} MB`);
    rp.done();
  } catch (err) {
    logger.error({ chatId, url: url.slice(0, 90), err: err.message }, 'Mega gagal');
    if (rp) { rp.updateEpisode(capWithEp || cap || 'file', 'fail', err.message.slice(0, 50)); rp.done().catch(() => {}); }
    await _ctx.bot.sendMessage(chatId, `⚠️ Mega gagal: ${err.message.slice(0, 120)}\n\nLink mungkin private/expired atau tanpa #key.`).catch(() => {});
  } finally {
    cleanupFiles(outPath);
  }
}

async function handleGdriveUrl(chatId, url, customTitle = null, opts = {}) {
  ensureCtx('handleGdriveUrl');
  let outPath = null;
  let cap = '';
  let capWithEp = '';
  let rp = null;
  try {
    const gd = await resolveGdriveFile(url);
    const fileName = gd.name;
    const sourcePattern = extractSourcePattern(fileName);
    // Prioritas: filename gaya Samehadaku (TSSDK-S2-P2-1...) → season/part/episode + provider samehadaku
    const gdSame = parseSamehadakuFilename(fileName);
    let title = customTitle;
    if (!title) {
      const { title: detected } = await detectTitleFromFilename(fileName);
      if (detected) title = detected;
    }
    const part = extractPartFromFilename(fileName);
    const seasonEpLabel = gdSame
      ? (gdSame.season ? (gdSame.part ? `${gdSame.season} Part ${gdSame.part} Episode ${gdSame.episode}` : `${gdSame.season} Episode ${gdSame.episode}`) : `Episode ${gdSame.episode}`)
      : `Episode ${part}`;
    // Title untuk media (fomo anti-bentrok): tambah suffix " S2" / " S2 P2"
    // Anti-dobel: kalau customTitle sudah ada "S2"/"P2" jangan tambah ulang; kalau baru "S2" tapi belum "P2" lengkapi.
    let titleForMedia = title;
    if (titleForMedia && gdSame?.season) {
      const hasS = new RegExp(`\\bS${gdSame.season}\\b`).test(titleForMedia);
      const hasP = gdSame.part ? new RegExp(`\\bP${gdSame.part}\\b`).test(titleForMedia) : true;
      if (!hasS && !hasP) {
        titleForMedia = `${titleForMedia} S${gdSame.season}${gdSame.part ? ` P${gdSame.part}` : ''}`;
      } else if (hasS && !hasP) {
        titleForMedia = `${titleForMedia} P${gdSame.part}`;
      }
    }
    cap = titleForMedia || cleanCaption(fileName);
    capWithEp = titleForMedia ? `${cap} — ${seasonEpLabel}` : `${cap}`;
    const cacheInfo = { urlHash: hashUrl(url), source: 'gdrive', fileName };
    rp = await new _ctx.RichProgress(chatId, cap, [{ ep: capWithEp }]).start();
    rp.updateEpisode(capWithEp, 'download');
    outPath = tempPath(fileName);
    await downloadWithAria2c(gd.url, outPath, (log) => {
      if (log.includes('progress:')) rp.updateEpisode(capWithEp, 'download', log.split('progress: ')[1]);
      else if (log.startsWith('DL:')) rp.updateEpisode(capWithEp, 'download', log);
    }, { 'Referer': 'https://drive.google.com/', 'Cookie': 'RU=1' }, gd.size);
    const finalSize = fileSizeMb(outPath);
    logger.info({ chatId, file: fileName, sizeMb: finalSize.toFixed(1) }, 'Google Drive download selesai');
    rp.updateEpisode(capWithEp, 'upload', `${finalSize.toFixed(1)} MB`);
    const info = await getVideoInfo(outPath).catch(() => ({}));
    const fext = path.extname(outPath).toLowerCase();
    // mkv/webm/mov dari Google Drive → remux ke mp4 (lossless, preview/streaming aman)
    if (fext === '.mkv' || fext === '.webm' || fext === '.mov') {
      rp.updateEpisode(capWithEp, 'merge', 'remux mkv→mp4...');
      outPath = await remuxToMp4(outPath, () => rp.updateEpisode(capWithEp, 'merge', 'remux mkv→mp4 done'));
    }
    let finalCap = cap;
    if (gdSame) {
      const gdTitle = titleForMedia || cap;
      finalCap = [
        `➧ Judul :- ${gdTitle}`,
        gdSame.season
          ? `➧ Season :- ${gdSame.season}${gdSame.part ? ` Part ${gdSame.part}` : ''} Episode ${gdSame.episode}`
          : `➧ Episode :- ${gdSame.episode}`,
        `➧ Provider :- samehadaku`,
      ].join('\n');
    } else if (title) {
      // Google Drive Samehadaku (Movie, tanpa -S/-P): provider samehadaku, bukan extractProvider (yang ambil tssdkmgnokh)
      const gdProv = /SAMEHADAKU/i.test(fileName) ? 'samehadaku' : extractProvider(fileName);
      finalCap = [
        `➧ Judul :- ${title}`,
        `➧ Episode :- ${extractPartFromFilename(fileName)}`,
        `➧ Provider :- ${gdProv}`,
      ].join('\n');
    }
    let sendResult = null;
    sendResult = await _ctx.sendAnimeMedia(chatId, outPath, {
        caption: finalCap,
        supports_streaming: true,
        ...(info.duration && { duration: info.duration }),
        ...(info.width && { width: info.width }),
        ...(info.height && { height: info.height }),
      }, cacheInfo);
    if (titleForMedia && sendResult?.video?.file_id && (await getSetting('libsimpan')) === 'on') {
      const slug = `anime:${sanitizeSlug(titleForMedia)}`;
      const epNum = gdSame?.episode ?? extractPartFromFilename(fileName);
      const existing = await getPartFileId(slug, epNum);
      if (!existing) {
        await upsertMedia(slug, titleForMedia, 0, url, sourcePattern);
        await savePartFileId(slug, epNum, sendResult.video.file_id, Math.round(finalSize * 1024 * 1024), fileName, finalCap);
      }
    }
    rp.updateEpisode(capWithEp, 'done', `${finalSize.toFixed(1)} MB`);
    rp.done();
  } catch (err) {
    logger.error({ chatId, url: url.slice(0, 90), err: err.message }, 'Google Drive gagal');
    if (rp) {
      rp.updateEpisode(capWithEp || cap || 'file', 'fail', err.message.slice(0, 50));
      rp.done().catch(() => {});
    }
  } finally {
    cleanupFiles(outPath);
  }
}

async function downloadSamehadakuFile(chatId, episodeUrl, server, servers, sameInfo, opts = {}) {
  const titleArg = sameInfo
    ? `${sameInfo.title}${sameInfo.season ? ` S${sameInfo.season}` : ''}${sameInfo.part ? ` P${sameInfo.part}` : ''}`
    : null;
  // silent=true dipakai loop batch: status cukup di tabel RichProgress, hindari spam pesan per-ep.
  const silent = !!opts.silent;
  const epTag = sameInfo?.episode ? ` Ep ${sameInfo.episode}` : '';
  const backKb = { inline_keyboard: [[{ text: '⬅️ Kembali ke pilihan server', callback_data: `sam_ep:${sameInfo ? cacheUrl(episodeUrl) : 'x'}` }]] };
  const url = servers?.[server];
  if (!url) {
    if (!silent) await _ctx.bot.sendMessage(chatId, `⚠️ Server ${server}${epTag} tidak tersedia utk episode ini.`, { reply_markup: backKb }).catch(() => {});
    return { ok: false, error: `server ${server} tidak tersedia` };
  }
  // Konteks samehadaku utk leaf handler (gofile/pixeldrain/filedon): caption → Provider samehadaku.
  // Di flow manual sudah di-set di sam_go; batch tidak → diset di sini agar identik.
  if (sameInfo) _ctx.samehadakuEpisodeMap?.set(url, sameInfo);
  const prevQuiet = _samQuiet;
  _samQuiet = silent;
  try {
    if (isGofileUrl(url)) return await handleGofileUrl(chatId, url, titleArg);
    if (isPixeldrainUrl(url)) return await handlePixeldrainUrl(chatId, url, titleArg, sameInfo?.episode);
    if (isFiledonUrl(url)) return await handleFiledonUrl(chatId, url, titleArg, sameInfo?.episode);
    if (isGdrivePlayerUrl(url)) {
      const gp = await resolveGdrivePlayerFile(url);
      const gpBase = gp.fileName || `gdriveplayer_${Date.now()}`;
      const gpName = /\.ts$/i.test(gpBase) ? gpBase : `${gpBase}.ts`;
      const gpSame = parseSamehadakuFilename(gpName);
      const gpPart = sameInfo?.episode ?? gpSame?.episode ?? extractPartFromFilename(gpName);
      const gpMismatch = partMismatch(sameInfo?.episode, gpPart);
      if (gpMismatch) {
        if (!silent) await _ctx.bot.sendMessage(chatId, `⚠️ GDrivePlayer utk Ep ${sameInfo?.episode} menunjuk file salah (${gpName}).\n${gpMismatch}\nPakai server lain.`).catch(() => {});
        return { ok: false, error: gpMismatch };
      }
      const gpTitle = titleArg || cleanCaption(gpName);
      const gpCap = titleArg
        ? [
            `➧ Judul :- ${titleArg}`,
            gpSame?.season
              ? `➧ Season :- ${gpSame.season}${gpSame.part ? ` Part ${gpSame.part}` : ''} Episode ${gpPart}`
              : `➧ Episode :- ${gpPart}`,
            `➧ Provider :- samehadaku`,
          ].join('\n')
        : gpTitle;
      const gpCacheInfo = { urlHash: hashUrl(url), source: 'gdriveplayer', fileName: gpName };
      // batch: tanpa sub-progress per-ep (cukup tabel batch utama di bot.js)
      const rp = _samQuiet ? noopRp() : await new _ctx.RichProgress(chatId, gpTitle, [{ ep: titleArg ? `${gpTitle} — Episode ${gpPart}` : gpTitle }]).start();
      let outPath = tempPath(gpName);
      try {
        rp.updateEpisode(titleArg ? `${gpTitle} — Episode ${gpPart}` : gpTitle, 'download');
        await downloadWithAria2c(gp.fileUrl, outPath, (log) => {
          if (log.includes('progress:')) rp.updateEpisode(titleArg ? `${gpTitle} — Episode ${gpPart}` : gpTitle, 'download', log.split('progress: ')[1]);
          else if (log.startsWith('DL:')) rp.updateEpisode(titleArg ? `${gpTitle} — Episode ${gpPart}` : gpTitle, 'download', log);
        }, { 'User-Agent': GPLAYER_UA, 'Referer': GPLAYER_REF, ...(gp.cookies ? { 'Cookie': gp.cookies } : {}) });
        // remux ts → mp4 utk iOS/Safari (gdriveplayer serve .ts MPEG-TS)
        logger.info({ chatId, file: gpName, ext: path.extname(outPath) }, 'GDrivePlayer remux start');
        if (/\.ts$/i.test(outPath)) outPath = await remuxToMp4(outPath, (m) => logger.info({ chatId }, `GDrivePlayer remux: ${m}`));
        logger.info({ chatId, outExt: path.extname(outPath), outSize: fileSizeMb(outPath).toFixed(1) }, 'GDrivePlayer remux done');
        const gpSizeMb = fileSizeMb(outPath);
        logger.info({ chatId, file: gpName, sizeMb: gpSizeMb.toFixed(1) }, 'GDrivePlayer download selesai');
        if (gpSizeMb > _ctx.config.MAX_UPLOAD_MB) {
          rp.updateEpisode(titleArg ? `${gpTitle} — Episode ${gpPart}` : gpTitle, 'fail', `${gpSizeMb.toFixed(1)} MB > limit`);
          return { ok: false, error: `${gpSizeMb.toFixed(1)} MB > limit` };
        }
        rp.updateEpisode(titleArg ? `${gpTitle} — Episode ${gpPart}` : gpTitle, 'upload', `${gpSizeMb.toFixed(1)} MB`);
        const gpInfo = await getVideoInfo(outPath).catch(() => ({}));
        const sendResult = await _ctx.sendAnimeMedia(chatId, outPath, {
          caption: gpCap, supports_streaming: true,
          ...(gpInfo.duration && { duration: gpInfo.duration }),
          ...(gpInfo.width && { width: gpInfo.width }),
          ...(gpInfo.height && { height: gpInfo.height }),
        }, gpCacheInfo);
        if (titleArg && sendResult?.video?.file_id && (await getSetting('libsimpan')) === 'on') {
          const cleanTitle = titleArg.replace(/\s*(?:Episode|Ep|Part|E)\s*\d+\s*/gi, ' ').trim();
          const slug = `anime:${sanitizeSlug(cleanTitle || titleArg)}`;
          const existing = await getPartFileId(slug, gpPart);
          if (!existing) {
            await upsertMedia(slug, cleanTitle || titleArg, 0, url, extractSourcePattern(gpName));
            await savePartFileId(slug, gpPart, sendResult.video.file_id, Math.round(gpSizeMb * 1024 * 1024), gpName, gpCap);
          }
        }
        rp.updateEpisode(titleArg ? `${gpTitle} — Episode ${gpPart}` : gpTitle, 'done', `${gpSizeMb.toFixed(1)} MB`);
        rp.done();
        return { ok: true, file: gpName, sizeMb: gpSizeMb, part: gpPart };
      } catch (err) {
        logger.error({ chatId, file: gpName, err: err.message }, 'GDrivePlayer gagal');
        rp.updateEpisode(titleArg ? `${gpTitle} — Episode ${gpPart}` : gpTitle, 'fail', err.message.slice(0, 30));
        rp.done().catch(() => {});
        if (!silent) await _ctx.bot.sendMessage(chatId, `⚠️ GDrivePlayer${epTag} gagal: ${err.message.slice(0, 120)}\nServer GDrivePlayer lambat/error — ulangi lagi nanti ⏳, atau pilih host lain dari ⬅️ pilihan server.`, { reply_markup: backKb }).catch(() => {});
        return { ok: false, error: err.message };
      } finally {
        cleanupFiles(outPath);
      }
      return { ok: false, error: 'unsupported path' };
    }
    if (!silent) await _ctx.bot.sendMessage(chatId, `⚠️ Server ${server}${epTag} belum didukung langsung. Coba server lain:`, { reply_markup: backKb }).catch(() => {});
    return { ok: false, error: `server ${server} belum didukung` };
  } catch (err) {
    logger.warn({ server, episode: sameInfo?.episode ?? null, err: err.message }, 'sam server gagal');
    if (!silent) await _ctx.bot.sendMessage(chatId, `⚠️ ${server}${epTag} gagal (${err.message.slice(0, 80)})\n\nKlik ⬅️ Kembali ke pilihan server utk coba server lain.`, { reply_markup: backKb }).catch(() => {});
    return { ok: false, error: err.message };
  } finally {
    _samQuiet = prevQuiet;
  }
}

// ─── Kuronime single-file (gofile/pixeldrain) ────────────────────────────────
// kurInfo = { title, episode } dari providers/kuronime.js. Caption seragam via
// leaf handler (customTitle + part dari nama file): ➧ Judul / ➧ Episode / ➧ Provider :- kuronime.
async function downloadKuronimeFile(chatId, episodeUrl, server, servers, kurInfo, opts = {}) {
  const titleArg = kurInfo?.title || null;
  const silent = !!opts.silent;
  const epTag = kurInfo?.episode ? ` Ep ${kurInfo.episode}` : '';
  const backKb = { inline_keyboard: [[{ text: '⬅️ Kembali ke pilihan server', callback_data: `kur_ep:${kurInfo ? cacheUrl(episodeUrl) : 'x'}` }]] };
  const url = servers?.[server];
  if (!url) {
    if (!silent) await _ctx.bot.sendMessage(chatId, `⚠️ Server ${server}${epTag} tidak tersedia utk episode ini.`, { reply_markup: backKb }).catch(() => {});
    return { ok: false, error: `server ${server} tidak tersedia` };
  }
  const prevQuiet = _samQuiet;
  _samQuiet = silent;
  try {
    if (isGofileUrl(url)) return await handleGofileUrl(chatId, url, titleArg);
    if (isPixeldrainUrl(url)) return await handlePixeldrainUrl(chatId, url, titleArg, kurInfo?.episode);
    if (!silent) await _ctx.bot.sendMessage(chatId, `⚠️ Server ${server}${epTag} belum didukung langsung. Coba server lain:`, { reply_markup: backKb }).catch(() => {});
    return { ok: false, error: `server ${server} belum didukung` };
  } catch (err) {
    logger.warn({ server, episode: kurInfo?.episode ?? null, err: err.message }, 'kur server gagal');
    if (!silent) await _ctx.bot.sendMessage(chatId, `⚠️ ${server}${epTag} gagal (${err.message.slice(0, 80)})\n\nKlik ⬅️ Kembali ke pilihan server utk coba server lain.`, { reply_markup: backKb }).catch(() => {});
    return { ok: false, error: err.message };
  } finally {
    _samQuiet = prevQuiet;
  }
}

// Urutan prioritas server utk batch "Download Semua" (yang didukung langsung).
const SERVER_PRIORITY = ['gofile', 'filedon', 'pixeldrain', 'gdriveplayer'];
// Guard anti-file-salah: situs Samehadaku kadang nunjuk file episode lain utk sebuah ep.
// expectedEp = nomor episode yang diminta; gotPart = nomor episode dari nama file server.
function partMismatch(expectedEp, gotPart) {
  const want = Number(expectedEp);
  const got = Number(gotPart);
  if (want > 0 && got > 0 && got !== want) return `file server keliru: Ep ${got} (link Ep ${want})`;
  return null;
}
function pickBestServerList(servers = {}) {
  return SERVER_PRIORITY.filter((name) => servers[name]);
}
function pickBestServer(servers = {}) {
  return pickBestServerList(servers)[0] || null;
}
const SAM_BATCH_PACE_MS = Number(process.env.SAM_BATCH_PACE_MS) || 1000;

module.exports = { initDownload, handleGofileUrl, handleGofileBatch, handleUcDriveUrl, handlePixeldrainUrl, handleFiledonUrl, handleGdriveUrl, handleMegaUrl, downloadSamehadakuFile, downloadKuronimeFile, pickBestServer, pickBestServerList, partMismatch, SAM_BATCH_PACE_MS, leafAlertTest: { setQuiet: (v) => { _samQuiet = !!v; }, alert: leafAlert } };
