// handlers/vidoy.js — aksi upload Vidoy (drama merge-10, anime per-episode)
const path = require('path');
const fs = require('fs');
const { logger } = require('../logger');
const { getVideoUrl } = require('../index');
const { getVideoUrlReelFren } = require('../providers/reelfren');
const { getVidaraActiveDomain, saveVidaraUpload } = require('../db');
const db = require('../db');
const { ensureMp4 } = require('../services/vidaraService');
const vidoyService = require('../services/vidoyService');
const { TMP_DIR, getVideoInfo } = require('../downloader');
const { safeHtml } = require('../lib/html');
const V = require('../vidoy-uploader');
const Vdara = require('../vidara-uploader');

let _ctx = null;
function initVidoy(ctx) {
  _ctx = ctx;
}
function ensureCtx(caller) {
  if (!_ctx || !_ctx.bot) throw new Error(`handlers/vidoy belum di-init — panggil initVidoy({ bot, ... }) dulu (dari ${caller})`);
}

function buildResolveVideoUrl(session) {
  const { subdomain, id, slug, lang } = session;
  if (String(subdomain).startsWith('reelfren_')) {
    const provider = subdomain.replace('reelfren_', '');
    return (epObj) => getVideoUrlReelFren(provider, id, epObj.urlEp ?? epObj.ep, lang).then((r) => r.videoUrl);
  }
  return (epObj) => getVideoUrl(subdomain, id, slug, epObj.urlEp ?? epObj.ep, 1, lang).then((r) => r.videoUrl);
}

function batchStatusLine(status, data) {
  const defs = {
    download: '⬇️ download', concat: '🔗 concat', upload: '⬆️ upload',
    uploadProgress: `⬆️ upload ${data ?? 0}%`,
    ok: '✅ selesai',
    skip: '⏭️ skip — sudah ada',
    redownload: '⬇️ unduh ulang (kirim ke Telegram)',
    fail: `❌ ${String(data || '').slice(0, 60)}`,
  };
  return defs[status] || String(status);
}

function reportLines(title, items) {
  return items.map((it) => (it.error
    ? `Ep ${it.label}: ❌ ${safeHtml(String(it.error).slice(0, 80))}`
    : `Ep ${it.label}: <code>${safeHtml(it.link)}</code>`)).join('\n');
}

