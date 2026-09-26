// handlers/admin.js — E5c: admin panel, VIP, Saweria, invoice, pre_checkout
// ctx: { bot, logger, config: { ADMIN_IDS, STAR_PRICE, LOCAL_API_PORT, TOKEN }, isAdmin,
//        getSetting, setSetting, sendInvoiceFn? } — lihat catatan di bawah.
// Tidak ada require('../bot') — cegah cyclical (pola E4/E5a/E5b).
const { logger } = require('../logger');
const BTN = require('../lib/btn');
const { getSetting, setSetting, listRecentVidoyUploads, updateVidoyLink, clearVidoyTelegramPointer } = require('../db');
const Vidoy = require('../vidoy-uploader');
const { execFile } = require('child_process');
const { VIP_PACKAGES, VIP_STAR_PRICES, VIP_PACKAGE_ORDER } = require('../services/vipPackages');

let _ctx = null;
function initAdmin(ctx) {
  _ctx = ctx;
}
function ensureCtx(caller) {
  if (!_ctx || !_ctx.bot) throw new Error(`handlers/admin belum di-init — panggil initAdmin({ bot, ... }) dulu (dari ${caller})`);
}

function adminPanelKeyboard(libSimpanOn = false, aiEndpoint = null, aiModel = null, aiKey = null) {
  const emoji = libSimpanOn ? '✅' : '❌';
  const status = libSimpanOn ? 'ON' : 'OFF';
  const epShort = aiEndpoint ? aiEndpoint.replace(/^https?:\/\//, '').slice(0, 18) + (aiEndpoint.length > 18 ? '…' : '') : 'OFF';
  const epEmoji = aiEndpoint ? '✅' : '❌';
  const modelCount = aiModel ? aiModel.split(',').filter(Boolean).length : 0;
  const modelLabel = aiModel ? (modelCount > 1 ? `${modelCount} models` : aiModel.slice(0, 14)) : 'OFF';
  const modelEmoji = aiModel ? '✅' : '❌';
  const keyCount = aiKey ? aiKey.split(',').filter(Boolean).length : 0;
  const keyEmoji = keyCount ? '✅' : '❌';
  const keyLabel = keyCount ? (keyCount > 1 ? `${keyCount} keys` : 'SET') : 'OFF';
  // Toggle ON = hijau, OFF = merah supaya statusnya terbaca langsung dari warna.
  return BTN.kb([
    [BTN.btn(`💾 Simpan ke Library: ${emoji} ${status}`, 'act:lib_toggle', libSimpanOn ? 'success' : 'danger')],
    [BTN.nav(`🤖 AI Endpoint: ${epEmoji} ${epShort}`, 'act:ai_endpoint')],
    [BTN.nav(`🔑 AI Key: ${keyEmoji} ${keyLabel}`, 'act:ai_key')],
    [BTN.nav(`🧠 AI Model: ${modelEmoji} ${modelLabel}`, 'act:ai_model')],
    [BTN.nav('🌐 Domain Vidara', 'act:vidara_domain')],
    [BTN.nav('🗂 Vidoy Links', 'act:vidoy_links')],
    [BTN.btn('📚 Cari Drama/Anime', 'act:lib_search', 'primary')],
    [BTN.nav('📊 Status Server', 'act:status')],
    [BTN.nav('⭐ Cek Saldo Stars', 'act:balance')],
    [BTN.nav('⬅️ Kembali', 'act:main_menu')],
  ]);
}

function vipPaymentRows(kind) {
  const rows = [];
  let cur = [];
  VIP_PACKAGE_ORDER.forEach((d, i) => {
    const p = VIP_PACKAGES[d];
    const mark = d === 30 ? '🔥' : kind === 'qris' ? '⬛' : '⭐';
    const priceTxt = kind === 'qris' ? `${(p.price / 1000).toFixed(0)}K` : `${VIP_STAR_PRICES[d]}⭐`;
    cur.push({ text: `${mark} ${p.label} (${priceTxt})`, callback_data: `act:${kind}_pkg_${d}` });
    if (cur.length === 2 || i === VIP_PACKAGE_ORDER.length - 1) {
      rows.push(cur);
      cur = [];
    }
  });
  rows.push([{ text: '🔙 Kembali', callback_data: 'act:vip' }]);
  return rows;
}

function makePostRequest(urlPath, payload, timeoutMs = 20000) {
  ensureCtx('makePostRequest');
  const { LOCAL_API_PORT, TOKEN } = _ctx.config;
  const baseUrl = LOCAL_API_PORT
    ? `http://127.0.0.1:${LOCAL_API_PORT}`
    : 'https://api.telegram.org';
  const http = require(LOCAL_API_PORT ? 'http' : 'https');
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const url = `${baseUrl}/bot${TOKEN}/${urlPath}`;
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
          else reject(new Error(json.description || `${urlPath} failed`));
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => {
      const err = new Error(`timeout after ${timeoutMs}ms: ${urlPath}`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendInvoice(chatId, title, description, payload, price, label = 'Download access') {
  ensureCtx('sendInvoice');
  return makePostRequest('sendInvoice', {
    chat_id: chatId,
    title: title.slice(0, 32),
    description: description.slice(0, 255),
    payload,
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: label.slice(0, 64), amount: price }],
  });
}

// Callback act:admin_panel — render panel (butuh getSetting untuk status)
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// "message is not modified" = isi sudah sama → bukan kegagalan.
function isNotModified(err) {
  return /message is not modified/i.test(String(err || ''));
}

// "message to edit not found" = pesan sudah dihapus user.
function isMessageGone(err) {
  return /message to edit not found|message to be edited not found|message not found/i.test(String(err || ''));
}

function recordToken(row) {
  const raw = `${row.media_key}|${row.kind}|${row.part}`;
  return require('crypto').createHash('sha1').update(raw).digest('hex').slice(0, 8);
}

function findRowByToken(rows, token) {
  return rows.find((r) => recordToken(r) === token) || null;
}

function vidoyIdFromLink(link) {
  const m = String(link || '').match(/\/(?:e|d)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}

function linkAlive(link) {
  if (!link) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-m', '20', '-A', 'Mozilla/5.0', String(link)],
      { timeout: 30000 }, (err, stdout) => resolve(!err && /^200/.test(String(stdout || ''))));
  });
}

