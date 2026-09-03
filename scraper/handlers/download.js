// handlers/download.js — E4a GoFile family (ctx injection, no require ../bot)
const path = require('path');
const { logger } = require('../logger');
const { isGofileUrl, isGofileDirectUrl, filenameFromGofileUrl, resolveGofileFirstFile } = require('../gofile');
const { downloadWithAria2c, fileSizeMb, getVideoInfo, cleanupFiles, tempPath } = require('../downloader');
const { cleanCaption, parseKuronimeSeasonEpisode, extractPartFromFilename, sanitizeSlug, extractSourcePattern, extractProvider, parseSamehadakuFilename } = require('../lib/parser');
const { detectTitleFromFilename } = require('../lib/titleDetect');

// sendVideo/sendAudio/sendDocument injected via ctx (masih di bot.js, belum E3)
const { getPartFileId, savePartFileId, upsertMedia, getSetting } = require('../db');

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm']);
const AUDIO_EXTS = new Set(['.mp3', '.aac', '.ogg', '.m4a', '.wav']);

function hashUrl(url) {
  return require('crypto').createHash('md5').update(url).digest('hex');
}

// ctx: { bot, config: { MAX_UPLOAD_MB }, samehadakuEpisodeMap }
let _ctx = null;
function initDownload(ctx) {
  _ctx = ctx;
}
function ensureCtx(caller) {
  if (!_ctx || !_ctx.bot) throw new Error(`handlers/download belum di-init — panggil initDownload({ bot, config, samehadakuEpisodeMap, ... }) dulu (dari ${caller})`);
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
    const fileName = filenameFromGofileUrl(url);

    if (!customTitle) {
      const { title } = await detectTitleFromFilename(fileName);
      if (title) customTitle = title;
    }

    const cap = customTitle || cleanCaption(fileName);
    const goPartInit = sami?.episode ?? parseSamehadakuFilename(fileName)?.episode ?? extractPartFromFilename(fileName);
    const capWithEp = customTitle ? `${cap} — Episode ${goPartInit}` : cap;
    const cacheInfo = { urlHash, source: 'gofile', fileName };
    const rp = await new _ctx.RichProgress(chatId, cap, [{ ep: capWithEp }]).start();
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
        return;
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
          if (sami.season) {
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

      if (VIDEO_EXTS.has(ext)) {
        sendResult = await _ctx.sendVideo(chatId, outPath, {
          caption: finalCap,
          supports_streaming: true,
          ...(info.duration && { duration: info.duration }),
          ...(info.width && { width: info.width }),
          ...(info.height && { height: info.height }),
        }, cacheInfo);
      } else if (AUDIO_EXTS.has(ext)) {
        await _ctx.sendAudio(chatId, outPath, { caption: finalCap }, cacheInfo);
      } else {
        await _ctx.sendDocument(chatId, outPath, { caption: finalCap }, cacheInfo);
      }
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
    } finally {
      cleanupFiles(outPath);
    }
    return;
  }

  let outPath = null;
  let cap = '';
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
    const capWithEp = customTitle ? `${cap} — Episode ${sami?.episode ?? parseSamehadakuFilename(file.name)?.episode ?? extractPartFromFilename(file.name)}` : cap;
    rp = await new _ctx.RichProgress(chatId, cap, [{ ep: capWithEp }]).start();

    if (file.size / 1024 / 1024 > _ctx.config.MAX_UPLOAD_MB) {
      rp.updateEpisode(capWithEp, 'fail', `${sizeMb} MB > limit`);
      rp.done();
      return;
    }

    const ext = path.extname(file.name) || '';
    outPath = tempPath(`gofile_${Date.now()}${ext}`);

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

    if (VIDEO_EXTS.has(fext)) {
      sendResult = await _ctx.sendVideo(chatId, outPath, {
        caption: finalCap,
        supports_streaming: true,
        ...(info.duration && { duration: info.duration }),
        ...(info.width && { width: info.width }),
        ...(info.height && { height: info.height }),
      }, cacheInfo);
    } else if (AUDIO_EXTS.has(fext)) {
      await _ctx.sendAudio(chatId, outPath, { caption: finalCap }, cacheInfo);
    } else {
      await _ctx.sendDocument(chatId, outPath, { caption: finalCap }, cacheInfo);
    }
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
      if (VIDEO_EXTS.has(ext)) {
        await _ctx.sendVideo(chatId, outPath, {
          caption,
          supports_streaming: true,
          ...(info.duration && { duration: info.duration }),
          ...(info.width && { width: info.width }),
          ...(info.height && { height: info.height }),
        }, cacheInfo);
      } else if (AUDIO_EXTS.has(ext)) {
        await _ctx.sendAudio(chatId, outPath, { caption }, cacheInfo);
      } else {
        await _ctx.sendDocument(chatId, outPath, { caption }, cacheInfo);
      }
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

module.exports = { initDownload, handleGofileUrl, handleGofileBatch };