async function actionVidoyMerge10(chatId, session) {
  ensureCtx('actionVidoyMerge10');
  if (!V.isConfigured()) {
    return _ctx.bot.sendMessage(chatId, '⚠️ <code>VIDOY_USERNAME</code>/<code>VIDOY_PASSWORD</code> belum diset.', { parse_mode: 'HTML' });
  }
  const { subdomain, id, episodes, meta } = session;
  const providerLabel = String(subdomain).replace(/^reelfren_/, '');
  const mediaKey = `${providerLabel}:${id}`;
  const title = meta?.title || id;
  const busyKey = String(chatId);
  if (_ctx.vidaraBusy.has(busyKey)) {
    return _ctx.bot.sendMessage(chatId, '⚠️ Masih ada proses upload berjalan di chat ini.');
  }
  _ctx.vidaraBusy.set(busyKey, true);
  const workDir = path.join(TMP_DIR, 'vidoy', mediaKey.replace(/[^\w-]+/g, '_'), 'work');
  const p = await new _ctx.Progress(chatId, 'Upload Vidoy — batch 10').start();
  try {
    fs.mkdirSync(workDir, { recursive: true });
    const result = await vidoyService.uploadBatches({
      kind: 'drama', mediaKey, title, episodes,
      resolveVideoUrl: buildResolveVideoUrl(session),
      providerLabel, batchSize: 10, workers: 3, workDir,
      onBatch: (label, status, data, i, total) => {
        p.update(`[${i}/${total}] Batch ${label} — ${batchStatusLine(status, data)}`);
      },
    });
    const folderLine = result.folder && result.folder.url ? `\n📁 Folder: ${safeHtml(result.folder.url)}` : '';
    const skipInfo = result.skipped ? ` · ⏭️ ${result.skipped} dilewati` : '';
    await p.done(`${result.done}/${result.total} batch ter-upload ke Vidoy${skipInfo}${folderLine}`);
    await _ctx.bot.sendMessage(
      chatId,
      `📤 <b>Vidoy — ${safeHtml(title)}</b>\n✅ ${result.done} batch · ⏭️ ${result.skipped || 0} dilewati · ❌ ${result.fail} gagal${folderLine}\n\n${reportLines(title, result.items)}`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    logger.error({ chatId, err: err.message }, 'Vidoy merge10 gagal');
    if (!silent) await p.fail(`Error: ${safeHtml(String(err.message).slice(0, 120))}`);
  } finally {
    _ctx.vidaraBusy.delete(busyKey);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function actionVidoyAndTelegramMerge10(chatId, session) {
  ensureCtx('actionVidoyAndTelegramMerge10');
  if (!V.isConfigured()) {
    return _ctx.bot.sendMessage(chatId, '⚠️ <code>VIDOY_USERNAME</code>/<code>VIDOY_PASSWORD</code> belum diset.', { parse_mode: 'HTML' });
  }
  const { subdomain, id, slug, lang, episodes, meta } = session;
  const providerLabel = String(subdomain).replace(/^reelfren_/, '');
  const mediaKey = `${providerLabel}:${id}`;
  const title = meta?.title || id;
  const busyKey = String(chatId);
  if (_ctx.vidaraBusy.has(busyKey)) {
    return _ctx.bot.sendMessage(chatId, '⚠️ Masih ada proses upload berjalan di chat ini.');
  }
  _ctx.vidaraBusy.set(busyKey, true);
  const baseDir = path.join(TMP_DIR, 'vidoy-tg', mediaKey.replace(/[^\w-]+/g, '_'));
  const workDir = path.join(baseDir, 'work');
  const p = await new _ctx.Progress(chatId, 'Vidoy + Telegram — batch 10').start();
  let tgOk = 0;
  let tgFail = 0;
  try {
    fs.mkdirSync(workDir, { recursive: true });
    const sendTelegram = async (item) => {
      const caption = buildCaption({ title, provider: providerLabel, part: item.part, epStart: item.epStart, epEnd: item.epEnd, link: item.link });
      const vinfo = await getVideoInfo(item.filePath).catch(() => ({}));
      try {
        const mediaOpts = {
          caption, parse_mode: 'HTML', supports_streaming: true,
          ...(vinfo.duration && { duration: vinfo.duration }),
          ...(vinfo.width && { width: vinfo.width }),
          ...(vinfo.height && { height: vinfo.height }),
        };
        const sent = _ctx.sendToTopicVideo
          ? await _ctx.sendToTopicVideo(providerLabel, item.filePath, mediaOpts)
          : await _ctx.sendVideo(chatId, item.filePath, mediaOpts);
        if (!sent) throw new Error('pengiriman tidak menghasilkan hasil (grup/topic tidak aktif?)');
        const msgId = sent.message_id || (sent.result && sent.result.message_id);
        if (msgId) {
          const tgChat = sent.chat && sent.chat.id ? sent.chat.id : chatId;
          await db.setVidoyTelegramPointer(mediaKey, 'drama', item.part, tgChat, msgId).catch(() => {});
          await db.saveVidoyUpload({
            mediaKey, kind: 'drama', part: item.part, epStart: item.epStart, epEnd: item.epEnd,
            title, folderId: item.folderId, folderUrl: item.folderUrl, link: item.link,
            dashboard: item.dashboard, tgChatId: tgChat, tgMessageId: msgId,
            provider: providerLabel, caption,
          }).catch(() => {});
        }
        tgOk++;
        return true;
      } catch (err) {
        tgFail++;
        logger.error({ chatId, ep: item.label, err: err.message }, 'Vidoy+TG kirim Telegram gagal — file ditahan untuk retry');
        return false;
      }
    };
    const result = await vidoyService.uploadBatches({
      kind: 'drama', mediaKey, title, episodes,
      resolveVideoUrl: buildResolveVideoUrl(session),
      providerLabel, batchSize: 10, workers: 3, workDir,
      afterUpload: sendTelegram,
      onBatch: (label, status, data, i, total) => {
        p.update(`[${i}/${total}] Batch ${label} — ${batchStatusLine(status, data)}`);
      },
    });
    const folderLine = result.folder && result.folder.url ? `\n📁 Folder: ${safeHtml(result.folder.url)}` : '';
    const skipInfo = result.skipped ? ` · ⏭️ ${result.skipped} dilewati` : '';
    const pending = result.items.filter((it) => it.telegramPending);
    const resent = result.items.filter((it) => it.tgResent);
    const pendingLine = pending.length
      ? `\n⏳ <b>Menunggu kirim Telegram:</b> ${pending.map((it) => `Ep ${it.label}`).join(', ')} — file ditahan, tekan aksi lagi untuk kirim ulang (tanpa unduh ulang).`
      : '';
    const resentLine = resent.length
      ? `\n♻️ Telegram dilengkapi: ${resent.map((it) => `Ep ${it.label}${it.redownloaded ? ' (unduh ulang)' : ' (file tersimpan)'}`).join(', ')}`
      : '';
    await p.done(`Vidoy ${result.done}/${result.total} batch${skipInfo} · Telegram ${tgOk} ok / ${tgFail} gagal${pending.length ? ' · ⏳ tertunda' : ''}${folderLine}`);
    await _ctx.bot.sendMessage(
      chatId,
      `📤 <b>Vidoy + Telegram — ${safeHtml(title)}</b>\n✅ Vidoy ${result.done} batch · Telegram ${tgOk} terkirim · ⏭️ ${result.skipped || 0} dilewati\n❌ Vidoy gagal ${result.fail} · Telegram gagal ${tgFail}${folderLine}\n\n${reportLines(title, result.items)}${resentLine}${pendingLine}`,
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    logger.error({ chatId, err: err.message }, 'Vidoy+TG merge10 gagal');
    if (!silent) await p.fail(`Error: ${safeHtml(String(err.message).slice(0, 120))}`);
  } finally {
    _ctx.vidaraBusy.delete(busyKey);
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function uploadToVidaraFolder(destPath, title) {
  const filecode = await Vdara.uploadFileViaCurl(destPath);
  await Vdara.renameVideo(filecode, `${title}`).catch(() => {});
  let folderUrl = '';
  try {
    const folderName = Vdara.vidaraFolderName(title, 'anime');
    const fldId = await Vdara.ensureFolder(folderName);
    if (fldId) {
      await Vdara.moveToFolder(filecode, fldId).catch(() => {});
      folderUrl = `${fldId}`;
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Vidara folder gagal — file tetap di root');
  }
  return { filecode, folderUrl };
}

async function actionAnimeEpisode(chatId, opts) {
  ensureCtx('actionAnimeEpisode');
  const { target, title, ep, sameInfo, directUrl, episodeUrl, silent } = opts || {};
  const needVidoy = target === 'vyt' || target === 'vv';
  const needVidara = target === 'vt' || target === 'vv';
  const needTg = target === 'tg' || target === 'vt' || target === 'vyt';
  if (needVidoy && !V.isConfigured()) {
    return silent
      ? { vidoy: null, vidara: null, tg: false, error: 'VIDOY_USERNAME/PASSWORD belum diset' }
      : _ctx.bot.sendMessage(chatId, '⚠️ <code>VIDOY_USERNAME</code>/<code>VIDOY_PASSWORD</code> belum diset.');
  }
  if (needVidara && !Vdara.VIDARA_KEY) {
    return silent
      ? { vidoy: null, vidara: null, tg: false, error: 'VIDARA_API belum diset' }
      : _ctx.bot.sendMessage(chatId, '⚠️ <code>VIDARA_API</code> belum diset.');
  }
  const busyKey = String(chatId);
  // Mode batch (silent) tidak mengambil lock: lock dipegang runner batch agar
  // RichProgress tetap bisaupdate dan tidak bentrok dengan dirinya sendiri.
  if (!silent) {
    if (_ctx.vidaraBusy.has(busyKey)) {
      return _ctx.bot.sendMessage(chatId, '⚠️ Masih ada proses berjalan di chat ini.');
    }
    _ctx.vidaraBusy.set(busyKey, true);
  }
  const outDir = path.join(TMP_DIR, 'anime', String(title || 'anime').replace(/[^\w-]+/g, '_'), `ep${ep}`);
  const p = silent
    ? { update() {}, done: async () => {}, fail: async () => {} }
    : await new _ctx.Progress(chatId, `Anime Ep ${ep} — ${targetLabel(target)}`).start();
  const out = { vidoy: null, vidara: null, tg: false, error: null };
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const destPath = path.join(outDir, `${V.sanitizeFolderName(title || 'Anime')} — Ep ${String(ep).padStart(2, '0')}.mp4`);
    if (!fs.existsSync(destPath)) {
      p.update('⬇️ download');
      const ok = await ensureMp4(directUrl, destPath, { resolveFresh: async () => directUrl });
      if (!ok) throw new Error('gagal mengunduh video');
    }
    if (needVidoy) {
      p.update('📤 upload Vidoy');
      const res = await vidoyService.uploadSingle({
        kind: 'anime', mediaKey: String(title), title: String(title), ep, episodeUrl, outDir,
        onProgress: (pc) => p.update(`📤 upload Vidoy ${pc}%`),
      });
      if (!res.ok) throw new Error(res.error || 'Vidoy upload gagal');
      out.vidoy = res;
      if (res.skipped) out.skipped = true;
    }
    if (needVidara) {
      p.update('📤 upload Vidara');
      const v = await uploadToVidaraFolder(destPath, `${title} — Ep ${ep}`);
      out.vidara = v.filecode;
      if (v.filecode) {
        const domain = (await getVidaraActiveDomain()) || Vdara.VIDARA_DOMAIN || process.env.VIDARA_DOMAIN || 'vidara.so';
        await saveVidaraUpload(String(title), Number(ep) || 0, v.filecode, domain, String(title)).catch(() => {});
      }
    }
    if (needTg) {
      p.update('📤 kirim Telegram');
      const animeProvider = sameInfo?.provider || 'anime';
      const caption = buildCaption({
        title, provider: animeProvider, part: Number(ep) || 0, epStart: Number(ep) || 0, epEnd: Number(ep) || 0,
        link: out.vidoy && out.vidoy.link,
      });
      const vinfo = await getVideoInfo(destPath).catch(() => ({}));
      const sent = await _ctx.sendVideo(chatId, destPath, {
        caption, parse_mode: 'HTML', supports_streaming: true,
        ...(vinfo.duration && { duration: vinfo.duration }),
        ...(vinfo.width && { width: vinfo.width }),
        ...(vinfo.height && { height: vinfo.height }),
      });
      out.tg = true;
      const msgId = sent && (sent.message_id || (sent.result && sent.result.message_id));
      if (msgId && out.vidoy) {
        const num = Number(ep) || 0;
        await db.setVidoyTelegramPointer(String(title), 'anime', num, chatId, msgId).catch(() => {});
        await db.saveVidoyUpload({
          mediaKey: String(title), kind: 'anime', part: num, epStart: num, epEnd: num, title,
          folderId: out.vidoy.folderId, folderUrl: out.vidoy.folderUrl, link: out.vidoy.link,
          dashboard: out.vidoy.dashboard, tgChatId: chatId, tgMessageId: msgId,
          provider: animeProvider, caption,
        }).catch(() => {});
      }
    }
    const parts = [];
    if (out.skipped && out.vidoy) parts.push('📤 Vidoy ⏭️ sudah ada');
    if (out.tg) parts.push('📤 Telegram ✅');
    if (out.vidara) parts.push(`📤 Vidara ✅ <code>${safeHtml(out.vidara)}</code>`);
    if (out.vidoy && !out.vidoy.skipped) parts.push(`📤 Vidoy ✅ <code>${safeHtml(out.vidoy.link)}</code>`);
    if (out.vidoy && out.vidoy.skipped) parts.push(`📤 link <code>${safeHtml(out.vidoy.link)}</code>`);
    if (!silent) await p.done(parts.join(' · ') || 'selesai');
    else out.summary = parts.join(' · ') || 'selesai';
  } catch (err) {
    out.error = err.message;
    logger.error({ chatId, ep, target, err: err.message }, 'Anime episode upload gagal');
    if (!silent) await p.fail(`Error: ${safeHtml(String(err.message).slice(0, 120))}`);
  } finally {
    _ctx.vidaraBusy.delete(busyKey);
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return out;
}

function partEpisodeLabel(part, epStart, epEnd) {
  // Episode tunggal (anime) → "Episode :- N"; batch drama → "Part/Episode :- 1 (Ep 1–10)".
  if (epStart === epEnd) return `Episode :- ${epStart}`;
  const num = Number(part) || 0;
  return num
    ? `Part/Episode :- ${num} (Ep ${epStart}\u2013${epEnd})`
    : `Part/Episode :- Ep ${epStart}\u2013${epEnd}`;
}

function buildCaption({ title, provider, part, epStart, epEnd, link }) {
  return [
    `➧ Judul :- <b>${safeHtml(title)}</b>`,
    `➧ ${partEpisodeLabel(part, epStart, epEnd)}`,
    `➧ Provider :- ${safeHtml(provider || '\u2014')}`,
    ...(link ? [`➧ Link :- <a href="${safeHtml(link)}">${safeHtml(shortLinkLabel(link))}</a>`] : []),
  ].join('\n');
}

function replaceLinkLine(caption, link) {
  const line = `➧ Link :- <a href="${link}">${shortLinkLabel(link)}</a>`;
  const lines = String(caption || '').split('\n');
  const idx = lines.findIndex((l) => l.startsWith('\u27a7 Link :-'));
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  return lines.join('\n');
}

function shortLinkLabel(link) {
  const raw = String(link || '').trim();
  if (!raw) return raw;
  const m = raw.match(/^https?:\/\/([^/\s]+)(\/(?:e|d)\/[A-Za-z0-9_-]+)/);
  // Label memakai domain ASLI link, bukan domain hardcode — supaya teks yang
  // tampil sama persis dengan URL tujuan dan ikut berubah saat domain diganti.
  if (m) return `${m[1]}${m[2]}`;
  const loose = raw.match(/([^/\s]+\.(?:cc|com|tv|asia|net|org|co|xyz|top|site|vip|link|me|io|app|dev|cloud|online|live|world|pro|fun|shop|app))\/(e|d)\/([A-Za-z0-9_-]+)/i);
  return loose ? `${loose[1]}/${loose[2]}/${loose[3]}` : raw;
}

function targetLabel(target) {
  const map = { tg: 'Telegram', vt: 'Vidara + Telegram', vyt: 'Vidoy + Telegram', vv: 'Vidara + Vidoy' };
  return map[target] || String(target || '');
}

module.exports = {
  initVidoy,
  buildCaption,
  replaceLinkLine,
  partEpisodeLabel,
  shortLinkLabel,
  actionVidoyMerge10,
  actionVidoyAndTelegramMerge10,
  actionAnimeEpisode,
  buildResolveVideoUrl,
  targetLabel,
};