function partEpisodeLabel(part, epStart, epEnd) {
  const range = epStart === epEnd ? `${epStart}` : `${epStart}\u2013${epEnd}`;
  const num = Number(part) || 0;
  if (epStart === epEnd || !num) return `Ep ${range}`;
  return `${num} (Ep ${range})`;
}

function buildFallbackCaption(row, link) {
  const provider = row.provider || (row.media_key && String(row.media_key).includes(':')
    ? String(row.media_key).split(':')[0]
    : '\u2014');
  return [
    `➧ Judul :- <b>${esc(row.title || row.media_key || '\u2014')}</b>`,
    `➧ Part/Episode :- ${partEpisodeLabel(row.part, row.ep_start, row.ep_end)}`,
    `➧ Provider :- ${esc(provider)}`,
    `➧ Link :- <a href="${esc(link)}">${esc(shortLink(link))}</a>`,
  ].join('\n');
}

function replaceLinkLine(caption, link) {
  const line = `➧ Link :- <a href="${link}">${shortLink(link)}</a>`;
  const lines = String(caption || '').split('\n');
  const idx = lines.findIndex((l) => l.startsWith('\u27a7 Link :-'));
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  return lines.join('\n');
}

function shortLink(link) {
  const m = String(link || '').match(/https?:\/\/[^/]+\/(e|d)\/([A-Za-z0-9_-]+)/);
  return m ? `vidoy.asia/${m[1]}/${m[2]}` : String(link || '');
}

