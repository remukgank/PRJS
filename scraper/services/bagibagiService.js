"use strict";
// services/bagibagiService.js - payment otomatis via BagiBagi (worker browser).
// Adaptasi saweriaService.js: alih-alih curl ke API Saweria, semua operasi write
// (create donation, Payment/qris, check-transaction) dilakukan di dalam browser
// worker (scripts/bagibagi-worker.py) karena bagibagi memerlukan konteks
// Cloudflare managed challenge (cf-response) + x-authorization.
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { logger } = require('../logger');
const { VIP_PACKAGES } = require('./vipPackages');

const DEFAULT_WORKER_URL = 'http://127.0.0.1:8192';
const CHECK_INTERVAL_MS = 7000;
const MAX_WAIT_MINUTES = 15;
const MAX_CONSECUTIVE_ERRORS = 5;
const ZOMBIE_TTL_MS = (MAX_WAIT_MINUTES + 2) * 60 * 1000;
const WORKER_TIMEOUT_MS = 120000;

const SUPPORT_MESSAGES = [
  'gas min, semangat',
  'lanjut terus uploadnya',
  'dari grup, mantap',
  'tetap jaga kualitas',
  'sering nonton di sini',
  'semangat admin',
];

const FALLBACK_NAMES = ['Supporter', 'Donatur', 'Penikmat Drama', 'Penonton Setia'];

function workerUrl() {
  return (process.env.BAGIBAGI_WORKER_URL || DEFAULT_WORKER_URL).replace(/\/+$/, '');
}

async function workerFetch(route, opts = {}) {
  const url = `${workerUrl()}${route}`;
  const timeout = opts.timeout || WORKER_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(url, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`BagiBagi worker tidak merespons (${url}): ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error(`BagiBagi worker non-JSON (${res.status}): ${String(await res.text()).slice(0, 120)}`);
  }
  if (!res.ok && json && json.error) {
    const err = new Error(json.detail ? `${json.error}: ${json.detail}` : json.error);
    err.code = json.error;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`BagiBagi worker error ${res.status}`);
  }
  return json;
}

async function withRetry(fn, retries = 3, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err.code === 'captcha_unresolved') throw err;
      const isLast = i === retries - 1;
      if (isLast) throw err;
      const wait = delayMs * Math.pow(2, i);
      logger.warn(`BagiBagi retry ${i + 1}/${retries} after ${wait}ms: ${err.message}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const activeIntervals = {};
const processingPayments = new Map();

async function createDonation(amount, name, message) {
  return withRetry(async () => {
    const res = await workerFetch('/create', { method: 'POST', body: { amount, name, message } });
    if (!res.donationId || !res.qrString) {
      throw new Error('Worker /create response invalid');
    }
    return res;
  });
}

async function checkPaymentStatus(donationId) {
  let res;
  try {
    res = await workerFetch(`/status?donationId=${encodeURIComponent(donationId)}`);
  } catch (err) {
    throw err;
  }
  if (!res || !res.code) return null;
  return {
    code: String(res.code).trim().toUpperCase(),
    message: String(res.message || ''),
    amount: res.amount != null ? Number(res.amount) : null,
    reference: res.reference || '',
  };
}

async function abortDonation(donationId) {
  try {
    await workerFetch('/abort', { method: 'POST', body: { donationId }, timeout: 10000 });
  } catch (_) {}
}

function deleteQRFile(donationId) {
  const qrFile = path.join('/tmp', `qr_prjs_bagibagi_${donationId}.png`);
  try {
    if (fs.existsSync(qrFile)) fs.unlinkSync(qrFile);
  } catch (_) {}
}

function deleteQRMessage(ctx, chatId, photoMsgId) {
  if (!photoMsgId) return;
  ctx.telegram.deleteMessage(chatId, photoMsgId).catch(() => {});
}

async function cancelAndCleanup(ctx, donationId) {
  const active = activeIntervals[donationId];
  stopPolling(donationId);
  if (active?.userId) {
    processingPayments.delete(active.userId);
  }
  if (active?.photoMsgId && active?.chatId) {
    deleteQRMessage(ctx, active.chatId, active.photoMsgId);
  }
  if (donationId) {
    await abortDonation(donationId);
  }
}

async function generateQRImage(qrString, donationId) {
  const filePath = path.join('/tmp', `qr_prjs_bagibagi_${donationId}.png`);
  await QRCode.toFile(filePath, qrString, {
    width: 500,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' }
  });
  return filePath;
}

function formatRupiah(amount) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0
  }).format(amount);
}

