// handlers/admin.js — E5c: admin panel, VIP, Saweria, invoice, pre_checkout
// ctx: { bot, logger, config: { ADMIN_IDS, STAR_PRICE, LOCAL_API_PORT, TOKEN }, isAdmin,
//        getSetting, setSetting, sendInvoiceFn? } — lihat catatan di bawah.
// Tidak ada require('../bot') — cegah cyclical (pola E4/E5a/E5b).
const { logger } = require('../logger');
const { getSetting, setSetting } = require('../db');
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
  return {
    inline_keyboard: [
      [{ text: `💾 Simpan ke Library: ${emoji} ${status}`, callback_data: 'act:lib_toggle' }],
      [{ text: `🤖 AI Endpoint: ${epEmoji} ${epShort}`, callback_data: 'act:ai_endpoint' }],
      [{ text: `🔑 AI Key: ${keyEmoji} ${keyLabel}`, callback_data: 'act:ai_key' }],
      [{ text: `🧠 AI Model: ${modelEmoji} ${modelLabel}`, callback_data: 'act:ai_model' }],
      [{ text: '🌐 Domain Vidara', callback_data: 'act:vidara_domain' }],
      [{ text: '📚 Cari Drama/Anime', callback_data: 'act:lib_search' }],
      [{ text: '📊 Status Server', callback_data: 'act:status' }],
      [{ text: '⭐ Cek Saldo Stars', callback_data: 'act:balance' }],
      [{ text: '⬅️ Kembali', callback_data: 'act:main_menu' }],
    ],
  };
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

function makePostRequest(urlPath, payload) {
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
  const rows = [[{ text: '⬛ QRIS', callback_data: 'act:select_payment_qris' }, { text: '⭐ Stars', callback_data: 'act:select_payment_stars' }]];
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
  if (act === 'act:select_payment_qris') {
    if (!process.env.SAWERIA_USERNAME || !process.env.SAWERIA_USER_ID) {
      return bot.answerCallbackQuery(query.id, { text: 'QRIS belum dikonfigurasi, hubungi admin', show_alert: true });
    }
    const rows = Object.keys(VIP_PACKAGES).map((d) => [{ text: `⬛ ${VIP_PACKAGES[d].label} — Rp ${VIP_PACKAGES[d].price.toLocaleString('id-ID')}`, callback_data: `qris_pkg_${d}` }]);
    return bot.editMessageText('⬛ <b>QRIS Payment</b>\n\nPilih paket (nominal kelipatan Rp 1.000):', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
  }
  const rows = Object.keys(VIP_PACKAGES).map((d) => [{ text: `⭐ ${VIP_PACKAGES[d].label} — ${VIP_STAR_PRICES[d]}⭐`, callback_data: `stars_pkg_${d}` }]);
  return bot.editMessageText('⭐ <b>Stars Payment</b>\n\nPilih paket (dibayar via Telegram Stars):', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
}

// Callback stars_pkg_*/qris_pkg_*/saweria_cancel_* — buat invoice / batalkan
async function handlePaymentAction({ chatId, msgId, query, act, mainMenuKeyboard, isAdminUser }) {
  ensureCtx('handlePaymentAction');
  const { bot, config } = _ctx;
  const { STAR_PRICE } = config;
  if (act.startsWith('stars_pkg_')) {
    const days = parseInt(act.split('_')[2]);
    const stars = VIP_STAR_PRICES[days];
    const pkg = VIP_PACKAGES[days];
    if (!stars || !pkg) return bot.answerCallbackQuery(query.id, { text: 'Paket tidak valid', show_alert: true });
    return sendInvoice(chatId, `💎 VIP ${pkg.label}`, `VIP ${days} hari — aktif otomatis setelah bayar`, `vip:${days}:${query.from.id}`, stars, `VIP ${days} hari`);
  }
  if (act.startsWith('qris_pkg_')) {
    const days = parseInt(act.split('_')[2]);
    if (!process.env.SAWERIA_USERNAME || !process.env.SAWERIA_USER_ID) {
      return bot.answerCallbackQuery(query.id, { text: 'QRIS belum dikonfigurasi, hubungi admin', show_alert: true });
    }
    if (!VIP_PACKAGES[days]) return bot.answerCallbackQuery(query.id, { text: 'Paket tidak valid', show_alert: true });
    try {
      const saweriaService = require('../services/saweriaService');
      const ctx = {
        from: query.from,
        chat: { id: chatId },
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
      };
      await saweriaService.startPayment(ctx, query.from.id, days);
    } catch (e) {
      logger.error({ err: e.message }, 'QRIS start failed');
      return bot.sendMessage(chatId, `QRIS ${days} hari — hubungi admin untuk aktivasi.`);
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
  makePostRequest,
  sendInvoice,
  handleAdminPanel,
  handleBalance,
  handleVip,
  handleSelectPayment,
  handlePaymentAction,
  handlePreCheckout,
};