async function handleVidoyLinks({ chatId, msgId, query }) {
  ensureCtx('handleVidoyLinks');
  if (!(query && _ctx.isAdmin && _ctx.isAdmin(query.from.id))) return null;
  const rows = await listRecentVidoyUploads(20);
  if (!rows.length) {
    return _ctx.bot.sendMessage(chatId, '🗂 <b>Vidoy Links</b>\n\nBelum ada upload Vidoy tercatat.', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'act:admin_panel' }]] },
    });
  }
  const lines = rows.map((r, i) => {
    const alive = r.link_alive === true ? '🟢' : r.link_alive === false ? '🔴' : '⚪';
    const range = r.ep_start === r.ep_end ? `${r.ep_start}` : `${r.ep_start}\u2013${r.ep_end}`;
    const cap = r.tg_message_id ? '📌' : '—';
    return `${i + 1}. ${alive} <b>${esc((r.title || r.media_key).slice(0, 34))}</b> · ${r.kind} Ep ${range}\n    <code>${esc(shortLink(r.link))}</code> · caption:${cap}`;
  });
  const keyboard = rows.map((r, i) => [
    BTN.btn(`🔄 Perbarui #${i + 1}`, `act:vidoy_link_one:${recordToken(r)}`, 'primary'),
  ]);
  keyboard.push([BTN.btn('🔄 Perbarui Semua', 'act:vidoy_link_all', 'primary')]);
  keyboard.push([{ text: '⬅️ Kembali', callback_data: 'act:admin_panel' }]);
  return (msgId
    ? _ctx.bot.editMessageText(`🗂 <b>Vidoy Links</b> (terbaru)\n\n${lines.join('\n')}`, {
      chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard },
    })
    : _ctx.bot.sendMessage(chatId, `🗂 <b>Vidoy Links</b> (terbaru)\n\n${lines.join('\n')}`, {
      parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard },
    })).catch(() => {});
}

async function refreshVidoyLink(row, chatId) {
  const id = vidoyIdFromLink(row.link);
  if (!id) return { ok: false, error: 'id video tak terbaca dari link' };
  const alive = await linkAlive(row.link);
  let link = row.link;
  if (!alive) {
    const fresh = await Vidoy.fetchPublicLink(id);
    if (fresh && fresh !== row.link) {
      link = fresh;
      await updateVidoyLink(row.media_key, row.kind, row.part, link, true);
    }
  } else {
    await updateVidoyLink(row.media_key, row.kind, row.part, link, true);
  }
  let captionUpdated = false;
  let messageMissing = false;
  if (row.tg_chat_id && row.tg_message_id) {
    const base = row.caption && String(row.caption).trim()
      ? String(row.caption)
      : buildFallbackCaption(row, link);
    const caption = replaceLinkLine(base, link);
    // Pesan video harus diedit lewat editMessageCaption; editMessageText akan
    // selalu gagal dengan "there is no text in the message to edit".
    const capRes = await _ctx.bot.editMessageCaption(row.tg_chat_id, row.tg_message_id, caption, {
      parse_mode: 'HTML',
    }).then(() => ({ ok: true })).catch((e) => ({ ok: false, err: String(e && e.message || e) }));
    if (capRes.ok) {
      captionUpdated = true;
    } else if (isNotModified(capRes.err)) {
      // Caption sudah sama persis dengan yang tersimpan di Telegram → ini
      // SUKSES, bukan kegagalan. Selain itu Hindari jatuh ke editMessageText
      // yang pasti 400 (dan memunculkan warning palsu).
      captionUpdated = true;
    } else if (isMessageGone(capRes.err)) {
      // Pesan sudah dihapus di Telegram → bersihkan pointer supaya part ini
      // bisa dikirim ulang di run berikutnya (tidak hilang permanen).
      messageMissing = true;
      await clearVidoyTelegramPointer(row.media_key, row.kind, row.part).catch(() => {});
    } else {
      // Fallback untuk pesan ber-teks (bukan video).
      const txtRes = await _ctx.bot.editMessageText(caption, {
        chat_id: row.tg_chat_id, message_id: row.tg_message_id, parse_mode: 'HTML',
      }).then(() => true).catch(() => false);
      captionUpdated = txtRes;
    }
  }
  return { ok: true, alive, link, changed: link !== row.link, captionUpdated, messageMissing };
}