function formatCountdown(secondsLeft) {
  const m = Math.floor(secondsLeft / 60);
  const s = secondsLeft % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function isProcessing(userId) {
  return processingPayments.has(userId.toString());
}

function stopPolling(donationId) {
  if (activeIntervals[donationId]) {
    clearTimeout(activeIntervals[donationId].id);
    if (activeIntervals[donationId].stopped) activeIntervals[donationId].stopped();
    delete activeIntervals[donationId];
  }
  deleteQRFile(donationId);
}

function stopAllPolling() {
  for (const donationId of Object.keys(activeIntervals)) {
    stopPolling(donationId);
  }
}

function cleanupProcessingPayment(userIdStr) {
  processingPayments.delete(userIdStr);
}

setInterval(() => {
  const now = Date.now();
  const zombies = Object.keys(activeIntervals).filter(
    (id) => now - activeIntervals[id].startedAt > ZOMBIE_TTL_MS
  );
  zombies.forEach((id) => {
    logger.warn({ donationId: id }, 'BagiBagi zombie interval killed');
    clearTimeout(activeIntervals[id].id);
    if (activeIntervals[id].stopped) activeIntervals[id].stopped();
    delete activeIntervals[id];
    deleteQRFile(id);
  });
}, 2 * 60 * 1000).unref();

async function startPayment(ctx, userId, days) {
  const userIdStr = userId.toString();
  const fallbackName = FALLBACK_NAMES[Math.floor(Math.random() * FALLBACK_NAMES.length)];
  const username = ctx.from.username || ctx.from.first_name || fallbackName;
  const donorName =
    [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') ||
    ctx.from.username ||
    fallbackName;
  const chatId = ctx.chat.id;

  const { BAGIBAGI_WORKER_URL, BAGIBAGI_RECEIVER_USERNAME } = process.env;
  if (!BAGIBAGI_RECEIVER_USERNAME) {
    await ctx.answerCbQuery('QRIS Bagibagi belum dikonfigurasi, hubungi admin', { show_alert: true });
    return;
  }

  if (processingPayments.has(userIdStr)) {
    const existing = processingPayments.get(userIdStr);
    const elapsed = Date.now() - existing.startTime;
    if (elapsed < 5 * 60 * 1000) {
      await ctx.answerCbQuery('Transaksi sedang berjalan, tunggu sebentar ya.', { show_alert: true });
      return;
    }
    processingPayments.delete(userIdStr);
  }

  const pkg = VIP_PACKAGES[days];
  if (!pkg) {
    await ctx.answerCbQuery('Paket tidak valid');
    return;
  }

  processingPayments.set(userIdStr, { startTime: Date.now(), donationId: null, status: 'calculating' });
  await ctx.answerCbQuery();

  let processingMsg;
  try {
    processingMsg = await ctx.reply(
      `⏳ <b>Memproses pembayaran...</b>\n\n` +
      `📦 Paket: ${days} hari VIP\n` +
      `💰 Harga: ${formatRupiah(pkg.price)}`,
      { parse_mode: 'HTML' }
    );

    const message = SUPPORT_MESSAGES[Math.floor(Math.random() * SUPPORT_MESSAGES.length)];
    const donation = await createDonation(pkg.price, donorName, message);

    const { donationId, qrString } = donation;
    const qrPath = await generateQRImage(qrString, donationId);

    await ctx.telegram.deleteMessage(chatId, processingMsg.message_id).catch(() => {});

    const photoMsg = await ctx.replyWithPhoto(
      qrPath,
      {
        caption:
          `🧾 <b>Detail Pembayaran VIP (BagiBagi)</b>\n\n` +
          `👤 User: <code>${userIdStr}</code>\n` +
          `📦 Paket: <b>${days} Hari VIP</b>\n` +
          `💰 Nominal: ${formatRupiah(pkg.price)}\n\n` +
          `📱 <b>Scan QR di atas pakai e-wallet / m-banking</b>\n` +
          `⏰ Berlaku: <b>${MAX_WAIT_MINUTES} menit</b>`,
        parse_mode: 'HTML'
      }
    );

    const statusMsg = await ctx.reply(
      `⏳ <b>Menunggu Pembayaran...</b>\n\n` +
      `🆔 ID: <code>${donationId}</code>\n` +
      `⏱ Sisa waktu: <b>${MAX_WAIT_MINUTES}:00</b>\n\n` +
      `<i>Otomatis aktif setelah pembayaran berhasil</i>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ Batalkan', callback_data: `act:bagibagi_cancel_${donationId}` }]
          ]
        }
      }
    );
    const photoMsgId = photoMsg.message_id;
    const statusMsgId = statusMsg.message_id;

    processingPayments.set(userIdStr, {
      startTime: processingPayments.get(userIdStr).startTime,
      donationId: donationId,
      status: 'polling'
    });

    pollStatus(ctx, donationId, chatId, statusMsgId, pkg.price, days, userIdStr, username, photoMsgId);

    const pollEntry = activeIntervals[donationId];
    if (pollEntry) {
      pollEntry.photoMsgId = photoMsgId;
      pollEntry.chatId = chatId;
      pollEntry.userId = userIdStr;
    }

    logger.info({ user: userIdStr, days, donationId }, 'BagiBagi payment started');
  } catch (err) {
    processingPayments.delete(userIdStr);
    logger.error({ err: err.message }, 'BagiBagi payment error');
    const isCaptcha = err.code === 'captcha_unresolved' || (err.message || '').includes('captcha');
    const errMsg = isCaptcha
      ? 'Verifikasi keamanan Cloudflare tidak selesai. Coba lagi nanti, atau pilih metode lain.'
      : 'Gagal membuat transaksi. Coba lagi nanti.';
    if (processingMsg) {
      await ctx.telegram.editMessageText(
        chatId, processingMsg.message_id, null,
        `❌ <b>Gagal Membuat Transaksi</b>\n\n${errMsg}`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Coba Lagi', callback_data: `act:qris_pkg_${days}` }],
              [{ text: '🔙 Kembali', callback_data: 'act:vip' }]
            ]
          }
        }
      ).catch(() => {});
    } else {
      await ctx.reply(`❌ <b>Gagal:</b> ${errMsg}`, { parse_mode: 'HTML' });
    }
  }
}

function pollStatus(ctx, donationId, chatId, msgId, amountRaw, days, userIdStr, username, photoMsgId) {
  const startTime = Date.now();
  const totalMs = MAX_WAIT_MINUTES * 60 * 1000;
  let lastEditedMinute = MAX_WAIT_MINUTES;
  let stopped = false;
  let consecutiveErrors = 0;
  const vipService = require('./vipService');

  const notifyAdmin = (text) => {
    if (typeof ctx.notify === 'function') {
      ctx.notify(text).catch(() => {});
    }
  };

  const _poll = async () => {
    if (stopped) return;

    const elapsed = Date.now() - startTime;
    const secondsLeft = Math.max(0, Math.floor((totalMs - elapsed) / 1000));

    try {
      const data = await checkPaymentStatus(donationId);
      if (!data) {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          stopPolling(donationId);
          processingPayments.delete(userIdStr);
          await ctx.telegram.editMessageText(
            chatId, msgId, null,
            `⚠️ <b>Kesalahan Sistem</b>\n\n` +
            `Gagal cek status pembayaran setelah ${MAX_CONSECUTIVE_ERRORS} kali.\n` +
            `BagiBagi API sedang bermasalah. Hubungi admin jika ada pertanyaan.`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
        return;
      }
      consecutiveErrors = 0;
      const code = data.code;
      const msg = data.message || '';
      const isPaid = code === '00' || (msg.toUpperCase() === 'SUCCESS' && code !== '01');
      const isPending = code === '01' || msg.toUpperCase() === 'PROCESS';
      const hasExpiredOp = secondsLeft <= 0;

      if (isPaid) {
        if (stopped) return;
        stopped = true;
        stopPolling(donationId);
        processingPayments.delete(userIdStr);
        deleteQRMessage(ctx, chatId, photoMsgId);

        const paidAmount = data.amount || amountRaw;

        try {
          await vipService.recordPayment({
            orderId: `bagibagi-${donationId}`,
            userId: userIdStr,
            username,
            amount: paidAmount,
            method: 'bagibagi_qris',
            vipDays: days,
            status: 'approved',
            message: `VIP ${days}h auto-approved`
          });
        } catch (dbErr) {
          logger.error({ err: dbErr.message }, 'Failed to record payment');
        }

        try {
          await vipService.addVipUser(userIdStr, days, {
            username,
            paymentMethod: 'bagibagi_qris',
            amount: paidAmount
          });
          notifyAdmin(
            `💳 <b>PEMBAYARAN BAGIBAGI BERHASIL</b>\n\n` +
            `👤 User: @${username} (<code>${userIdStr}</code>)\n` +
            `📦 Paket: <b>${days} hari VIP</b>\n` +
            `💰 Nominal: ${formatRupiah(paidAmount)}\n` +
            `🆔 Ref: <code>${donationId}</code>`
          );
          await ctx.telegram.editMessageText(
            chatId, msgId, null,
            `✅ <b>Pembayaran Berhasil!</b>\n\n` +
            `💰 Dibayar: ${formatRupiah(paidAmount)}\n` +
            `💎 <b>VIP ${days} hari langsung aktif!</b>\n\n` +
            `🎉 Selamat menikmati konten premium!\n` +
            `🆔 Ref: <code>${donationId}</code>`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '💎 Cek Status VIP', callback_data: 'act:vip' }]
                ]
              }
            }
          );
        } catch (vipErr) {
          logger.error({ err: vipErr.message }, 'Failed to activate VIP after payment');
          await ctx.telegram.editMessageText(
            chatId, msgId, null,
            `⚠️ <b>Pembayaran Diterima, VIP Gagal Aktif</b>\n\n` +
            `💰 Pembayaran: ${formatRupiah(paidAmount)} ✅\n` +
            `🔴 VIP belum aktif karena terjadi kesalahan sistem.\n\n` +
            `📌 Hubungi admin dengan referensi:\n<code>${donationId}</code>`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
          notifyAdmin(
            `🚨 <b>VIP ACTIVATION FAILED AFTER PAYMENT</b>\n\n` +
            `👤 User: @${username} (<code>${userIdStr}</code>)\n` +
            `📦 Paket: <b>${days} hari</b>\n` +
            `💰 Dibayar: ${formatRupiah(paidAmount)}\n` +
            `🆔 Ref: <code>${donationId}</code>\n` +
            `❌ Error: ${vipErr.message}\n\n` +
            `⚡ <b>Aktifkan manual:</b> <code>/addvip ${userIdStr} ${days}</code>`
          );
        }
      } else if (!isPending && !hasExpiredOp) {
        stopped = true;
        stopPolling(donationId);
        processingPayments.delete(userIdStr);
        deleteQRMessage(ctx, chatId, photoMsgId);
        await ctx.telegram.editMessageText(
          chatId, msgId, null,
          `❌ <b>Pembayaran Gagal / Dibatalkan</b>\n\nSilakan coba lagi.`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
[{ text: '🔄 Coba Lagi', callback_data: `bagibagi_pkg_${days}` }],
                [{ text: '🔙 Menu VIP', callback_data: 'act:vip' }]
              ]
            }
          }
        ).catch(() => {});
      } else if (hasExpiredOp) {
        stopped = true;
        stopPolling(donationId);
        processingPayments.delete(userIdStr);
        deleteQRMessage(ctx, chatId, photoMsgId);
        await ctx.telegram.editMessageText(
          chatId, msgId, null,
          `⏰ <b>Waktu Habis</b>\n\nQR sudah tidak valid (${MAX_WAIT_MINUTES} menit). Buat transaksi baru ya!`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Buat Transaksi Baru', callback_data: `act:qris_pkg_${days}` }],
                [{ text: '🔙 Menu VIP', callback_data: 'act:vip' }]
              ]
            }
          }
        ).catch(() => {});
      } else {
        const currentMinute = Math.floor(secondsLeft / 60);
        if (currentMinute < lastEditedMinute) {
          lastEditedMinute = currentMinute;
          await ctx.telegram.editMessageText(
            chatId, msgId, null,
            `⏳ <b>Menunggu Pembayaran...</b>\n\n` +
            `🆔 ID: <code>${donationId}</code>\n` +
            `⏱ Sisa waktu: <b>${formatCountdown(secondsLeft)}</b>\n\n` +
            `<i>Otomatis aktif setelah pembayaran berhasil</i>`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '❌ Batalkan', callback_data: `act:bagibagi_cancel_${donationId}` }]
                ]
              }
            }
          ).catch(() => {});
        }
      }
    } catch (pollErr) {
      consecutiveErrors++;
      logger.error({ err: pollErr.message }, 'BagiBagi poll error');
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        stopped = true;
        stopPolling(donationId);
        processingPayments.delete(userIdStr);
        deleteQRMessage(ctx, chatId, photoMsgId);
        await ctx.telegram.editMessageText(
          chatId, msgId, null,
          `⚠️ <b>Kesalahan Sistem</b>\n\n` +
          `Gagal cek status pembayaran setelah ${MAX_CONSECUTIVE_ERRORS} kali.\n` +
          `BagiBagi API sedang bermasalah. Hubungi admin jika ada pertanyaan.`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
    }

    if (!stopped) {
      const timerId = setTimeout(_poll, CHECK_INTERVAL_MS);
      if (activeIntervals[donationId]) {
        activeIntervals[donationId].id = timerId;
      }
    }
  };

  const timerId = setTimeout(_poll, CHECK_INTERVAL_MS);
  activeIntervals[donationId] = { id: timerId, startedAt: startTime, stopped: () => { stopped = true; } };
}

module.exports = {
  startPayment,
  stopPolling,
  stopAllPolling,
  isProcessing,
  cleanupProcessingPayment,
  cancelAndCleanup,
  activeIntervals,
};