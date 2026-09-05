// handlers/vidara.js — E5b: 4 vidara actions + helpers (ctx injection, no require ../bot)
const path = require('path');
const fs = require('fs');
const { logger } = require('../logger');
const { getVideoUrl, destroySession } = require('../index');
const { getVideoUrlReelFren } = require('../providers/reelfren');
const { getVidaraActiveDomain, saveVidaraUpload } = require('../db');
const { ensureMp4, uploadDramaBatchesVidara, ffmpegConcat } = require('../services/vidaraService');
const { fileSizeMb, getVideoInfo } = require('../downloader');
const V = require('../vidara-uploader');

// ctx: { bot, logger, config: { MAX_UPLOAD_MB }, vidaraBusy, sendVideo, Progress, RichProgress, downloadAndSend }
let _ctx = null;
function initVidara(ctx) {
  _ctx = ctx;
}
function ensureCtx(caller) {
  if (!_ctx || !_ctx.bot) throw new Error(`handlers/vidara belum di-init — panggil initVidara({ bot, ... }) dulu (dari ${caller})`);
}

function pad(n) { return String(n).padStart(2, '0'); }

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

const PART_SEND_DELAY_MS = Number(process.env.PART_SEND_DELAY_MS) || 8000;
const RF_GROUP_ID = process.env.RF_GROUP_ID ? Number(process.env.RF_GROUP_ID) : null;
const RF_GROUP_ENABLED = (process.env.RF_GROUP_ENABLED || 'false') === 'true';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildResolveVideoUrl(session) {
  const { subdomain, id, slug, lang } = session;
  const isReelFren = subdomain.startsWith('reelfren_');
  if (isReelFren) {
    const provider = subdomain.replace('reelfren_', '');
    return (epObj) => getVideoUrlReelFren(provider, id, epObj.urlEp ?? epObj.ep, lang).then(r => r.videoUrl);
  }
  return (epObj) => getVideoUrl(subdomain, id, slug, epObj.urlEp ?? epObj.ep, 1, lang).then(r => r.videoUrl);
}