async function handleAdminPanel({ chatId }) {
  ensureCtx('handleAdminPanel');
  const { bot } = _ctx;
  const libOn = await getSetting('libsimpan');
  const aiEp = await getSetting('ai_endpoint');
  const aiModel = await getSetting('ai_model');
  const aiKey = await getSetting('ai_api_key');
  return bot.sendMessage(
    chatId,
    `<b>🛠 Admin Panel</b>\n\nKelola bot:`,
    { parse_mode: 'HTML', reply_markup: adminPanelKeyboard(libOn === 'on', aiEp, aiModel, aiKey) }
  );
}

// Callback act:balance — cek saldo Stars bot
async function handleBalance({ chatId, isAdminUser, mainMenuKeyboard }) {
  ensureCtx('handleBalance');
  const { bot } = _ctx;
  makePostRequest('getMyStarBalance', {}).then(result => {
    const stars = result.amount + (result.nanostar_amount || 0) / 1e9;
    bot.sendMessage(chatId, `⭐ <b>Saldo Stars Bot</b>\n${stars.toFixed(9)} ⭐\n\n💡 Tarik saldo via <b>Fragment</b> — klik tombol di bawah.`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '💎 Fragment', url: 'https://fragment.com' }]] } });
  }).catch(err => {
    bot.sendMessage(chatId, `❌ Gagal cek saldo: ${err.message.slice(0, 100)}`, { reply_markup: mainMenuKeyboard(isAdminUser) });
  });
}

// Callback act:vip — render VIP membership + paket
async function handleVip({ chatId, msgId, query, mainMenuKeyboard }) {
  ensureCtx('handleVip');
  const { bot } = _ctx;
  const vipService = require('../services/vipService');
  const pricing = Object.keys(VIP_PACKAGES).map((d) => {
    const p = VIP_PACKAGES[d];
    return `• ${p.label} — Rp ${p.price.toLocaleString('id-ID')} / ${VIP_STAR_PRICES[d]}⭐`;
  }).join('\n');
  const info = vipService.getVipInfo(query.from.id);
  const statusText = info
    ? `✅ <b>Status:</b> VIP aktif — sisa <b>${info.daysLeft} hari</b> (s/d ${info.expireDate})\n\n`
    : '';
  const msg = `💎 <b>VIP MEMBERSHIP</b>\n\n${statusText}<b>💰 Paket:</b>\n${pricing}\n\n<b>🛒 Cara:</b>\n1. Pilih paket → QRIS / Stars\n2. Bayar sesuai nominal\n3. VIP aktif otomatis\n\n<i>⚠️ Bayar persis nominal QRIS.</i>`;
  const rows = [
    [{ text: '⬛ QRIS', callback_data: 'act:select_payment_qris' }, { text: '⭐ Stars', callback_data: 'act:select_payment_stars' }],
  ];
  if (info) rows.push([{ text: '➕ Perpanjang VIP', callback_data: 'act:select_payment_qris' }]);
  rows.push([{ text: '🔙 Kembali', callback_data: 'act:main_menu' }]);
  const kb = { inline_keyboard: rows };
  return bot.editMessageText(msg, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: kb }).catch(() => bot.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: kb }));
}

