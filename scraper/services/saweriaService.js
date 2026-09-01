"use strict";
// services/saweriaService.js - adaptasi fomo-drama/services/saweriaService.js untuk PRJS.
// Bedanya: pakai pool dari ../db, vipService lokal, config dari process.env, tanpa referral.
const { execFile } = require('child_process');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { logger } = require('../logger');
const { VIP_PACKAGES } = require('./vipPackages');

const SAWERIA_API = 'https://backend.saweria.co';
const CHECK_INTERVAL_MS = 7000;
const MAX_WAIT_MINUTES = 15;
const MAX_CONSECUTIVE_ERRORS = 5;
const ZOMBIE_TTL_MS = (MAX_WAIT_MINUTES + 2) * 60 * 1000;

const SUPPORT_MESSAGES = [
  'gas min, semangat',
  'lanjut terus uploadnya',
  'dari grup, mantap',
  'tetap jaga kualitas',
  'sering nonton di sini',
  'semangat admin',
];

const FALLBACK_NAMES = ['Supporter', 'Donatur', 'Penikmat Drama', 'Penonton Setia'];

const CURL_HEADERS = [
  '-H', 'Accept: */*',
  '-H', 'Accept-Encoding: gzip, deflate, br, zstd',
  '-H', 'Accept-Language: id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  '-H', 'DNT: 1',
  '-H', 'Origin: https://saweria.co',
  '-H', 'Priority: u=1, i',
  '-H', 'Referer: https://saweria.co/',
  '-H', 'Sec-Fetch-Dest: empty',
  '-H', 'Sec-Fetch-Mode: cors',
  '-H', 'Sec-Fetch-Site: same-site',
  '-H', 'sec-ch-ua: "Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  '-H', 'sec-ch-ua-mobile: ?0',
  '-H', 'sec-ch-ua-platform: "Windows"',
  '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
];