async function actionVidaraPerEp(chatId, session) {
  ensureCtx('actionVidaraPerEp');
  if (!V.VIDARA_KEY) return _ctx.bot.sendMessage(chatId, '⚠️ <code>VIDARA_API</code> belum diset.', { parse_mode: 'HTML' });

  const { subdomain, id, episodes, meta } = session;
  const providerLabel = subdomain.replace(/^reelfren_/, '');
  const dramaKey = `${providerLabel}:${id}`;
  const title = meta?.title || id;
  const resolveVideoUrl = buildResolveVideoUrl(session);
  const workDir = path.join(V.DOWNLOADS, 'tmp', `vidper_${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  _ctx.vidaraBusy.set(String(chatId), true);
  const p = await new _ctx.Progress(chatId, `Upload Vidara — ${episodes.length} episode`).start();
  try {
    const saveDomain = (await getVidaraActiveDomain()) || V.VIDARA_DOMAIN || process.env.VIDARA_DOMAIN || 'vidara.so';
    const filecodes = {};
    let done = 0, fail = 0;
    for (let i = 0; i < episodes.length; i++) {
      const epObj = episodes[i];
      const epStr = String(epObj.ep).padStart(2, '0');
      p.update(`[${i + 1}/${episodes.length}] Ep ${epStr} — download`);
      try {
        const url = await resolveVideoUrl(epObj);
        if (!url) throw new Error('video URL kosong');
        const dest = path.join(workDir, `ep${epStr}.mp4`);
        await ensureMp4(url, dest, { resolveFresh: () => resolveVideoUrl(epObj), logCtx: { chatId, ep: epStr } });
        p.update(`[${i + 1}/${episodes.length}] Ep ${epStr} — upload`);
        const fc = await V.uploadFileViaCurl(dest);
        filecodes[epStr] = fc;
        done++;
        // Simpan ke DB vidara_uploads (untuk web + ganti-link)
        saveVidaraUpload(dramaKey, Number(epStr) || 0, fc, saveDomain, title).catch(() => {});
      } catch (e) {
        fail++;
        logger.error({ chatId, ep: epStr, err: e.message }, 'Vidara per-ep fail');
      }
    }
    await p.done(`${done}/${episodes.length} episode ter-upload ke Vidara`);
    const vdom = V.VIDARA_DOMAIN || 'vidara.so';
    const lines = Object.entries(filecodes).slice(0, 20).map(([ep, fc]) => `Ep ${ep}: <code>https://${vdom}/e/${fc}</code>`);
    await _ctx.bot.sendMessage(chatId, `📤 <b>${title}</b>\n✅ ${done} ok · ❌ ${fail} gagal\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  } catch (err) {
    await p.fail(`Error: ${err.message.slice(0, 100)}`);
  } finally {
    _ctx.vidaraBusy.delete(String(chatId));
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

async function actionVidaraMerge10(chatId, session) {
  ensureCtx('actionVidaraMerge10');
  if (!V.VIDARA_KEY) return _ctx.bot.sendMessage(chatId, '⚠️ <code>VIDARA_API</code> belum diset.', { parse_mode: 'HTML' });

  const { subdomain, id, episodes, meta } = session;
  const providerLabel = subdomain.replace(/^reelfren_/, '');
  const dramaKey = `${providerLabel}:${id}`;
  const title = meta?.title || id;
  const resolveVideoUrl = buildResolveVideoUrl(session);

  _ctx.vidaraBusy.set(String(chatId), true);
  const p = await new _ctx.Progress(chatId, `Upload Vidara — batch 10`).start();
  try {
    const result = await uploadDramaBatchesVidara({
      dramaKey, title, subdomain: providerLabel, providerLabel, episodes, resolveVideoUrl,
      batchSize: 10, workers: 3,
      onBatch: (label, status, data, i, total) => {
        const defs = { download: '⬇️ download', concat: '🔗 concat', upload: '⬆️ upload', ok: `✅ ${data?.filecode || ''}`, skip: '⏭️ skip', fail: `❌ ${(data || '').toString().slice(0, 60)}` };
        p.update(`[${i}/${total}] Batch ${label} — ${defs[status] || status}`);
      },
    });
    // Simpan ke DB vidara_uploads (untuk web + ganti-link nanti)
    if (result.files) {
      const saveDomain = (await getVidaraActiveDomain()) || V.VIDARA_DOMAIN || process.env.VIDARA_DOMAIN || 'vidara.so';
      for (const [label, fc] of Object.entries(result.files)) {
        const [s, e] = String(label).split('-').map((x) => parseInt(x, 10));
        if (!Number.isNaN(s) && !Number.isNaN(e)) {
          for (let ep = s; ep <= e; ep++) saveVidaraUpload(dramaKey, ep, fc, saveDomain, title).catch(() => {});
        }
      }
    }
    await p.done(`${result.done}/${result.total} batch ter-upload ke Vidara (${result.epsCount} episode)`);
    const vdom = V.VIDARA_DOMAIN || 'vidara.so';
    const lines = Object.entries(result.files).map(([label, fc]) => `Ep ${label}: <code>https://${vdom}/e/${fc}</code>`);
    await _ctx.bot.sendMessage(chatId, `📤 <b>${title}</b>\n✅ ${result.done} batch · ❌ ${result.fail} gagal\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  } catch (err) {
    await p.fail(`Error: ${err.message.slice(0, 100)}`);
  } finally {
    _ctx.vidaraBusy.delete(String(chatId));
  }
}

// ─── Aksi: Vidara + Telegram (download sekali, upload keduanya, baru cleanup) ──

async function actionVidaraAndTelegramMerge10(chatId, session) {
  ensureCtx('actionVidaraAndTelegramMerge10');
  if (!V.VIDARA_KEY) return _ctx.bot.sendMessage(chatId, '⚠️ <code>VIDARA_API</code> belum diset.', { parse_mode: 'HTML' });

  const { subdomain, id, slug, lang, episodes, meta } = session;
  const providerLabel = subdomain.replace(/^reelfren_/, '');
  const dramaKey = `${providerLabel}:${id}`;
  const title = meta?.title || id;
  const resolveVideoUrl = buildResolveVideoUrl(session);
  const saveDomain = (await getVidaraActiveDomain()) || V.VIDARA_DOMAIN || process.env.VIDARA_DOMAIN || 'vidara.so';
  const chunks = buildChunks(episodes, 10, 6);
  const workDir = path.join(V.DOWNLOADS, 'tmp', `vtmerge_${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });
  const isReelFren = subdomain.startsWith('reelfren_');
  const provider = isReelFren ? providerLabel : null;

  _ctx.vidaraBusy.set(String(chatId), true);
  const rp = await new _ctx.RichProgress(chatId, title, chunks.map((chunk, i) => ({
    ep: i + 1, label: `Part ${i + 1} (Ep ${chunk[0].ep}–${chunk[chunk.length - 1].ep})`,
  })), { isParts: true }).start();
  rp.totalEpisodes = episodes.length;

  let vidDone = 0, vidFail = 0, tgDone = 0, tgFail = 0;
  const vidFiles = {};

  try {
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const epStart = chunk[0].ep;
      const epEnd = chunk[chunk.length - 1].ep;
      const partLabel = `Part ${ci + 1} (Ep ${epStart}–${epEnd})`;
      const batchWorkDir = path.join(workDir, `batch_${ci + 1}`);
      fs.mkdirSync(batchWorkDir, { recursive: true });

      try {
        // 1. Download semua episode dalam batch
        rp.updateLabel(partLabel, 'download', `0/${chunk.length}`);
        const epFiles = [];
        for (let j = 0; j < chunk.length; j++) {
          const epObj = chunk[j];
          const url = await resolveVideoUrl(epObj);
          if (!url) throw new Error(`video URL kosong Ep ${epObj.ep}`);
          const dest = path.join(batchWorkDir, `ep${String(epObj.ep).padStart(2, '0')}.mp4`);
          await ensureMp4(url, dest, { resolveFresh: () => resolveVideoUrl(epObj), logCtx: { chatId, ep: epObj.ep } });
          epFiles.push(dest);
          rp.updateLabel(partLabel, 'download', `${j + 1}/${chunk.length}`);
        }

        // 2. Concat jadi 1 file
        rp.updateLabel(partLabel, 'concat', 'gabungkan...');
        const mergedFile = path.join(batchWorkDir, `${title} — ${partLabel}.mp4`);
        await ffmpegConcat(epFiles, mergedFile);
        const sizeMb = fileSizeMb(mergedFile);

        // 3. Upload ke Vidara
        rp.updateLabel(partLabel, 'upload', 'Vidara...');
        try {
          const fc = await V.uploadFileViaCurl(mergedFile);
          vidFiles[`${pad(epStart)}-${pad(epEnd)}`] = fc;
          vidDone++;
          // Simpan ke DB vidara_uploads (untuk web + ganti-link)
          for (let ep = epStart; ep <= epEnd; ep++) saveVidaraUpload(dramaKey, ep, fc, saveDomain, title).catch(() => {});
        } catch (e) {
          vidFail++;
          logger.error({ chatId, part: partLabel, err: e.message }, 'Vidara upload fail');
        }

        // 4. Kirim ke Telegram (file yang SAMA)
        rp.updateLabel(partLabel, 'send', 'Telegram...');
        const info = await getVideoInfo(mergedFile).catch(() => ({}));
        const options = {
          caption: [
            `➧ Judul :- <b>${session?.meta?.title || (slug ? slug.replace(/-/g, ' ') : providerLabel)}</b>`,
            `➧ Episode/Part :- <b>${partLabel}</b>`,
            `➧ Provider :- <tg-spoiler>${providerLabel}</tg-spoiler>`,
          ].join('\n'),
          parse_mode: 'HTML',
          supports_streaming: true,
          ...(info.duration && { duration: info.duration }),
          ...(info.width && { width: info.width }),
          ...(info.height && { height: info.height }),
        };
        const mirrorToTopic = isReelFren
          && _ctx.isAdmin?.(session?.userId)
          && RF_GROUP_ENABLED
          && RF_GROUP_ID;
        if (sizeMb > _ctx.config.MAX_UPLOAD_MB) {
          rp.note(`⚠️ ${partLabel}: ${sizeMb.toFixed(1)} MB > limit Telegram (${_ctx.config.MAX_UPLOAD_MB}) — hanya upload ke Vidara`);
          logger.warn({ chatId, part: partLabel, sizeMb: sizeMb.toFixed(1), limit: _ctx.config.MAX_UPLOAD_MB }, 'vt_merge10 part skipped Telegram — exceeds limit');
          tgFail++;
        } else {
          try {
            if (mirrorToTopic) {
              const sendResult = await _ctx.sendToTopicVideo(provider, mergedFile, options);
              if (sendResult) {
                tgDone++;
                rp.note(`📤 ${partLabel} — terkirim ke topic <b>${provider}</b> di grup`);
              } else {
                await _ctx.sendVideo(chatId, mergedFile, options);
                tgDone++;
              }
            } else {
              await _ctx.sendVideo(chatId, mergedFile, options);
              tgDone++;
            }
          } catch (e) {
            tgFail++;
            logger.error({ chatId, part: partLabel, err: e.message }, 'Telegram send fail');
          }
        }

        rp.updateLabel(partLabel, 'done', `${sizeMb.toFixed(1)} MB`);
      } catch (e) {
        rp.updateLabel(partLabel, 'fail', e.message.slice(0, 40));
        rp.note(`❌ ${partLabel}: ${e.message.slice(0, 80)}`);
        logger.error({ chatId, part: partLabel, err: e.message }, 'Batch vt_merge10 fail');
      } finally {
        // 5. Cleanup batch ini
        try { fs.rmSync(batchWorkDir, { recursive: true, force: true }); } catch {}
      }

      if (ci < chunks.length - 1 && _ctx.config.PART_SEND_DELAY_MS > 0) await sleep(_ctx.config.PART_SEND_DELAY_MS);
    }

    await rp.done();

    // Summary
    const vdom = V.VIDARA_DOMAIN || 'vidara.so';
    const vidLines = Object.entries(vidFiles).map(([label, fc]) => `Ep ${label}: <code>https://${vdom}/e/${fc}</code>`);
    await _ctx.bot.sendMessage(chatId, `📤 <b>${title}</b> — Vidara + Telegram selesai\n✅ Vidara: ${vidDone} batch · ❌ ${vidFail}\n✅ Telegram: ${tgDone} batch · ❌ ${tgFail}\n\n${vidLines.join('\n')}`, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error({ chatId, err: err.message }, 'vt_merge10 outer error');
    rp.note(`❌ Error: ${err.message.slice(0, 80)}`);
    await rp.done();
  } finally {
    _ctx.vidaraBusy.delete(String(chatId));
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    await destroySession();
  }
}

async function actionVidaraAndTelegramPerEp(chatId, session) {
  ensureCtx('actionVidaraAndTelegramPerEp');
  if (!V.VIDARA_KEY) return _ctx.bot.sendMessage(chatId, '⚠️ <code>VIDARA_API</code> belum diset.', { parse_mode: 'HTML' });

  const { subdomain, id, slug, lang, episodes, meta } = session;
  const providerLabel = subdomain.replace(/^reelfren_/, '');
  const dramaKey = `${providerLabel}:${id}`;
  const title = meta?.title || id;
  const resolveVideoUrl = buildResolveVideoUrl(session);
  const workDir = path.join(V.DOWNLOADS, 'tmp', `vtper_${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  _ctx.vidaraBusy.set(String(chatId), true);
  const p = await new _ctx.Progress(chatId, `Vidara + Telegram — ${episodes.length} episode`).start();
  try {
    // Download + upload Vidara + send Telegram per episode
    for (let i = 0; i < episodes.length; i++) {
      const epObj = episodes[i];
      const epStr = String(epObj.ep).padStart(2, '0');
      p.update(`[${i + 1}/${episodes.length}] Ep ${epStr} — download`);
      try {
        const url = await resolveVideoUrl(epObj);
        if (!url) throw new Error('video URL kosong');
        const dest = path.join(workDir, `ep${epStr}.mp4`);
        await ensureMp4(url, dest, { resolveFresh: () => resolveVideoUrl(epObj), logCtx: { chatId, ep: epStr } });

        // Upload to Vidara
        p.update(`[${i + 1}/${episodes.length}] Ep ${epStr} — upload Vidara`);
        const fc = await V.uploadFileViaCurl(dest);

        // Send to Telegram (same file)
        p.update(`[${i + 1}/${episodes.length}] Ep ${epStr} — kirim Telegram`);
        await _ctx.downloadAndSend(chatId, subdomain, id, slug, epObj.urlEp, lang, `Ep ${epObj.ep}`);
      } catch (e) {
        logger.error({ chatId, ep: epStr, err: e.message }, 'Vidara+TG per-ep fail');
      }
    }
    await p.done(`${episodes.length} episode selesai (Vidara + Telegram)`);
  } catch (err) {
    await p.fail(`Error: ${err.message.slice(0, 100)}`);
  } finally {
    _ctx.vidaraBusy.delete(String(chatId));
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { initVidara, pad, buildResolveVideoUrl, actionVidaraPerEp, actionVidaraMerge10, actionVidaraAndTelegramMerge10, actionVidaraAndTelegramPerEp };