// Callback act:select_payment_* — pilih metode (qris/stars), kirim invoice Stars bila stars
async function handleSelectPayment({ chatId, msgId, query, act }) {
  ensureCtx('handleSelectPayment');
  const { bot, config } = _ctx;
  const { STAR_PRICE } = config;
  if (act === 'select_payment_qris') {
    if (!process.env.SAWERIA_USERNAME || !process.env.SAWERIA_USER_ID) {
      return bot.answerCallbackQuery(query.id, { text: 'QRIS belum dikonfigurasi, hubungi admin', show_alert: true });
    }
    const rows = Object.keys(VIP_PACKAGES).map((d) => [{ text: `⬛ ${VIP_PACKAGES[d].label} — Rp ${VIP_PACKAGES[d].price.toLocaleString('id-ID')}`, callback_data: `qris_pkg_${d}` }]);
    return bot.editMessageText('⬛ <b>QRIS Payment (Saweria)</b>\n\nPilih paket (nominal kelipatan Rp 1.000):', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
  }
  if (act === 'select_payment_bagibagi') {
    return bot.answerCallbackQuery(query.id, { text: '🟦 BagiBagi sedang maintenance, silakan pakai QRIS / Stars', show_alert: true });
  }
  const rows = Object.keys(VIP_PACKAGES).map((d) => [{ text: `⭐ ${VIP_PACKAGES[d].label} — ${VIP_STAR_PRICES[d]}⭐`, callback_data: `stars_pkg_${d}` }]);
  return bot.editMessageText('⭐ <b>Stars Payment</b>\n\nPilih paket (dibayar via Telegram Stars):', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
}

// Callback stars_pkg_*/qris_pkg_*/saweria_cancel_* — buat invoice / batalkan
async function handlePaymentAction({ chatId, msgId, query, act, mainMenuKeyboard, isAdminUser }) {
  ensureCtx('handlePaymentAction');
  const { bot, config } = _ctx;
  const { STAR_PRICE } = config;
  const paymentCtx = (query, chatId) => ({
    from: query.from,
    chat: { id: chatId },
    reply: (html, opts) => bot.sendMessage(chatId, html, opts),
    answerCbQuery: (text, opts) => text
      ? bot.answerCallbackQuery(query.id, Object.assign({ text, show_alert: !!opts?.show_alert }, opts))
      : bot.answerCallbackQuery(query.id),
    replyWithPhoto: (photo, opts) => bot.sendPhoto(chatId, photo, opts),
    telegram: {
      deleteMessage: (cid, mid) => bot.deleteMessage(cid, mid),
      editMessageText: (cid, mid, _inlineId, html, opts) => bot.editMessageText(html, Object.assign({ chat_id: cid, message_id: mid }, opts)),
      sendMessage: (cid, html, opts) => bot.sendMessage(cid, html, opts),
    },
    notify: (html) => _ctx.config.ADMIN_IDS?.length ? bot.sendMessage(_ctx.config.ADMIN_IDS[0], html, { parse_mode: 'HTML' }) : Promise.resolve(),
  });
  if (act.startsWith('stars_pkg_')) {
    const days = parseInt(act.split('_')[2]);
    const stars = VIP_STAR_PRICES[days];
    const pkg = VIP_PACKAGES[days];
    if (!stars || !pkg) return bot.answerCallbackQuery(query.id, { text: 'Paket tidak valid', show_alert: true });
    logger.info({ chatId, days, stars, userId: query.from.id }, 'Stars invoice requested');
    try {
      const invoice = await sendInvoice(chatId, `💎 VIP ${pkg.label}`, `VIP ${days} hari — aktif otomatis setelah bayar`, `vip:${days}:${query.from.id}`, stars, `VIP ${days} hari`);
      logger.info({ chatId, days, invoiceId: invoice?.message_id }, 'Stars invoice sent');
      return invoice;
    } catch (err) {
      logger.error({ chatId, days, err: err.message, code: err.code }, 'Stars invoice failed');
      return bot.sendMessage(chatId, `❌ Gagal kirim invoice Stars: ${String(err.message).slice(0, 150)}`, { reply_markup: { inline_keyboard: [[{ text: '💎 Menu VIP', callback_data: 'act:vip' }]] } });
    }
  }
  if (act.startsWith('qris_pkg_')) {
    const days = parseInt(act.split('_')[2]);
    if (!process.env.SAWERIA_USERNAME || !process.env.SAWERIA_USER_ID) {
      return bot.answerCallbackQuery(query.id, { text: 'QRIS belum dikonfigurasi, hubungi admin', show_alert: true });
    }
    if (!VIP_PACKAGES[days]) return bot.answerCallbackQuery(query.id, { text: 'Paket tidak valid', show_alert: true });
    try {
      const saweriaService = require('../services/saweriaService');
      await saweriaService.startPayment(paymentCtx(query, chatId), query.from.id, days);
    } catch (e) {
      logger.error({ err: e.message }, 'QRIS start failed');
      return bot.sendMessage(chatId, `QRIS ${days} hari — hubungi admin untuk aktivasi.`);
    }
    return;
  }
  if (act.startsWith('bagibagi_pkg_')) {
    const days = parseInt(act.split('_')[2]);
    if (!process.env.BAGIBAGI_RECEIVER_USERNAME) {
      return bot.answerCallbackQuery(query.id, { text: 'BagiBagi belum dikonfigurasi, hubungi admin', show_alert: true });
    }
    if (!VIP_PACKAGES[days]) return bot.answerCallbackQuery(query.id, { text: 'Paket tidak valid', show_alert: true });
    try {
      const bagibagiService = require('../services/bagibagiService');
      await bagibagiService.startPayment(paymentCtx(query, chatId), query.from.id, days);
    } catch (e) {
      logger.error({ err: e.message }, 'BagiBagi start failed');
      return bot.sendMessage(chatId, `BagiBagi ${days} hari — hubungi admin untuk aktivasi.`);
    }
    return;
  }
  if (act.startsWith('bagibagi_cancel_')) {
    const donationId = act.replace('bagibagi_cancel_', '');
    try {
      const bagibagiService = require('../services/bagibagiService');
      await bagibagiService.cancelAndCleanup({
        telegram: { deleteMessage: (cid, mid) => bot.deleteMessage(cid, mid) },
      }, donationId);
      await bot.sendMessage(chatId, '❌ Pembayaran dibatalkan.', { reply_markup: { inline_keyboard: [[{ text: '💎 Menu VIP', callback_data: 'act:vip' }]] } });
    } catch (e) {
      logger.warn({ err: e.message }, 'bagibagi cancel failed');
    }
    return;
  }
  if (act.startsWith('saweria_cancel_')) {
    const donationId = act.replace('saweria_cancel_', '');
    try {
      const saweriaService = require('../services/saweriaService');
      await saweriaService.cancelAndCleanup({
        telegram: { deleteMessage: (cid, mid) => bot.deleteMessage(cid, mid) },
      }, donationId);
      await bot.sendMessage(chatId, '❌ Pembayaran dibatalkan.', { reply_markup: { inline_keyboard: [[{ text: '💎 Menu VIP', callback_data: 'act:vip' }]] } });
    } catch (e) {
      logger.warn({ err: e.message }, 'saweria cancel failed');
    }
    return;
  }
}

// Handler bot.on('pre_checkout_query') — approve (tidak pegang uang/VIP, hanya gerbang)
async function handlePreCheckout(query) {
  ensureCtx('handlePreCheckout');
  try {
    await makePostRequest('answerPreCheckoutQuery', {
      pre_checkout_query_id: query.id,
      ok: true,
    });
    logger.info({ queryId: query.id, userId: query.from.id }, 'Pre-checkout approved');
  } catch (err) {
    logger.error({ queryId: query.id, err: err.message }, 'Pre-checkout answer failed');
  }
}

module.exports = {
  initAdmin,
  adminPanelKeyboard,
  handleVidoyLinks,
  refreshVidoyLink,
  recordToken,
  findRowByToken,
  isNotModified,
  isMessageGone,
  replaceLinkLine,
  buildFallbackCaption,
  partEpisodeLabel,
  makePostRequest,
  sendInvoice,
  handleAdminPanel,
  handleBalance,
  handleVip,
  handleSelectPayment,
  handlePaymentAction,
  handlePreCheckout,
};