function curlPost(url, body) {
  return new Promise((resolve, reject) => {
    const args = [
      '-s', '--compressed', '-m', '30',
      '-X', 'POST', url,
      '-H', 'Content-Type: application/json',
      ...CURL_HEADERS,
      '-d', JSON.stringify(body),
    ];
    execFile('curl', args, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`curl error: ${err.message}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`Saweria API returned non-JSON: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

function curlGet(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '-s', '--compressed', '-m', '30',
      url,
      '-H', 'Referer: https://saweria.co/',
      '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
    ];
    execFile('curl', args, { maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`curl error: ${err.message}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`Non-JSON response: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

async function withRetry(fn, retries = 3, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = i === retries - 1;
      if (isLast) throw err;
      const wait = delayMs * Math.pow(2, i);
      logger.warn(`Saweria retry ${i + 1}/${retries} after ${wait}ms: ${err.message}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const activeIntervals = {};
const processingPayments = new Map();

async function calculateAmount(amount) {
  return withRetry(async () => {
    const payload = {
      agree: true,
      notUnderage: true,
      message: SUPPORT_MESSAGES[Math.floor(Math.random() * SUPPORT_MESSAGES.length)],
      amount,
      payment_type: 'qris',
      vote: '',
      giphy: null,
      yt: '',
      ytStart: 0,
      mediaType: null,
      image_guess: null,
      image_guess_answer: '',
      amountToPay: '',
      currency: 'IDR',
      pgFee: '',
      platformFee: '',
      customer_info: { first_name: 'Supporter', email: 'supporter@gmail.com', phone: '' }
    };
    const res = await curlPost(
      `${SAWERIA_API}/donations/${process.env.SAWERIA_USERNAME}/calculate_pg_amount`,
      payload
    );
    if (!res?.data?.amount_to_pay) throw new Error('calculateAmount response invalid');
    return res.data;
  });
}

async function createDonation(amount, email, name, message) {
  return withRetry(async () => {
    const payload = {
      agree: true,
      notUnderage: true,
      message: message || '-',
      amount,
      payment_type: 'qris',
      vote: '',
      currency: 'IDR',
      customer_info: { first_name: name, email, phone: '' }
    };
    const res = await curlPost(
      `${SAWERIA_API}/donations/snap/${process.env.SAWERIA_USER_ID}`,
      payload
    );
    if (!res?.data?.qr_string) throw new Error(res?.message || 'createDonation response invalid');
    return res.data;
  });
}

async function checkPaymentStatus(donationId) {
  return withRetry(async () => {
    const res = await curlGet(`${SAWERIA_API}/donations/qris/snap/${donationId}`);
    const d = res?.data;
    if (!d) return null;
    if (typeof d.id !== 'string' || typeof d.transaction_status !== 'string' || typeof d.amount_raw !== 'number') {
      logger.error({ msg: 'checkPaymentStatus: invalid response structure', id: typeof d.id, status: typeof d.transaction_status, amount: typeof d.amount_raw });
      return null;
    }
    return { id: d.id, status: d.transaction_status, amount: d.amount_raw, created_at: d.created_at };
  }, 5, 1000);
}

function deleteQRFile(donationId) {
  const qrFile = path.join('/tmp', `qr_prjs_${donationId}.png`);
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
}

async function generateQRImage(qrString, donationId) {
  const filePath = path.join('/tmp', `qr_prjs_${donationId}.png`);
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
    logger.warn({ donationId: id }, 'Saweria zombie interval killed');
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

  if (!process.env.SAWERIA_USERNAME || !process.env.SAWERIA_USER_ID) {
    await ctx.answerCbQuery('QRIS belum dikonfigurasi, hubungi admin', { show_alert: true });
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

    const calcData = await calculateAmount(pkg.price);
    const { amount_to_pay, pg_fee } = calcData;

    const nameKey = donorName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
    const email = `${nameKey || fallbackName.toLowerCase()}@gmail.com`;
    const message = SUPPORT_MESSAGES[Math.floor(Math.random() * SUPPORT_MESSAGES.length)];
    const donation = await createDonation(pkg.price, email, donorName, message);

    const { qr_string: qrString, id: donationId } = donation;
    const qrPath = await generateQRImage(qrString, donationId);

    await ctx.telegram.deleteMessage(chatId, processingMsg.message_id).catch(() => {});

    const photoMsg = await ctx.replyWithPhoto(
      qrPath,
      {
        caption:
          `🧾 <b>Detail Pembayaran VIP</b>\n\n` +
          `👤 User: <code>${userIdStr}</code>\n` +
          `📦 Paket: <b>${days} Hari VIP</b>\n` +
          `💰 Nominal: ${formatRupiah(pkg.price)}\n` +
          `💳 Biaya PG: ${formatRupiah(pg_fee)}\n` +
          `💵 <b>Total Bayar: ${formatRupiah(amount_to_pay)}</b>\n\n` +
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
            [{ text: '❌ Batalkan', callback_data: `act:saweria_cancel_${donationId}` }]
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

    pollStatus(ctx, donationId, chatId, statusMsgId, amount_to_pay, days, userIdStr, username, photoMsgId);

    const pollEntry = activeIntervals[donationId];
    if (pollEntry) {
      pollEntry.photoMsgId = photoMsgId;
      pollEntry.chatId = chatId;
      pollEntry.userId = userIdStr;
    }

    logger.info({ user: userIdStr, days, donationId }, 'Saweria payment started');
  } catch (err) {
    processingPayments.delete(userIdStr);
    logger.error({ err: err.message }, 'Saweria payment error');
    const errMsg = 'Gagal membuat transaksi. Coba lagi nanti.';
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
  const { pool } = require('../db');
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
            `Saweria API sedang bermasalah. Hubungi admin jika ada pertanyaan.`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
        }
        return;
      }
      consecutiveErrors = 0;
      const status = String(data.status || '').trim().toUpperCase();
      const paidStatuses = ['SUCCESS', 'SETTLEMENT', 'PAID', 'CAPTURE', 'COMPLETED', 'COMPLETE'];
      const failedStatuses = ['FAILED', 'EXPIRED', 'CANCEL', 'FAILURE', 'DENY', 'CANCELED', 'CANCELLED', 'VOID'];

      if (paidStatuses.includes(status)) {
        if (stopped) return;
        stopped = true;
        stopPolling(donationId);
        processingPayments.delete(userIdStr);
        deleteQRMessage(ctx, chatId, photoMsgId);

        try {
          const orderId = donationId || `qris_${Date.now()}_${userIdStr}`;
          await pool.query(
            `INSERT INTO payments (order_id, user_id, username, amount, method, vip_days, status, message, created_at, processed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
             ON CONFLICT (order_id) DO UPDATE SET status = 'approved', processed_at = NOW()`,
            [orderId, userIdStr, username, amountRaw, 'saweria_qris', days, 'approved', `VIP ${days}h auto-approved`]
          );
        } catch (dbErr) {
          logger.error({ err: dbErr.message }, 'Failed to record payment');
        }

        try {
          await vipService.addVipUser(userIdStr, days, {
            username,
            paymentMethod: 'saweria_qris',
            amount: amountRaw
          });
          notifyAdmin(
            `💳 <b>PEMBAYARAN SAWERIA BERHASIL</b>\n\n` +
            `👤 User: @${username} (<code>${userIdStr}</code>)\n` +
            `📦 Paket: <b>${days} hari VIP</b>\n` +
            `💰 Nominal: ${formatRupiah(amountRaw)}\n` +
            `🆔 Ref: <code>${donationId}</code>`
          );
          await ctx.telegram.editMessageText(
            chatId, msgId, null,
            `✅ <b>Pembayaran Berhasil!</b>\n\n` +
            `💰 Dibayar: ${formatRupiah(amountRaw)}\n` +
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
            `💰 Pembayaran: ${formatRupiah(amountRaw)} ✅\n` +
            `🔴 VIP belum aktif karena terjadi kesalahan sistem.\n\n` +
            `📌 Hubungi admin dengan referensi:\n<code>${donationId}</code>`,
            { parse_mode: 'HTML' }
          ).catch(() => {});
          notifyAdmin(
            `🚨 <b>VIP ACTIVATION FAILED AFTER PAYMENT</b>\n\n` +
            `👤 User: @${username} (<code>${userIdStr}</code>)\n` +
            `📦 Paket: <b>${days} hari</b>\n` +
            `💰 Dibayar: ${formatRupiah(amountRaw)}\n` +
            `🆔 Ref: <code>${donationId}</code>\n` +
            `❌ Error: ${vipErr.message}\n\n` +
            `⚡ <b>Aktifkan manual:</b> <code>/addvip ${userIdStr} ${days}</code>`
          );
        }
      } else if (failedStatuses.includes(status)) {
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
                [{ text: '🔄 Coba Lagi', callback_data: `act:qris_pkg_${days}` }],
                [{ text: '🔙 Menu VIP', callback_data: 'act:vip' }]
              ]
            }
          }
        ).catch(() => {});
      } else if (secondsLeft <= 0) {
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
                  [{ text: '❌ Batalkan', callback_data: `act:saweria_cancel_${donationId}` }]
                ]
              }
            }
          ).catch(() => {});
        }
      }
    } catch (pollErr) {
      consecutiveErrors++;
      logger.error({ err: pollErr.message }, 'Saweria poll error');
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        stopped = true;
        stopPolling(donationId);
        processingPayments.delete(userIdStr);
        deleteQRMessage(ctx, chatId, photoMsgId);
        await ctx.telegram.editMessageText(
          chatId, msgId, null,
          `⚠️ <b>Kesalahan Sistem</b>\n\n` +
          `Gagal cek status pembayaran setelah ${MAX_CONSECUTIVE_ERRORS} kali.\n` +
          `Saweria API sedang bermasalah. Hubungi admin jika ada pertanyaan.`,
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