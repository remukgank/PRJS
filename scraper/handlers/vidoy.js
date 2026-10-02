// handlers/vidoy.js — aksi upload Vidoy (drama merge-10, anime per-episode)
const path = require('path');
const fs = require('fs');
const { logger } = require('../logger');
const { getVideoUrl } = require('../index');
const { getVideoUrlReelFren } = require('../providers/reelfren');
const { getVidaraActiveDomain, saveVidaraUpload } = require('../db');
const { isQuotaExceededError, quotaResetDate, vidaraDailyLimitError, nextUtcMidnightMs } = require('../lib/quota');
const db = require('../db');
const { getSetting, setSetting, getPartFileId, savePartFileId, upsertMedia } = require('../db');
const { sanitizeSlug } = require('../lib/parser');
const { kamenimeSourcePattern } = require('../providers/kamenime');
const { ensureMp4, assertLooksLikeVideo, detectVideoContainer } = require('../services/vidaraService');
const vidoyService = require('../services/vidoyService');
const { TMP_DIR, getVideoInfo } = require('../downloader');
const { safeHtml } = require('../lib/html');
const { shortLinkLabel, withSeasonSuffix } = require('../lib/caption');
const V = require('../vidoy-uploader');
const Vdara = require('../vidara-uploader');
const Vdash = require('../vidara-dashboard');

let _ctx = null;
function initVidoy(ctx) {
  _ctx = ctx;
}
  function ensureCtx(caller) {
    if (!_ctx || !_ctx.bot) throw new Error(`handlers/vidoy belum di-init — panggil initVidoy({ bot, ... }) dulu (dilakukan oleh ${caller || 'pemanggil'})`);
  }

  /** Hostname aman untuk log — URL bisa berisi token, jangan dicetak utuh. */
  function hostOf(u) {
    try { return new URL(u).hostname; } catch { return String(u || '').slice(0, 40); }
  }

  /**
   * Apakah file di `destPath` REALLY bisa dipakai (bukan cuma ada)?
   *
   * Insiden 28 Sep 2026, One Piece Ep 733: proses di-SIGTERM di tengah unduhan
   * menyisakan parsial 0,8 MB di `downloads/anime/…/ep733/`. Setelah restart,
   * `fs.existsSync(destPath)` benar → "skip download — file sudah ada" → parsial
   * itu langsung dikirim ke Vidoy, yang menolaknya dengan pesan tak berguna
   * ("Vidoy CDN status invalid … hash_file(thumbnail/…): No such file").
   *
   * `fs.existsSync` hanya membuktikan ada file, BUKAN bahwa file itu utuh. Yang
   * dipakai sebagai bukti kesahihan: signature container (ftyp/Matroska/MPEG-TS)
   * — sama seperti `assertLooksLikeVideo` — ditambah ambang ukuran konservatif.
   * Kombinasi ini yang membuat "sudah ada" berarti "layak upload", bukan
   * "sisa kegagalan yang lalu".
   *
   * Konservatif yang disengaja: MP4 sah boleh kecil (fragmen/clip), tapi DI SINI
   * konteksnya episode penuh dari provider — ambang 5 MB jauh di bawah ukuran
   * episode terkecil yang tercatat (One Piece 51,2 MB; p1 library 61,9 MB),
   * jadi tidak mungkin menunda file yang sah. Kembalikan alasan supaya log
   * bisa menjelaskan kenapa unduhan diulang.
   */
  const REUSABLE_MIN_BYTES = 5 * 1024 * 1024;
  function isReusableVideo(destPath) {
    let st;
    try { st = fs.statSync(destPath); } catch { return { ok: false, why: 'tidak ada' }; }
    if (st.size < REUSABLE_MIN_BYTES) {
      return { ok: false, why: `parsial ${(st.size / 1048576).toFixed(1)} MB`, bytes: st.size };
    }
    try {
      assertLooksLikeVideo(destPath);
    } catch (e) {
      return { ok: false, why: e.message.slice(0, 120), bytes: st.size };
    }
    // Signature ada (tidak lempar) tapi kontainer tak dikenal/bermasalah → tolak.
    const container = detectVideoContainer(destPath);
    if (container === 'unknown') {
      return { ok: false, why: `signature bukan video (${(st.size / 1048576).toFixed(1)} MB)`, bytes: st.size };
    }
    return { ok: true, why: `${(st.size / 1048576).toFixed(1)} MB`, bytes: st.size };
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
      const caption = buildCaption({ title, provider: providerLabel, part: item.part, epStart: item.epStart, epEnd: item.epEnd, link: item.link, server: item.link ? 'VIDOY' : '' });
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

// Upload satu episode ke Vidara: file lokal → kode, rename, pindah ke folder
// JUDUL (folderTitle — tanpa suffix episode). Mengembalikan { code, url, host,
// folderId } — `host` diambil dari respons API (lihat extractUploadRef)
// supaya caption tidak pernah mempatok domain.
// FIX 1 Okt 2026: `title` (per episode) TIDAK boleh dipakai untuk nama folder
// — dulu `uploadToVidaraFolder(destPath, "<judul> — Ep 01")` bikin 1 folder
// per episode (129 folder Dragon Ball). Folder = judul polos; nama file
// (`renameVideo`) tetap per episode.
async function uploadToVidaraFolder(destPath, title, folderTitle = title) {
  const ref = await Vdara.uploadFileRef(destPath);
  const filecode = ref.code;
  await Vdara.renameVideo(filecode, `${title}`).catch(() => {});
  let folderUrl = '';
  let folderId = '';
  try {
    // Per judul, nested di bawah folder root "Anime" kalau dashboard bisa
    // diakses; kalau tidak, fallback flat dengan nama yang SAMA (judul).
    const fldId = await Vdash.getOrCreateSeriesFolder(folderTitle);
    if (fldId) {
      await Vdara.moveToFolder(filecode, fldId).catch(() => {});
      folderUrl = `${fldId}`;
      folderId = `${fldId}`;
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Vidara folder gagal — file tetap di root');
  }
  // Link final: preferensi link dari /video/info (dipakai server sendiri),
  // fallback ke URL respons upload. Penting untuk crop: kode bisa belum aktif
  // beberapa detik setelah upload, dan /video/info adalah bukti sahnya.
  let link = '';
  try {
    const info = await Vdara.videoInfo(filecode);
    if (info && info.status === 'active') link = Vdara.buildVideoLink(ref, info.link);
    if (info && info.status === 'error') throw new Error('Vidara encoding error');
  } catch (err) {
    if (err && /encoding error/i.test(String(err.message || ''))) throw err;
    logger.warn({ err: String((err && err.message) || err) }, 'Vidara info gagal — pakai link dari respons upload');
  }
  return { filecode, folderUrl, folderId, link: link || Vdara.buildVideoLink(ref), host: ref.host, url: ref.url };
}

// Rekonstruksi link publik dari record DB (dipakai saat episode dilewati:
// file sudah ada di Vidara, jadi tidak ada respons API baru).
function vidaraLinkFromRecord(rec) {
  if (!rec) return '';
  const code = String(rec.filecode || '').replace(/^https?:\/\//i, '').split('/').filter(Boolean).pop() || '';
  const host = String(rec.domain || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!code) return '';
  if (!host || !/[.]/.test(host)) return '';
  return `https://${host}/${code}`;
}

async function actionAnimeEpisode(chatId, opts) {
  ensureCtx('actionAnimeEpisode');
  const { target, title, ep, sameInfo, directUrl, episodeUrl, silent, localPath } = opts || {};
  // Target: tg=Telegram, vyt=Vidoy+Telegram, vv=Vidoy saja,
  //         vt=Vidara+Telegram, v=Vidara saja.
  // Vidara = host CADANGAN SEMENTARA. Vidoy tetap kanonik: kalau episode sudah
  // ada di Vidoy, tidak perlu (dan tidak boleh) diunggah ke Vidara lagi.
  const needVidoy = target === 'vyt' || target === 'vv';
  const needVidara = target === 'vt' || target === 'v';
  const needTg = target === 'tg' || target === 'vyt' || target === 'vt';
  // Fallback hanya boleh kalau Vidara benar-benar siap dipakai. Tanpa ini,
  // batch yang tadinya berhenti bersih di 413 akan berubah jadi gagal dengan
  // pesan "VIDARA_API belum diset" — lebih sulit diagnosa, dan quota failure
  // yang tadinya jadi sinyal penting jadi tertutup.
  const canFallbackToVidara = !!(needVidoy && Vdara.VIDARA_KEY);
  // Judul Vidoy (folder + nama file + mediaKey) memakai suffix season/part.
  const vidoyTitle = withSeasonSuffix(title, sameInfo && sameInfo.season, sameInfo && sameInfo.part);
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
  // ── Pre-check batas harian Vidara (200 file/hari) ───────────────────────
  // Bukti 1 Okt 2026: batch vt ep 130–153 mengunduh ~1,7 GB lalu semuanya
  // gagal — limit sudah penuh sejak episode pertama. Vidara TIDAK punya
  // endpoint kuota (semua 404, lihat proposal dual-host §2), jadi tidak ada
  // yang bisa dicek dari API; satu-satunya cara adalah mencatat sendiri saat
  // limit kena, lalu berhenti SEBELUM download episode berikutnya.
  // Flag disimpan sebagai epoch ms sampai 00:00 UTC berikutnya.
  if (needVidara) {
    const until = Number(await getSetting('vidara_limit_reset_at').catch(() => 0)) || 0;
    if (until > Date.now()) {
      const resetAt = `${new Date(until).toISOString().slice(11, 16)} UTC`;
      const msg = `Vidara limit harian penuh (200 file/hari) — reset ${resetAt}`;
      logger.warn({ chatId, target, ep, resetAt }, 'skip — limit harian Vidara belum reset');
      return silent
        ? { vidoy: null, vidara: null, tg: false, error: msg }
        : _ctx.bot.sendMessage(chatId, `⚠️ <b>${safeHtml(msg)}</b>\nJalankan lagi setelah reset; episode yang sudah ada tidak akan diulang.`);
    }
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
  const outDir = path.join(TMP_DIR, 'anime', String(vidoyTitle || 'anime').replace(/[^\w-]+/g, '_'), `ep${ep}`);
  const p = silent
    ? { update() {}, done: async () => {}, fail: async () => {} }
    : await new _ctx.Progress(chatId, `Anime Ep ${ep} — ${targetLabel(target)}`).start();
  const out = { vidoy: null, vidara: null, tg: false, error: null, skipped: false };
  // ── Pre-check dedupe (hanya jalur Vidara) ────────────────────────────────
  // Aturan yang diminta user:
  //   ada di Vidoy  → jangan sentuh Vidara (skip total kalau TG sudah ada)
  //   ada di Vidara → TIDAK menghalangi Vidoy; hanya mencegah upload ulang ke
  //                   Vidara (file di sana sudah ada).
  // Dicek SEBELUM download karena kalau baru dicepatkan di dalam upload, unduhan
  // 250 MB sudah terlanjur terjadi sebelum ketahuan "sudah ada" — pemborosan
  // bandwidth yang persis dilarang aturan §6.
  let preVidoy = null;
  let preVidara = null;
  if (needVidara) {
    const numEp = Number(ep) || 0;
    preVidara = await db.getVidaraUpload(String(vidoyTitle), numEp).catch(() => null);
    const rows = await db.listVidoyUploads(String(vidoyTitle), 'anime').catch(() => []);
    preVidoy = (rows || []).find((r) => Number(r.part) === numEp) || null;
    const hasTg = !!(preVidoy && preVidoy.tg_chat_id && preVidoy.tg_message_id);
    if (preVidoy && (!needTg || hasTg)) {
      logger.info({ chatId, target, ep, title: vidoyTitle }, 'skip — episode sudah ada di Vidoy');
      out.vidoy = { link: preVidoy.link || '', skipped: true };
      out.skipped = true;
      return silent
        ? out
        : p.done('⏭️ sudah ada di Vidoy — dilewati').then(() => out);
    }
    if (!preVidoy && preVidara && !needTg) {
      // Vidara-only: file sudah ada di sana, tidak ada pekerjaan lain.
      logger.info({ chatId, target, ep, title: vidoyTitle }, 'skip — episode sudah ada di Vidara');
      out.vidara = String(preVidara.filecode || '');
      out.vidaraLink = vidaraLinkFromRecord(preVidara);
      out.skipped = true;
      return silent
        ? out
        : p.done(`⏭️ sudah ada di Vidara — dilewati`).then(() => out);
    }
  }
  try {
    fs.mkdirSync(outDir, { recursive: true });
      const destPath = path.join(outDir, `${V.sanitizeFolderName(vidoyTitle || 'Anime')} — Ep ${String(ep).padStart(2, '0')}.mp4`);
      const logCtx = { chatId, target, ep, title: vidoyTitle };
      // "File sudah ada" harus berarti "layak upload", bukan sekadar ada di disk.
      // `existsSync` saja membuat parsial sisa proses mati (SIGTERM / speed
      // floor) lolos dan ditolak Vidoy dengan pesan tak berguna — insiden
      // Ep 733, 28 Sep 2026. Kalau tidak layak, hapus dulu supaya downloadTo
      // tidak salah resume dari parsial itu, baru unduh ulang dari nol.
      const reusable = isReusableVideo(destPath);
      if (reusable.ok) {
        // Sudah ada & utuh → jangan unduh ulang (Vidoy: dilarang keras duplikat).
        logger.info({ ...logCtx, mb: +(reusable.bytes / 1048576).toFixed(1) }, 'skip download — file sudah ada');
      } else if (localPath && fs.existsSync(localPath)) {
        // File sudah diunduh pemanggil (mis. mega streaming yang tidak punya URL
        // HTTP). Salin ke destPath lalu validasi seperti biasa — directUrl tidak
        // dibutuhkan di jalur ini, dan ensureMp4 tidak dipanggil.
        p.update('⬇️ siapkan file lokal');
        try { fs.copyFileSync(localPath, destPath); }
        catch (e) { throw new Error('gagal salin file lokal: ' + e.message); }
        const check = isReusableVideo(destPath);
        if (!check.ok) throw new Error('file lokal tidak layak pakai: ' + check.why);
        logger.info({ ...logCtx, mb: +(fs.statSync(destPath).size / 1048576).toFixed(1) }, 'pakai file lokal (tanpa download ulang)');
      } else {
        if (reusable.why !== 'tidak ada') {
          logger.warn({ ...logCtx, why: reusable.why }, 'file ada tapi tidak layak pakai — unduh ulang dari nol');
          try { fs.rmSync(destPath, { force: true }); } catch {}
        }
        p.update('⬇️ download');
        logger.info({ ...logCtx, host: hostOf(directUrl), resolveFresh: typeof opts.resolveFreshDirectUrl === 'function' }, 'mulai download episode');
        // resolveFresh WAJIB re-resolve, bukan memakai ulang directUrl: beberapa
        // provider (gdriveplayer) memberi URL ber-token yang berubah tiap resolve
        // dan cepat kedaluwarsa. Retry dengan URL sama = MUSTAHILH (percobaan
        // selalu balas HTML 92 KB → 3× gagal + backoff, terasa "lama").
        const reResolve = typeof opts.resolveFreshDirectUrl === 'function'
          ? opts.resolveFreshDirectUrl
          : async () => directUrl;
        const ok = await ensureMp4(directUrl, destPath, {
          resolveFresh: async () => (await reResolve()) || directUrl,
          logCtx,
        });
        if (!ok) throw new Error('gagal mengunduh video');
        logger.info({ ...logCtx, mb: +(fs.statSync(destPath).size / 1048576).toFixed(1) }, 'download selesai');
      }
    if (needVidoy) {
      p.update('📤 upload Vidoy');
      let res = null;
      try {
        res = await vidoyService.uploadSingle({
          kind: 'anime', mediaKey: String(vidoyTitle), title: String(vidoyTitle), ep, episodeUrl, outDir,
          onProgress: (pc) => p.update(`📤 upload Vidoy ${pc}%`),
        });
        if (!res.ok) throw new Error(res.error || 'Vidoy upload gagal');
      } catch (vErr) {
        // Fallback ke Vidara kalau yang gagal adalah KUOTA, bukan file rusak.
        // Bedanya penting: 413 kuota = storage penuh, file-nya sah dan layak
        // masuk host lain. Error lain (CDN, signature, jaringan) BUKAN alasan
        // menyalin file ke host kedua — itu hanya menutupi satusymptom.
        if (!canFallbackToVidara || !isQuotaExceededError(vErr)) throw vErr;
        logger.warn({ ...logCtx, err: String(vErr.message).slice(0, 200), reset: quotaResetDate(vErr) },
          'Vidoy quota habis — fallback ke Vidara');
        res = null;
      }
      if (res) {
        out.vidoy = res;
        if (res.skipped) out.skipped = true;
        // Vidara = cadangan sementara: begitu episode sah di Vidoy, file di
        // Vidara dihapus supaya kuota Vidara tidak slowly terkuras. Urutan WAJIB
        // server dulu baru DB: kalau record dihapus lebih dulu dan deleteVideo
        // gagal, file jadi yatim yang tidak pernah dilacak (pola phantom record).
        if (preVidara && preVidara.filecode) {
          try {
            const del = await Vdara.deleteVideo(String(preVidara.filecode).replace(/^https?:\/\//i, '').split('/').filter(Boolean).pop() || '');
            if (del) {
              await db.deleteVidaraUpload(String(vidoyTitle), Number(ep) || 0);
              logger.info({ ...logCtx }, 'Vidara dibersihkan setelah masuk Vidoy');
            }
          } catch (delErr) {
            logger.warn({ ...logCtx, err: String(delErr.message).slice(0, 160) },
              'hapus file Vidara gagal — record tetap disimpan agar bisa diulang');
          }
        }
      }
    }
    // needVidara = target vt/v, ATAU fallback dari Vidoy kena kuota. Syarat
    // "tidak ada di Vidoy" mencegah upload ulang: kalau Vidoy sudah punya
    // (dan yang gagal di atas misal karena register, bukan kuota), episode itu
    // berstatus ada di Vidoy sehingga tidak perlu disalin ke Vidara.
    const vidaraAllowed = needVidara || (needVidoy && !out.vidoy && canFallbackToVidara);
    if (vidaraAllowed && !out.vidoy) {
      const alreadyInVidara = preVidara && preVidara.filecode;
      if (alreadyInVidara) {
        // Sudah ada di Vidara → jangan upload ulang; pakai link yang tersimpan.
        // WAJIB kirim preVidara (objek record): alreadyInVidara hanya string
        // filecode → vidaraLinkFromRecord menerima string dan selalu balik ''
        // (caption jadi 3 baris tanpa Link/Server — insiden ep1 2 Okt 06:06).
        out.vidara = String(alreadyInVidara);
        out.vidaraLink = vidaraLinkFromRecord(preVidara);
        logger.info({ ...logCtx }, 'Vidara dilewati — file sudah ada (tanpa upload ulang)');
      } else {
        p.update('📤 upload Vidara');
        const numEp = Number(ep) || 0;
        // Key record = vidoyTitle (suffix musim ikut). Key lama memakai title
        // polos → Re:Zero S1 dan S3 akan menabrak di baris yang sama.
        const v = await uploadToVidaraFolder(destPath, `${vidoyTitle} — Ep ${String(numEp).padStart(2, '0')}`, vidoyTitle);
        out.vidara = v.filecode;
        out.vidaraLink = v.link;
        out.vidaraFallback = !needVidara;
        if (v.filecode) {
          const host = v.host || (await getVidaraActiveDomain()) || Vdara.VIDARA_DOMAIN || process.env.VIDARA_DOMAIN || 'vidara.so';
          await saveVidaraUpload(String(vidoyTitle), numEp, v.filecode, host, String(vidoyTitle)).catch(() => {});
          logger.info({ ...logCtx, host: v.host || '', fallback: !!out.vidaraFallback }, 'Vidara upload sukses');
        }
      }
    }
    if (needTg) {
      p.update('📤 kirim Telegram');
      const animeProvider = sameInfo?.provider || 'anime';
      // Link caption: Vidoy kalau ada, kalau tidak link Vidara (host dari
      // respons API). Tanpa ini caption target vt hanya 3 baris padahal file
      // ada di host — padahal kontrak §5 minta 4 baris begitu ada link.
      const vidoyLink = (out.vidoy && out.vidoy.link) || '';
      const captionLink = vidoyLink || out.vidaraLink || '';
      // Server = host yang benar-benar memegang file episode ini. Hanya tampil
      // kalau ada link (server tanpa link menyesatkan — file mungkin gagal upload).
      const captionServer = vidoyLink ? 'VIDOY' : (captionLink ? 'VIDARA' : '');
      const caption = buildCaption({
        title, provider: animeProvider, part: Number(ep) || 0, epStart: Number(ep) || 0, epEnd: Number(ep) || 0,
        link: captionLink, server: captionServer,
      });
      const vinfo = await getVideoInfo(destPath).catch(() => ({}));
      const mediaOpts = {
        caption, parse_mode: 'HTML', supports_streaming: true,
        ...(vinfo.duration && { duration: vinfo.duration }),
        ...(vinfo.width && { width: vinfo.width }),
        ...(vinfo.height && { height: vinfo.height }),
      };
      // WAJIB lewat sendAnimeMedia: ia mengarahkan ke topic Anime (bukan General)
      // sekaligus memaksa supports_streaming. Tanpa ini, video anime masuk topic
      // General karena sendVideo polos tidak membawa message_thread_id.
      const sent = typeof _ctx.sendAnimeMedia === 'function'
        ? await _ctx.sendAnimeMedia(chatId, destPath, mediaOpts)
        : await _ctx.sendVideo(chatId, destPath, mediaOpts);
      out.tg = true;
      const msgId = sent && (sent.message_id || (sent.result && sent.result.message_id));
      if (msgId && out.vidoy) {
        const num = Number(ep) || 0;
        await db.setVidoyTelegramPointer(String(vidoyTitle), 'anime', num, chatId, msgId).catch(() => {});
        await db.saveVidoyUpload({
          mediaKey: String(vidoyTitle), kind: 'anime', part: num, epStart: num, epEnd: num, title: vidoyTitle,
          folderId: out.vidoy.folderId, folderUrl: out.vidoy.folderUrl, link: out.vidoy.link,
          dashboard: out.vidoy.dashboard, tgChatId: chatId, tgMessageId: msgId,
          provider: animeProvider, caption,
        }).catch(() => {});
      }
      // ── Simpan library (kamenime saja) ────────────────────────────────────
      // handleKamenimeUrl (jalur tg) sudah menyimpan di download.js:817-824,
      // tapi actionAnimeEpisode TIDAK — sehingga episode yang hanya dikirim ke
      // Vidoy tidak pernah mengisi media/media_parts, dan akibatnya:
      //   - !dell tidak menemukan (cari di media.nama)
      //   - status picker tidak pernah hijau (baca media_parts)
      // Dicatat setelah setVidoyTelegramPointer karena butuh msgId/file_id.
      // Syarat provider WAJIB: actionAnimeEpisode dipakai 5 pemanggil
      // (samehadaku batch/single, kuronime single/batch, dl_go generik) dan
      // tanpa syarat ini Samehadaku+Kuronime ikut mengisi library — perubahan
      // perilaku besar yang di luar scope. Kamenime identifiable lewat
      // sameInfo.provider === 'hokireceh' (bot.js:4521).
      if (animeProvider === 'hokireceh' && title && sent && sent.video
          && sent.video.file_id && episodeUrl) {
        try {
          const libOn = (await getSetting('libsimpan')) === 'on';
          if (libOn) {
            const libSlug = `anime:${sanitizeSlug(title)}`;
            // source_pattern WAJIB dari URL (/anime/<slug>), bukan nama file —
            // kalau dari nama file, tiap episode punya pola berbeda
            // ("...-episode-1", "...-episode-2") sehingga judul tidak pernah
            // connect antar episode. Sama dengan download.js:763.
            const libPat = kamenimeSourcePattern(episodeUrl) || sanitizeSlug(title) || 'kamenime';
            const num = Number(ep) || 0;
            const existing = await getPartFileId(libSlug, num);
            if (!existing) {
              // fs sudah dipakai di file ini (statSync di log download selesai).
              let libBytes = 0;
              try { libBytes = fs.statSync(destPath).size; } catch {}
              await upsertMedia(libSlug, String(title), 0, episodeUrl, libPat);
              await savePartFileId(libSlug, num, sent.video.file_id, libBytes, path.basename(destPath) || '');
            }
          }
        } catch (libErr) {
          // Jangan gagalkan upload karena catat library gagal.
          logger.warn({ chatId, err: libErr.message }, 'kamenime: simpan library gagal');
        }
      }
    }
    const parts = [];
    if (out.skipped && out.vidoy) parts.push('📤 Vidoy ⏭️ sudah ada');
    if (out.tg) parts.push('📤 Telegram ✅');
    // Vidara: tampilkan LINK, bukan kode — kode tidak bisa diklik dan tidak
    // bisa dipakai ganti-judul nanti. Bedakan hasil fallback (kuota Vidoy)
    // supaya ringkasan tidak mengarang success yang tidak terjadi.
    if (out.vidara) {
      const vidaraShown = out.vidaraLink || out.vidara;
      parts.push(`${out.vidaraFallback ? '🗜 Vidara (fallback) ✅' : '📤 Vidara ✅'} <code>${safeHtml(vidaraShown)}</code>`);
    }
    if (out.vidoy && !out.vidoy.skipped) parts.push(`📤 Vidoy ✅ <code>${safeHtml(out.vidoy.link)}</code>`);
    if (out.vidoy && out.vidoy.skipped) parts.push(`📤 link <code>${safeHtml(out.vidoy.link)}</code>`);
    if (!silent) await p.done(parts.join(' · ') || 'selesai');
    else out.summary = parts.join(' · ') || 'selesai';
  } catch (err) {
    out.error = err.message;
    logger.error({ chatId, ep, target, err: err.message }, 'Anime episode upload gagal');
    // Limit harian Vidara kena → catat sampai resetnya, supaya episode
    // berikutnya berhenti di pre-check ATAS, bukan setelah mengorbankan satu
    // file unduhan penuh. Flag dibaca di pre-check (lihat atas fungsi ini).
    if (vidaraDailyLimitError(err.message)) {
      const until = nextUtcMidnightMs();
      await setSetting('vidara_limit_reset_at', String(until)).catch(() => {});
      logger.warn({ chatId, ep, target, resetAt: new Date(until).toISOString() }, 'limit harian Vidara dicatat');
    }
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

function buildCaption({ title, provider, part, epStart, epEnd, link, server }) {
  return [
    `➧ Judul :- <b>${safeHtml(title || '\u2014')}</b>`,
    `➧ ${partEpisodeLabel(part, epStart, epEnd)}`,
    `➧ Provider :- ${safeHtml(provider || '\u2014')}`,
    ...(link ? [`➧ Link :- <a href="${safeHtml(link)}">${safeHtml(shortLinkLabel(link))}</a>`] : []),
    ...(server ? [`➧ Server :- ${safeHtml(server)}`] : []),
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

function targetLabel(target) {
  // WAJIB sama dengan batchTargetLabel di bot.js — test Menjaga keduanya agar
  // tidak menyimpang (satu berubah, satu tidak = label menyesatkan di UI).
  const map = { tg: 'Telegram', vyt: 'Vidoy + Telegram', vv: 'Vidoy', vt: 'Vidara + Telegram', v: 'Vidara' };
  return map[target] || String(target || '');
}

module.exports = {
  initVidoy,
  buildCaption,
  withSeasonSuffix,
  replaceLinkLine,
  partEpisodeLabel,
  shortLinkLabel,
  actionVidoyMerge10,
  actionVidoyAndTelegramMerge10,
  actionAnimeEpisode,
  buildResolveVideoUrl,
  targetLabel,
  isReusableVideo,
  REUSABLE_MIN_BYTES,
};
