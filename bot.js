/**
 * bot.js
 * Telegram bot untuk scraping + download video dari dramafren.org
 *
 * Mendukung Local Bot API Server (TELEGRAM_API_PORT) untuk upload hingga 2GB.
 */

const TelegramBotLib = require('node-telegram-bot-api');
const TelegramBot = TelegramBotLib.default || TelegramBotLib;
const { getVideoUrl, getAllEpisodes, destroySession } = require('./index');
const { downloadStream, downloadWithAria2c, mergeVideos, getVideoInfo, cleanupFiles, tempPath, fileSizeMb } = require('./downloader');
const { cleanupStaleSessions } = require('./dramafren');
const { isGofileUrl, isGofileDirectUrl, filenameFromGofileUrl, resolveGofileFirstFile } = require('./gofile');
const { isPixeldrainUrl, extractPixeldrainId, getPixeldrainInfo } = require('./pixeldrain');
const { getShareInfo, downloadShare, sanitize } = require('./ucdrive');
const { initDatabase, getFreeDownloadCount, incrementFreeDownload: dbIncrementFreeDownload, cleanupOldDownloads, getCachedFileId, setCachedFileId } = require('./db');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const axios = require('axios');
const { logger } = require('./logger');

function isUcDriveUrl(text) {
  return /(?:uc-share\.com|drive\.ucweb\.com)\/s\/[A-Za-z0-9]+/.test(text);
}
function ucShareId(text) {
  const m = text.match(/(?:uc-share\.com|drive\.ucweb\.com)\/s\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

process.on('unhandledRejection', (err) => {
  logger.error({ err: { message: err.message, stack: err.stack } }, 'Unhandled rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err: { message: err.message, stack: err.stack } }, 'Uncaught exception');
  process.exit(1);
});

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN tidak ditemukan!');
  process.exit(1);
}

const LOCAL_API_PORT = process.env.TELEGRAM_API_PORT;
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191';
const botOptions = { polling: false };

if (LOCAL_API_PORT) {
  botOptions.baseApiUrl = `http://127.0.0.1:${LOCAL_API_PORT}`;
  logger.info({ port: LOCAL_API_PORT, limit: '2 GB' }, 'Local API');
} else {
  logger.info('Telegram API publik (limit 50 MB)');
}

const API_BASE = LOCAL_API_PORT
  ? `http://127.0.0.1:${LOCAL_API_PORT}`
  : 'https://api.telegram.org';
const API_HTTP = require(LOCAL_API_PORT ? 'http' : 'https');

function apiPost(method, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const url = `${API_BASE}/bot${TOKEN}/${method}`;
    const req = API_HTTP.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.ok) resolve(json.result);
          else reject(new Error(json.description || `${method} failed`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendVideo(chatId, filePath, opts = {}, cacheInfo = null) {
  const { caption, supports_streaming, duration, width, height } = opts;
  const result = LOCAL_API_PORT
    ? await apiPost('sendVideo', {
        chat_id: chatId,
        video: `file://${filePath}`,
        caption,
        supports_streaming,
        ...(duration && { duration }),
        ...(width && { width }),
        ...(height && { height }),
      })
    : await bot.sendVideo(chatId, filePath, {
        caption,
        supports_streaming,
        ...(duration && { duration }),
        ...(width && { width }),
        ...(height && { height }),
      });
  if (cacheInfo) {
    const fileId = result?.video?.file_id;
    if (fileId) setCachedFileId(cacheInfo.urlHash, cacheInfo.source, fileId, 'video', cacheInfo.fileName).catch(() => {});
  }
  return result;
}

async function sendAudio(chatId, filePath, opts = {}, cacheInfo = null) {
  const { caption } = opts;
  const result = LOCAL_API_PORT
    ? await apiPost('sendAudio', {
        chat_id: chatId,
        audio: `file://${filePath}`,
        caption,
      })
    : await bot.sendAudio(chatId, filePath, { caption });
  if (cacheInfo) {
    const fileId = result?.audio?.file_id;
    if (fileId) setCachedFileId(cacheInfo.urlHash, cacheInfo.source, fileId, 'audio', cacheInfo.fileName).catch(() => {});
  }
  return result;
}

async function sendDocument(chatId, filePath, opts = {}, cacheInfo = null) {
  const { caption } = opts;
  const result = LOCAL_API_PORT
    ? await apiPost('sendDocument', {
        chat_id: chatId,
        document: `file://${filePath}`,
        caption,
      })
    : await bot.sendDocument(chatId, filePath, { caption });
  if (cacheInfo) {
    const fileId = result?.document?.file_id;
    if (fileId) setCachedFileId(cacheInfo.urlHash, cacheInfo.source, fileId, 'document', cacheInfo.fileName).catch(() => {});
  }
  return result;
}

async function sendPhoto(chatId, filePath, opts = {}) {
  const { caption } = opts;
  return LOCAL_API_PORT
    ? await apiPost('sendPhoto', {
        chat_id: chatId,
        photo: `file://${filePath}`,
        caption,
        parse_mode: 'HTML',
      })
    : await bot.sendPhoto(chatId, filePath, { caption, parse_mode: 'HTML' });
}

const MAX_UPLOAD_MB = LOCAL_API_PORT ? 2000 : 49;

const ADMIN_IDS = (process.env.ADMIN_USER_IDS || '').split(',').map(Number).filter(Boolean);
const STAR_PRICE = Number(process.env.STAR_PRICE) || 10;
const FREE_DOWNLOAD_LIMIT = Number(process.env.FREE_DOWNLOAD_LIMIT) || 3;
const bot = new TelegramBot(TOKEN, botOptions);
const sessions = new Map();
const aiChatSessions = new Map();

// ─── Free download tracker (database-backed) ──────────────────────────────────

async function hasFreeDownload(userId) {
  if (isAdmin(userId)) return true;
  const count = await getFreeDownloadCount(userId);
  return count < FREE_DOWNLOAD_LIMIT;
}

async function getRemainingFreeDownloads(userId) {
  if (isAdmin(userId)) return Infinity;
  const count = await getFreeDownloadCount(userId);
  return Math.max(0, FREE_DOWNLOAD_LIMIT - count);
}

async function incrementFreeDownload(userId) {
  return dbIncrementFreeDownload(userId);
}

// ─── sendRichMessage helper ──────────────────────────────────────────────────

/**
 * Kirim pesan dengan format HTML/Markdown via sendRichMessage.
 * Support cloud API dan local API.
 * @param {number} chatId
 * @param {string} content - HTML atau Markdown content
 * @param {object} opts - { format: 'html'|'markdown', is_rtl?: boolean }
 */
async function sendRichMessage(chatId, content, opts = {}) {
  const { format = 'html', is_rtl = false, reply_markup, messageThreadId, replyToMessageId } = opts;

  const payload = {
    chat_id: chatId,
    rich_message: {
      [format]: content,
      is_rtl,
      skip_entity_detection: false,
    },
  };

  if (reply_markup) payload.reply_markup = reply_markup;
  if (messageThreadId) payload.message_thread_id = messageThreadId;
  if (replyToMessageId) {
    payload.reply_parameters = { message_id: replyToMessageId };
  }

  const baseUrl = LOCAL_API_PORT
    ? `http://127.0.0.1:${LOCAL_API_PORT}`
    : 'https://api.telegram.org';

  const http = require(LOCAL_API_PORT ? 'http' : 'https');

  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const url = `${baseUrl}/bot${TOKEN}/sendRichMessage`;
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json.ok) resolve(json.result);
            else reject(new Error(json.description || 'sendRichMessage failed'));
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── sendRichMessageDraft (streaming) ────────────────────────────────────────

/**
 * Kirim/update draft via sendRichMessageDraft (streaming).
 * Draft bersifat ephemeral (30 detik preview).
 * @param {number} chatId
 * @param {number} draftId - ID draft (harus non-zero, gunakan timestamp)
 * @param {string} content - HTML atau Markdown content
 * @param {object} opts - { format: 'html'|'markdown', messageThreadId?: number }
 */
async function sendDraft(chatId, draftId, content, opts = {}) {
  const { format = 'html', messageThreadId } = opts;

  const payload = {
    chat_id: chatId,
    draft_id: draftId,
    rich_message: {
      [format]: content,
    },
  };

  if (messageThreadId) {
    payload.message_thread_id = messageThreadId;
  }

  const baseUrl = LOCAL_API_PORT
    ? `http://127.0.0.1:${LOCAL_API_PORT}`
    : 'https://api.telegram.org';

  const http = require(LOCAL_API_PORT ? 'http' : 'https');

  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const url = `${baseUrl}/bot${TOKEN}/sendRichMessageDraft`;
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json.ok) resolve(json.result);
            else reject(new Error(json.description || 'sendRichMessageDraft failed'));
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Persist draft ke chat via sendRichMessage.
 * @param {number} chatId
 * @param {string} content - HTML atau Markdown content (final)
 * @param {object} opts - { format?: 'html'|'markdown', messageThreadId?: number, replyToMessageId?: number }
 */
async function finalizeDraft(chatId, content, opts = {}) {
  const { format = 'html', messageThreadId, replyToMessageId } = opts;

  const payload = {
    chat_id: chatId,
    rich_message: {
      [format]: content,
    },
  };

  if (messageThreadId) {
    payload.message_thread_id = messageThreadId;
  }

  if (replyToMessageId) {
    payload.reply_parameters = {
      message_id: replyToMessageId,
    };
  }

  const baseUrl = LOCAL_API_PORT
    ? `http://127.0.0.1:${LOCAL_API_PORT}`
    : 'https://api.telegram.org';

  const http = require(LOCAL_API_PORT ? 'http' : 'https');

  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const url = `${baseUrl}/bot${TOKEN}/sendRichMessage`;
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json.ok) resolve(json.result);
            else reject(new Error(json.description || 'sendRichMessage failed'));
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Auto-detect content type:
 * - Table (HTML table atau markdown table) → sendRichMessage native
 * - Short message (< threshold) → skip draft
 * - Long message → streaming draft
 */
function markdownToHtml(md) {
  return md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre>$2</pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_]+)__/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/_([^_]+)_/g, '<i>$1</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\n{2,}/g, '<br><br>');
}

function detectContentType(text, shortThreshold = 100) {
  // Table: HTML <table> atau markdown table (header|header|header + ---|---|---)
  const isTable = /<table[\s>]/i.test(text) ||
    (/^[\s]*\|.+\|[\s]*$/m.test(text) && /^[\s]*\|[-:\s|]+\|[\s]*$/m.test(text));
  const isShort = text.length < shortThreshold;
  return { isTable, isShort };
}

/**
 * Orchestrate streaming: draft → AI call → finalize.
 * @param {number} chatId
 * @param {Function} aiCall - Async function yang return { text: string }
 * @param {object} opts - { format?, messageThreadId?, shortThreshold? }
 */
async function sendStreaming(chatId, aiCall, opts = {}) {
  const { format = 'html', messageThreadId, shortThreshold = 100 } = opts;
  const draftId = Date.now();

  // Mulai draft dengan thinking placeholder
  const thinkingContent = format === 'html'
    ? '<tg-thinking>Admin sedang mengetik</tg-thinking>'
    : '*Admin sedang mengetik*';

  try {
    await sendDraft(chatId, draftId, thinkingContent, { format, messageThreadId });
  } catch (err) {
    logger.error({ chatId, err: err.message }, 'sendDraft failed, fallback to sendMessage');
    // Fallback ke sendMessage biasa
    const thinkingParseMode = format === 'html' ? 'HTML' : 'Markdown';
    const msg = await bot.sendMessage(chatId, thinkingContent, { parse_mode: thinkingParseMode });

    // Lanjut AI call dan edit message
    const result = await aiCall();
    const { isTable, isShort } = detectContentType(result.text, shortThreshold);

    if (isShort || isTable) {
      await bot.editMessageText(result.text, {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: thinkingParseMode,
      }).catch(() => {});
    } else {
      // Long message — finalize via sendRichMessage
      await finalizeDraft(chatId, result.text, { format, messageThreadId }).catch(() => {});
    }
    return { messageId: msg.message_id, text: result.text, streamed: false };
  }

  // AI call
  const result = await aiCall();
  const { isTable, isShort } = detectContentType(result.text, shortThreshold);

  // Auto-detect: table → sendRichMessage native (persist langsung)
  if (isTable) {
    const msg = await finalizeDraft(chatId, result.text, { format, messageThreadId });
    return { messageId: msg?.message_id, text: result.text, streamed: false };
  }

  // Auto-detect: short message → skip draft, langsung kirim (persist)
  if (isShort) {
    const msg = await finalizeDraft(chatId, result.text, { format, messageThreadId });
    return { messageId: msg?.message_id, text: result.text, streamed: false };
  }

  // Long message → update draft dulu, lalu finalize untuk persist
  try {
    await sendDraft(chatId, draftId, result.text, { format, messageThreadId });
    // Wajib finalize untuk persist draft ke chat
    const msg = await finalizeDraft(chatId, result.text, { format, messageThreadId });
    return { messageId: msg?.message_id, text: result.text, streamed: true };
  } catch (err) {
    // Fallback ke finalizeDraft langsung
    const msg = await finalizeDraft(chatId, result.text, { format, messageThreadId });
    return { messageId: msg?.message_id, text: result.text, streamed: false };
  }
}

function isAdmin(userId) {
  if (ADMIN_IDS.length === 0) {
    logger.warn('ADMIN_USER_IDS kosong — deny all untuk keamanan');
    return false;
  }
  return ADMIN_IDS.includes(Number(userId));
}

// ─── URL cache untuk gofile/pixeldrain (callback_data 64 bytes, URL bisa >100) ──────────
const urlCache = new Map(); // shortId -> url
let urlCacheCounter = 0;
function cacheUrl(url) {
  if (urlCache.size > 500) {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [k, v] of urlCache) { if (v.ts < cutoff) urlCache.delete(k); }
  }
  const id = String(++urlCacheCounter);
  urlCache.set(id, { url, ts: Date.now() });
  return id;
}
function resolveUrl(id) {
  const entry = urlCache.get(String(id));
  return entry ? entry.url : null;
}

function makePostRequest(urlPath, payload) {
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

async function sendInvoice(chatId, title, description, payload, price) {
  return makePostRequest('sendInvoice', {
    chat_id: chatId,
    title: title.slice(0, 32),
    description: description.slice(0, 255),
    payload,
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: 'Download access', amount: price }],
  });
}

async function waitForApi(port, maxRetries = 30) {
  const http = require('http');
  for (let i = 0; i < maxRetries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
          res.resume();
          resolve();
        });
        req.on('error', reject);
        req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return true;
    } catch {
      logger.info({ retry: i + 1, maxRetries }, 'Menunggu Local API...');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return false;
}

async function waitForFlareSolverr(maxRetries = 30) {
  const http = require('http');
  for (let i = 0; i < maxRetries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`${FLARESOLVERR_URL}/`, (res) => {
          res.resume();
          resolve();
        });
        req.on('error', reject);
        req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return true;
    } catch {
      logger.info({ retry: i + 1, maxRetries }, 'Menunggu FlareSolverr...');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return false;
}

(async () => {
  logger.info('Menunggu FlareSolverr...');
  const flareReady = await waitForFlareSolverr();
  if (!flareReady) {
    const required = /^(1|true|yes)$/i.test(process.env.FLARESOLVERR_REQUIRED || '');
    if (required) {
      logger.fatal({ url: FLARESOLVERR_URL }, 'FlareSolverr tidak merespon');
      process.exit(1);
    }
    logger.warn(
      { url: FLARESOLVERR_URL },
      'FlareSolverr tidak tersedia; melanjutkan dengan request langsung (set FLARESOLVERR_REQUIRED=true untuk mode strict)',
    );
  } else {
    logger.info('FlareSolverr siap');
  }

  if (LOCAL_API_PORT) {
    const ready = await waitForApi(LOCAL_API_PORT);
    if (!ready) {
      logger.fatal({ port: LOCAL_API_PORT }, 'Local API tidak merespon');
      process.exit(1);
    }
    logger.info({ port: LOCAL_API_PORT }, 'Local API siap');
  }

  logger.info('Bot running');
  await cleanupStaleSessions();
  bot.startPolling();
  logger.info('Polling started, waiting for messages...');

  const FREQUENT_ERRORS = new Map();
  const ERROR_THRESHOLD = 5;
  const ERROR_WINDOW_MS = 300000;
  const originalError = logger.error.bind(logger);
  logger.error = function enhancedError(...args) {
    const msg = args[args.length - 1] || 'unknown';
    const now = Date.now();
    const key = typeof msg === 'string' ? msg : JSON.stringify(msg);
    const entries = FREQUENT_ERRORS.get(key) || [];
    const recent = entries.filter(t => now - t < ERROR_WINDOW_MS);
    recent.push(now);
    FREQUENT_ERRORS.set(key, recent);
    if (recent.length >= ERROR_THRESHOLD) {
      logger.warn({ errorPattern: key, count: recent.length, windowMs: ERROR_WINDOW_MS }, 'Error threshold reached');
      FREQUENT_ERRORS.set(key, []);
    }
    return originalError.apply(logger, args);
  };

  function checkDiskSpace() {
    const df = require('child_process').execFileSync('df', ['-B1', '--output=avail', '/home/runner/workspace'], { encoding: 'utf8' });
    const avail = Number(df.trim().split('\n')[1]);
    const availGb = (avail / 1e9).toFixed(1);
    if (avail < 500 * 1024 * 1024) {
      logger.fatal({ availableGb: availGb }, 'Disk space critical — shutting down');
      process.exit(1);
    }
    if (avail < 5 * 1024 * 1024 * 1024) {
      logger.warn({ availableGb: availGb }, 'Disk space low');
    }
    return avail;
  }
  checkDiskSpace();
  setInterval(checkDiskSpace, 600000);

  // Initialize database and cleanup old downloads
  await initDatabase();
  setInterval(cleanupOldDownloads, 60 * 60 * 1000); // Cleanup setiap jam

  process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down...');
    bot.stopPolling();
    await destroySession();
    logger.info('Shutdown complete');
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down...');
    bot.stopPolling();
    await destroySession();
    logger.info('Shutdown complete');
    process.exit(0);
  });

// ─── HTML Progress ────────────────────────────────────────────────────────────

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

class Progress {
  constructor(chatId, text) {
    this.chatId = chatId;
    this.text = text;
    this.msgId = null;
    this.frame = 0;
    this.t0 = Date.now();
    this.timer = null;
    this.editing = false;
  }

  async start() {
    try {
      const msg = await bot.sendMessage(this.chatId, this.render(), { parse_mode: 'HTML' });
      this.msgId = msg.message_id;
    } catch (err) {
      logger.error({ chatId: this.chatId, err: err.message }, 'Progress start failed');
    }
    this.timer = setInterval(() => this.tick(), 3000);
    return this;
  }

  render() {
    const sec = Math.floor((Date.now() - this.t0) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    return `<code>${FRAMES[this.frame % 10]}</code> ${this.text}\n⏱ ${mm}:${ss}`;
  }

  async tick() {
    if (this.editing || !this.msgId) return;
    this.editing = true;
    this.frame++;
    try {
      await bot.editMessageText(this.render(), {
        chat_id: this.chatId,
        message_id: this.msgId,
        parse_mode: 'HTML',
      });
    } catch {}
    this.editing = false;
  }

  update(text) {
    this.text = text;
  }

  async done(text) {
    clearInterval(this.timer);
    const sec = Math.floor((Date.now() - this.t0) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    logger.info({ chatId: this.chatId, duration: sec, status: 'done' }, text);
    if (this.msgId) {
      await bot.editMessageText(`✅ ${text}\n⏱ ${mm}:${ss}`, {
        chat_id: this.chatId,
        message_id: this.msgId,
      }).catch(() => {});
    }
  }

  async fail(text) {
    clearInterval(this.timer);
    const sec = Math.floor((Date.now() - this.t0) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    logger.error({ chatId: this.chatId, duration: sec, status: 'fail' }, text);
    if (this.msgId) {
      await bot.editMessageText(`❌ ${text}\n⏱ ${mm}:${ss}`, {
        chat_id: this.chatId,
        message_id: this.msgId,
      }).catch(() => {});
    }
  }
}

// ─── RichProgress: Progress dengan rich message (table format) ────────────────

const STATUS_ICONS = {
  pending: '⏳',
  scrape: '🔍',
  download: '📥',
  merge: '🗜️',
  upload: '📤',
  done: '✅',
  fail: '❌',
};

class RichProgress {
  constructor(chatId, title, episodes) {
    this.chatId = chatId;
    this.title = title;
    this.msgId = null;
    this.t0 = Date.now();
    this.timer = null;
    this.editing = false;

    // Track status tiap episode
    this.episodes = episodes.map(ep => ({
      ep: ep.ep || ep,
      status: 'pending',
      detail: '',
      size: 0,
    }));
  }

  renderRichMessage() {
    const sec = Math.floor((Date.now() - this.t0) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');

    const doneCount = this.episodes.filter(e => e.status === 'done').length;
    const failCount = this.episodes.filter(e => e.status === 'fail').length;
    const total = this.episodes.length;
    let _totalPct = 0;
    for (const e of this.episodes) {
      if (e.status === 'done') { _totalPct += 100; }
      else { const m = String(e.detail || '').match(/(\d+)%/); if (m) _totalPct += parseInt(m[1], 10); }
    }
    const progress = total > 0 ? Math.round(_totalPct / total) : 0;

    // Build HTML table for sendRichMessage
    const rows = this.episodes.map(e => {
      const icon = STATUS_ICONS[e.status] || '⏳';
      const detail = e.detail ? ` — ${e.detail}` : '';
      const size = e.size > 0 ? ` (${e.size})` : '';
      return `<tr><td>${icon} ${e.status}</td><td>${e.ep}${detail}${size}</td></tr>`;
    }).join('');

    return `<b>📥 ${this.title}</b>\n<code>${'█'.repeat(Math.floor(progress / 5))}${'░'.repeat(20 - Math.floor(progress / 5))}</code> ${progress}%\n\n<table><tr><th>Status</th><th>Episode</th></tr>${rows}</table>\n\n⏱ ${mm}:${ss} | ✅ ${doneCount}/${total}${failCount > 0 ? ` | ❌ ${failCount}` : ''}`;
  }

  render() {
    const sec = Math.floor((Date.now() - this.t0) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');

    const doneCount = this.episodes.filter(e => e.status === 'done').length;
    const failCount = this.episodes.filter(e => e.status === 'fail').length;
    const total = this.episodes.length;
    let _totalPct = 0;
    for (const e of this.episodes) {
      if (e.status === 'done') { _totalPct += 100; }
      else { const m = String(e.detail || '').match(/(\d+)%/); if (m) _totalPct += parseInt(m[1], 10); }
    }
    const progress = total > 0 ? Math.round(_totalPct / total) : 0;

    // Build episode list (fallback for editMessageText)
    const lines = this.episodes.map(e => {
      const icon = STATUS_ICONS[e.status] || '⏳';
      const detail = e.detail ? ` — ${e.detail}` : '';
      const size = e.size > 0 ? ` (${e.size})` : '';
      return `${icon} ${e.ep}${detail}${size}`;
    });

    return [
      `<b>📥 ${this.title}</b>`,
      `<code>${'█'.repeat(Math.floor(progress / 5))}${'░'.repeat(20 - Math.floor(progress / 5))}</code> ${progress}%`,
      '',
      lines.join('\n'),
      '',
      `⏱ ${mm}:${ss} | ✅ ${doneCount}/${total}` + (failCount > 0 ? ` | ❌ ${failCount}` : ''),
    ].join('\n');
  }

  async start() {
    try {
      // sendRichMessage with html field (correct InputRichMessage format)
      const baseUrl = LOCAL_API_PORT
        ? `http://127.0.0.1:${LOCAL_API_PORT}`
        : 'https://api.telegram.org';
      const http = require(LOCAL_API_PORT ? 'http' : 'https');
      const htmlContent = this.renderRichMessage();

      const payload = JSON.stringify({
        chat_id: this.chatId,
        rich_message: {
          html: htmlContent,
        },
      });

      const msg = await new Promise((resolve, reject) => {
        const url = `${baseUrl}/bot${TOKEN}/sendRichMessage`;
        const req = http.request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            try {
              const json = JSON.parse(body);
              if (json.ok) resolve(json.result);
              else reject(new Error(json.description || 'sendRichMessage failed'));
            } catch (e) { reject(e); }
          });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });

      this.msgId = msg?.message_id;
    } catch (err) {
      logger.error({ chatId: this.chatId, err: err.message }, 'RichProgress start failed, fallback to sendMessage');
      // Fallback ke sendMessage biasa
      try {
        const msg = await bot.sendMessage(this.chatId, this.render(), { parse_mode: 'HTML' });
        this.msgId = msg.message_id;
      } catch {}
    }
    this.timer = setInterval(() => this.tick(), 5000);
    return this;
  }

  async tick() {
    if (this.editing || !this.msgId) return;
    this.editing = true;
    try {
      // editMessageText with rich_message (html field)
      const baseUrl = LOCAL_API_PORT
        ? `http://127.0.0.1:${LOCAL_API_PORT}`
        : 'https://api.telegram.org';
      const http = require(LOCAL_API_PORT ? 'http' : 'https');
      const htmlContent = this.renderRichMessage();

      const payload = JSON.stringify({
        chat_id: this.chatId,
        message_id: this.msgId,
        rich_message: {
          html: htmlContent,
        },
      });

      await new Promise((resolve, reject) => {
        const url = `${baseUrl}/bot${TOKEN}/editMessageText`;
        const req = http.request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            try {
              const json = JSON.parse(body);
              if (json.ok) resolve(json.result);
              else reject(new Error(json.description || 'editMessageText failed'));
            } catch (e) { reject(e); }
          });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    } catch {
      // Fallback ke editMessageText biasa
      try {
        await bot.editMessageText(this.render(), {
          chat_id: this.chatId,
          message_id: this.msgId,
          parse_mode: 'HTML',
        });
      } catch {}
    }
    this.editing = false;
  }

  updateEpisode(ep, status, detail = '', size = 0) {
    const item = this.episodes.find(e => e.ep === ep);
    if (item) {
      item.status = status;
      item.detail = detail;
      item.size = size;
    }
  }

  async done() {
    clearInterval(this.timer);
    const sec = Math.floor((Date.now() - this.t0) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    const doneCount = this.episodes.filter(e => e.status === 'done').length;
    const failCount = this.episodes.filter(e => e.status === 'fail').length;

    logger.info({ chatId: this.chatId, duration: sec, done: doneCount, fail: failCount }, 'RichProgress done');

    if (this.msgId) {
      const finalContent = [
        `<b>✅ ${this.title} — Selesai</b>`,
        '',
        `Total: ${this.episodes.length} episode`,
        `Berhasil: ${doneCount}` + (failCount > 0 ? ` | Gagal: ${failCount}` : ''),
        `⏱ ${mm}:${ss}`,
      ].join('\n');

      await bot.editMessageText(finalContent, {
        chat_id: this.chatId,
        message_id: this.msgId,
        parse_mode: 'HTML',
      }).catch(() => {});
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function parseDramaUrl(text) {
  const m = text.match(/https?:\/\/([^.\s]+)\.dramafren\.org[^\s]*/i);
  if (!m) return null;
  try {
    const url = new URL(m[0]);
    const subdomain = m[1].toLowerCase();
    return {
      subdomain,
      page: url.searchParams.get('page') || 'watch',
      id: url.searchParams.get('id') || '',
      slug: url.searchParams.get('slug') || '',
      ep: Number(url.searchParams.get('ep') || 1),
      sv: Number(url.searchParams.get('sv') || 1),
      lang: url.searchParams.get('lang') || 'id',
    };
  } catch { return null; }
}

function mainMenuKeyboard(isAdminUser = false) {
  const buttons = [
    [{ text: '📊 Status Server', callback_data: 'act:status' }],
  ];
  if (isAdminUser) {
    buttons.unshift([{ text: '💬 Live Chat', callback_data: 'act:ai' }]);
    buttons.push([{ text: '⭐ Cek Saldo Stars', callback_data: 'act:balance' }]);
  }
  buttons.push([{ text: '❓ Bantuan', callback_data: 'act:help' }]);
  return { inline_keyboard: buttons };
}

function mainActionKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📥 Download semua — kirim per episode', callback_data: 'act:per_ep' }],
      [{ text: '🗜 Download semua — gabung per 10 ep', callback_data: 'act:merge10' }],
      [{ text: '🔢 Pilih episode tertentu', callback_data: 'act:list' }],
      [{ text: '💬 Live Chat', callback_data: 'act:ai' }],
      [{ text: '🏠 Menu Utama', callback_data: 'act:main_menu' }],
    ],
  };
}

function aiKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '⬅️ Kembali ke menu utama', callback_data: 'act:ai_exit' }],
    ],
  };
}

function balanceKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '💳 Tarik Saldo via Fragment', url: 'https://fragment.com/' }],
      [{ text: '🏠 Menu Utama', callback_data: 'act:main_menu' }],
    ],
  };
}

function episodeListKeyboard(episodes) {
  const shown = episodes.slice(0, 48);
  const rows = [];
  for (let i = 0; i < shown.length; i += 6) {
    rows.push(
      shown.slice(i, i + 6).map((e) => ({
        text: `Ep ${e.ep}`,
        callback_data: `ep:${e.ep}`,
      }))
    );
  }
  rows.push([{ text: '⬅️ Kembali', callback_data: 'act:back' }]);
  return { inline_keyboard: rows };
}

// ─── Scrape URL (tanpa download) ─────────────────────────────────────────────

async function scrapeAndReport(chatId, subdomain, id, slug, ep, sv, lang) {
  const p = await new Progress(chatId, `Ep ${ep} — mengambil URL`).start();

  try {
    const r = await getVideoUrl(subdomain, id, slug, ep, sv, lang);
    const lines = [
      `🎬 **${r.title || '-'}**`,
      `📺 ${subdomain}.dramafren.org`,
      `🎞 Episode: ${ep} | Server: ${r.server}`,
      '',
    ];
    if (r.videoUrl) {
      lines.push('✅ Video URL:');
      lines.push(`\`${r.videoUrl}\``);
    } else {
      lines.push('❌ Video URL tidak ditemukan');
    }
    if (r.subtitleUrl) {
      lines.push('', '📝 Subtitle:', `\`${r.subtitleUrl}\``);
    }

    await p.done(`Ep ${ep} — URL ditemukan`);
    await sendRichMessage(chatId, lines.join('\n'), { format: 'markdown' });
    return r;
  } catch (err) {
    logger.error({ chatId, episode: ep, subdomain, err: { message: err.message, stack: err.stack } }, 'Scrape failed');
    await p.fail(`Ep ${ep}: ${err.message.slice(0, 100)}`);
    return null;
  }
}

// ─── GoFile handler ───────────────────────────────────────────────────────────

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm']);
const AUDIO_EXTS = new Set(['.mp3', '.aac', '.ogg', '.m4a', '.wav']);

function hashUrl(url) {
  return crypto.createHash('md5').update(url).digest('hex');
}

function getFileTypeFromExt(ext) {
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return 'document';
}

function cleanCaption(name) {
  let s = name.replace(/\.(mp4|mkv|mov|avi|webm|mp3|aac|ogg|m4a|wav)$/i, '');
  s = s.replace(/^[a-zA-Z0-9]{6,10}[-_]/, '');
  s = s.replace(/[-_.]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.split(' ').filter(w => {
    if (w.length < 6 || w.length > 10) return true;
    // Hapus mixed case (e.g. "rjfBour" - random hash)
    if (/[a-z]/.test(w) && /[A-Z]/.test(w)) return false;
    // Hapus all lowercase length 6-10 (e.g. "kuronime" - source name)
    if (/^[a-z]+$/.test(w)) return false;
    return true;
  }).join(' ');
  // Handle "Ep15" → "Ep 15" dulu, baru "title15" → "title Ep 15"
  s = s.replace(/\b(ep)(\d{1,3})$/gi, '$1 $2');
  s = s.replace(/([a-zA-Z])(\d{1,3})$/, '$1 Ep $2');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Handle a UC Drive share link: scrape + download all videos + send to chat.
 */
async function handleUcDriveUrl(chatId, text) {
  const shareId = ucShareId(text);
  if (!shareId) {
    return bot.sendMessage(chatId, '⚠️ Link UC Drive tidak valid.');
  }
  logger.info({ chatId, shareId }, 'UC Drive share requested');

  const status = await bot.sendMessage(chatId, '🔍 Mengambil info share UC Drive...');
  let outDir;
  try {
    const info = await getShareInfo(shareId);
    const videoCount = info.files.length;
    await bot.editMessageText(
      `📋 <b>${info.title}</b>\n🎞 ${videoCount} file ditemukan\n⬇️ Memulai download...`,
      { chat_id: chatId, message_id: status.message_id, parse_mode: 'HTML' }
    );
    outDir = tempPath(`ucdrive_${shareId}`);
    fs.mkdirSync(outDir, { recursive: true });

    const result = await downloadShare(shareId, outDir, async (done, total, msg) => {
      if (done % 1 === 0) {
        await bot.editMessageText(`⬇️ Download ${done}/${total}\n${msg}`, {
          chat_id: chatId, message_id: status.message_id, parse_mode: 'HTML',
        }).catch(() => {});
      }
    });

    await bot.editMessageText(
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
        await sendVideo(chatId, f, {
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

    await sendRichMessage(chatId, `📤 Terkirim ${sent} video (${fail} gagal).`, { format: 'markdown' });
  } catch (err) {
    logger.error({ chatId, shareId, err: { message: err.message, stack: err.stack } }, 'UC Drive handler failed');
    await bot.editMessageText(`❌ Gagal: ${err.message.slice(0, 150)}`, {
      chat_id: chatId, message_id: status.message_id, parse_mode: 'HTML',
    }).catch(() => {});
  } finally {
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
  }
}

async function handleGofileUrl(chatId, url) {
  const gofileToken = (process.env.GOFILE_TOKEN || '').trim();
  const urlHash = hashUrl(url);
  const extraHeaders = {
    'Referer': 'https://gofile.io/',
    ...(gofileToken && { 'Authorization': `Bearer ${gofileToken}` }),
  };

  if (isGofileDirectUrl(url)) {
    const fileName = filenameFromGofileUrl(url);
    const outPath = tempPath(fileName);
    const cap = cleanCaption(fileName);
    const cacheInfo = { urlHash, source: 'gofile', fileName };
    const rp = await new RichProgress(chatId, cap, [{ ep: cap }]).start();

    try {
      rp.updateEpisode(cap, 'download');
      await downloadWithAria2c(url, outPath, (log) => {
        if (log.includes('progress:')) {
          rp.updateEpisode(cap, 'download', log.split('progress: ')[1]);
        }
      }, extraHeaders);

      const sizeMb = fileSizeMb(outPath);
      logger.info({ chatId, file: fileName, sizeMb: sizeMb.toFixed(1) }, 'GoFile download selesai');

      if (sizeMb > MAX_UPLOAD_MB) {
        rp.updateEpisode(cap, 'fail', `${sizeMb.toFixed(1)} MB > limit`);
        return;
      }

      rp.updateEpisode(cap, 'upload', `${sizeMb.toFixed(1)} MB`);

      const info = await getVideoInfo(outPath).catch(() => ({}));
      const ext = path.extname(outPath).toLowerCase();
      if (VIDEO_EXTS.has(ext)) {
        await sendVideo(chatId, outPath, {
          caption: cap,
          supports_streaming: true,
          ...(info.duration && { duration: info.duration }),
          ...(info.width && { width: info.width }),
          ...(info.height && { height: info.height }),
        }, cacheInfo);
      } else if (AUDIO_EXTS.has(ext)) {
        await sendAudio(chatId, outPath, { caption: cap }, cacheInfo);
      } else {
        await sendDocument(chatId, outPath, { caption: cap }, cacheInfo);
      }
      rp.updateEpisode(cap, 'done', `${sizeMb.toFixed(1)} MB`);
      rp.done();
    } catch (err) {
      logger.error({ chatId, file: fileName, err: err.message }, 'GoFile direct gagal');
      rp.updateEpisode(cap, 'fail', err.message.slice(0, 30));
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
    cap = cleanCaption(file.name);
    const fileName = file.name;
    const cacheInfo = { urlHash, source: 'gofile', fileName };
    rp = await new RichProgress(chatId, cap, [{ ep: cap }]).start();

    if (file.size / 1024 / 1024 > MAX_UPLOAD_MB) {
      rp.updateEpisode(cap, 'fail', `${sizeMb} MB > limit`);
      rp.done();
      return;
    }

    const ext = path.extname(file.name) || '';
    outPath = tempPath(`gofile_${Date.now()}${ext}`);

    rp.updateEpisode(cap, 'download');
    await downloadWithAria2c(file.url, outPath, (log) => {
      if (log.includes('progress:')) {
        rp.updateEpisode(cap, 'download', log.split('progress: ')[1]);
      }
    }, extraHeaders, file.size);

    const finalSize = fileSizeMb(outPath);
    logger.info({ chatId, file: file.name, sizeMb: finalSize.toFixed(1) }, 'GoFile download selesai');

    rp.updateEpisode(cap, 'upload', `${finalSize.toFixed(1)} MB`);

    const info = await getVideoInfo(outPath).catch(() => ({}));
    const fext = path.extname(outPath).toLowerCase();
    if (VIDEO_EXTS.has(fext)) {
      await sendVideo(chatId, outPath, {
        caption: cap,
        supports_streaming: true,
        ...(info.duration && { duration: info.duration }),
        ...(info.width && { width: info.width }),
        ...(info.height && { height: info.height }),
      }, cacheInfo);
    } else if (AUDIO_EXTS.has(fext)) {
      await sendAudio(chatId, outPath, { caption: cap }, cacheInfo);
    } else {
      await sendDocument(chatId, outPath, { caption: cap }, cacheInfo);
    }
    rp.updateEpisode(cap, 'done', `${finalSize.toFixed(1)} MB`);
    rp.done();
  } catch (err) {
    logger.error({ chatId, url: url.slice(0, 80), err: err.message }, 'GoFile content gagal');
    if (rp) {
      rp.updateEpisode(cap, 'fail', err.message.slice(0, 50));
      rp.done().catch(() => {});
    }
  } finally {
    cleanupFiles(outPath);
  }
}

// ─── Batch GoFile direct URLs ────────────────────────────────────────────────

async function handleGofileBatch(chatId, urls) {
  const episodes = urls.map((u, i) => {
    const name = filenameFromGofileUrl(u);
    return { ep: name, label: `File ${i + 1}`, name };
  });

  const gofileToken = (process.env.GOFILE_TOKEN || '').trim();
  const extraHeaders = {
    'Referer': 'https://gofile.io/',
    ...(gofileToken && { 'Authorization': `Bearer ${gofileToken}` }),
  };

  const rp = await new RichProgress(chatId, `Batch ${urls.length} file`, episodes).start();
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
      if (sizeMb > MAX_UPLOAD_MB) {
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
        await sendVideo(chatId, outPath, {
          caption,
          supports_streaming: true,
          ...(info.duration && { duration: info.duration }),
          ...(info.width && { width: info.width }),
          ...(info.height && { height: info.height }),
        }, cacheInfo);
      } else if (AUDIO_EXTS.has(ext)) {
        await sendAudio(chatId, outPath, { caption }, cacheInfo);
      } else {
        await sendDocument(chatId, outPath, { caption }, cacheInfo);
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

// ─── Pixeldrain ────────────────────────────────────────────────────────────────

async function handlePixeldrainUrl(chatId, url) {
  let outPath = null;
  let rp;
  let cap = '';
  const urlHash = hashUrl(url);
  try {
    const info = await getPixeldrainInfo(url);
    const sizeMb = (info.size / 1024 / 1024).toFixed(1);
    cap = cleanCaption(info.name);
    const fileName = info.name;
    const cacheInfo = { urlHash, source: 'pixeldrain', fileName };
    rp = await new RichProgress(chatId, cap, [{ ep: cap }]).start();

    if (info.size / 1024 / 1024 > MAX_UPLOAD_MB) {
      rp.updateEpisode(cap, 'fail', `${sizeMb} MB > limit`);
      rp.done();
      return;
    }

    const ext = path.extname(info.name) || '';
    outPath = tempPath(`pixeldrain_${Date.now()}${ext}`);

    rp.updateEpisode(cap, 'download');
    await downloadWithAria2c(info.directUrl, outPath, (log) => {
      if (log.includes('progress:')) {
        rp.updateEpisode(cap, 'download', log.split('progress: ')[1]);
      }
    }, { 'Referer': 'https://pixeldrain.com/' }, info.size);

    const finalSize = fileSizeMb(outPath);
    logger.info({ chatId, file: info.name, sizeMb: finalSize.toFixed(1) }, 'Pixeldrain selesai');

    rp.updateEpisode(cap, 'upload', `${finalSize.toFixed(1)} MB`);

    const vinfo = await getVideoInfo(outPath).catch(() => ({}));
    const fext = path.extname(outPath).toLowerCase();
    if (VIDEO_EXTS.has(fext)) {
      await sendVideo(chatId, outPath, {
        caption: cap,
        supports_streaming: true,
        ...(vinfo.duration && { duration: vinfo.duration }),
        ...(vinfo.width && { width: vinfo.width }),
        ...(vinfo.height && { height: vinfo.height }),
      }, cacheInfo);
    } else if (AUDIO_EXTS.has(fext)) {
      await sendAudio(chatId, outPath, { caption: cap }, cacheInfo);
    } else {
      await sendDocument(chatId, outPath, { caption: cap }, cacheInfo);
    }
    rp.updateEpisode(cap, 'done', `${finalSize.toFixed(1)} MB`);
    rp.done();
  } catch (err) {
    logger.error({ chatId, url: url.slice(0, 80), err: err.message }, 'Pixeldrain gagal');
    if (rp) {
      rp.updateEpisode(cap || 'file', 'fail', err.message.slice(0, 50));
      rp.done().catch(() => {});
    }
  } finally {
    cleanupFiles(outPath);
  }
}

// ─── Show file info (non-admin preview) ────────────────────────────────────────

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function sendPaidMediaVideo(chatId, media, opts = {}) {
  const { caption, starCount, supports_streaming, duration, width, height } = opts;
  const isFilePath = typeof media === 'string' && (media.startsWith('/') || media.startsWith('file://'));
  if (isFilePath && !LOCAL_API_PORT) {
    const err = new Error('sendPaidMedia butuh Local Bot API Server untuk upload file lokal');
    logger.error({ chatId, err: err.message }, 'sendPaidMedia cloud guard');
    throw err;
  }
  return apiPost('sendPaidMedia', {
    chat_id: chatId,
    star_count: starCount,
    media: [{
      type: 'video',
      media: isFilePath ? `file://${media.replace(/^file:\/\//, '')}` : media,
      supports_streaming: supports_streaming || true,
      ...(duration && { duration }),
      ...(width && { width }),
      ...(height && { height }),
    }],
    caption: caption ? caption.slice(0, 1024) : undefined,
  });
}

async function showGofileFileInfo(chatId, url, userId) {
  try {
    const file = await resolveGofileFirstFile(url);
    const sizeStr = formatFileSize(file.size);
    const cap = cleanCaption(file.name);
    const remaining = await getRemainingFreeDownloads(userId);
    const freeInfo = remaining > 0 ? `🆓 Free: ${remaining}x hari ini` : '⭐ Bayar Stars untuk download';

    await bot.sendMessage(chatId,
      `📁 <b>${cap}</b>\n` +
      `💾 Ukuran: ${sizeStr}\n` +
      `🔗 Sumber: gofile.io\n\n` +
      `${freeInfo}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: `📥 Download (${sizeStr})`, callback_data: `dl:gofile:${cacheUrl(url)}` }]] } }
    );
  } catch (err) {
    logger.error({ chatId, url: url.slice(0, 80), err: err.message }, 'Gofile info gagal');
    await bot.sendMessage(chatId, `❌ Gagal mengambil info file: ${err.message.slice(0, 100)}`);
  }
}

async function showPixeldrainFileInfo(chatId, url, userId) {
  try {
    const info = await getPixeldrainInfo(url);
    const sizeStr = formatFileSize(info.size);
    const cap = cleanCaption(info.name);
    const remaining = await getRemainingFreeDownloads(userId);
    const freeInfo = remaining > 0 ? `🆓 Free: ${remaining}x hari ini` : '⭐ Bayar Stars untuk download';

    await bot.sendMessage(chatId,
      `📁 <b>${cap}</b>\n` +
      `💾 Ukuran: ${sizeStr}\n` +
      `🔗 Sumber: pixeldrain.com\n\n` +
      `${freeInfo}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: `📥 Download (${sizeStr})`, callback_data: `dl:pixeldrain:${cacheUrl(url)}` }]] } }
    );
  } catch (err) {
    logger.error({ chatId, url: url.slice(0, 80), err: err.message }, 'Pixeldrain info gagal');
    await bot.sendMessage(chatId, `❌ Gagal mengambil info file: ${err.message.slice(0, 100)}`);
  }
}

async function downloadAndSendPaidMedia(chatId, url, source, fileName, userId) {
  const cap = cleanCaption(fileName);
  const ext = path.extname(fileName) || '.mp4';
  const urlHash = hashUrl(url);

  // Cek cache dulu — skip download kalau udah pernah dikirim
  const cached = await getCachedFileId(urlHash);
  if (cached) {
    const isFree = await hasFreeDownload(userId);
    let cacheOk = false;
    try {
      if (cached.file_type === 'video') {
        if (isFree) {
          const newCount = await incrementFreeDownload(userId);
          const remaining = Math.max(0, FREE_DOWNLOAD_LIMIT - newCount);
          await sendVideo(chatId, cached.file_id, { caption: cap });
          await bot.sendMessage(chatId, `🆓 Free download! Sisa: ${remaining}x hari ini`);
        } else {
          await sendPaidMediaVideo(chatId, cached.file_id, { caption: cap, starCount: STAR_PRICE });
        }
      } else if (cached.file_type === 'audio') {
        if (isFree) {
          await incrementFreeDownload(userId);
          await sendAudio(chatId, cached.file_id, { caption: cap });
        } else {
          await sendPaidMediaVideo(chatId, cached.file_id, { caption: cap, starCount: STAR_PRICE });
        }
      } else {
        if (isFree) {
          await incrementFreeDownload(userId);
          await sendDocument(chatId, cached.file_id, { caption: cap });
        } else {
          await sendPaidMediaVideo(chatId, cached.file_id, { caption: cap, starCount: STAR_PRICE });
        }
      }
      cacheOk = true;
      logger.info({ chatId, file: cached.file_name || fileName, source, cache: true }, 'Cache hit — skip download');
    } catch (err) {
      logger.error({ chatId, url: url.slice(0, 80), err: err.message }, 'Cache send gagal, fallback download');
    }
    if (cacheOk) return;
  }

  const outPath = tempPath(`paid_${Date.now()}${ext}`);

  try {
    let downloadUrl = url;
    let extraHeaders = {};
    let fileSize;

    if (source === 'pixeldrain') {
      const info = await getPixeldrainInfo(url);
      downloadUrl = info.directUrl;
      fileName = info.name || fileName;
      fileSize = info.size;
      extraHeaders = { 'Referer': 'https://pixeldrain.com/' };
    } else if (source === 'gofile') {
      const gofileToken = (process.env.GOFILE_TOKEN || '').trim();
      extraHeaders = {
        'Referer': 'https://gofile.io/',
        ...(gofileToken && { 'Authorization': `Bearer ${gofileToken}` }),
      };
      const file = await resolveGofileFirstFile(url);
      downloadUrl = file.url;
      fileName = file.name || fileName;
      fileSize = file.size;
    }

    await downloadWithAria2c(downloadUrl, outPath, () => {}, extraHeaders, fileSize);

    const sizeMb = fileSizeMb(outPath);
    if (sizeMb > MAX_UPLOAD_MB) {
      await bot.sendMessage(chatId, `❌ File terlalu besar (${sizeMb.toFixed(1)} MB > ${MAX_UPLOAD_MB} MB)`);
      return;
    }

    const info = await getVideoInfo(outPath).catch(() => ({}));
    const fileExt = path.extname(outPath).toLowerCase();
    const fileType = getFileTypeFromExt(fileExt);
    const cacheInfo = { urlHash, source, fileName };

    const isFree = await hasFreeDownload(userId);

    if (VIDEO_EXTS.has(fileExt)) {
      if (isFree) {
        const newCount = await incrementFreeDownload(userId);
        const remaining = Math.max(0, FREE_DOWNLOAD_LIMIT - newCount);
        await sendVideo(chatId, outPath, {
          caption: cap,
          supports_streaming: true,
          ...(info.duration && { duration: info.duration }),
          ...(info.width && { width: info.width }),
          ...(info.height && { height: info.height }),
        }, cacheInfo);
        await bot.sendMessage(chatId, `🆓 Free download! Sisa: ${remaining}x hari ini`);
      } else {
        const result = await sendPaidMediaVideo(chatId, outPath, {
          caption: cap,
          starCount: STAR_PRICE,
          supports_streaming: true,
          ...(info.duration && { duration: info.duration }),
          ...(info.width && { width: info.width }),
          ...(info.height && { height: info.height }),
        });
        const fileId = result?.paid_media?.[0]?.video?.file_id;
        if (fileId) setCachedFileId(urlHash, source, fileId, 'video', fileName).catch(() => {});
      }
    } else if (AUDIO_EXTS.has(fileExt)) {
      if (isFree) {
        await incrementFreeDownload(userId);
        await sendAudio(chatId, outPath, { caption: cap }, cacheInfo);
      } else {
        await sendPaidMediaVideo(chatId, outPath, { caption: cap, starCount: STAR_PRICE });
      }
    } else {
      if (isFree) {
        await incrementFreeDownload(userId);
        await sendDocument(chatId, outPath, { caption: cap }, cacheInfo);
      } else {
        await sendPaidMediaVideo(chatId, outPath, { caption: cap, starCount: STAR_PRICE });
      }
    }

    logger.info({ chatId, file: fileName, sizeMb: sizeMb.toFixed(1), source, free: isFree, cache: false }, 'Download selesai');
  } catch (err) {
    logger.error({ chatId, url: url.slice(0, 80), err: err.message }, 'Download paid media gagal');
    await bot.sendMessage(chatId, `❌ Gagal download: ${err.message.slice(0, 100)}`);
  } finally {
    cleanupFiles(outPath);
  }
}

// ─── Download + kirim 1 file ──────────────────────────────────────────────────

async function downloadAndSend(chatId, subdomain, id, slug, ep, lang, caption) {
  const p = await new Progress(chatId, `Ep ${ep} — scrape URL`).start();

  const result = await getVideoUrl(subdomain, id, slug, ep, 1, lang).catch((err) => {
    logger.error({ chatId, episode: ep, err: { message: err.message, stack: err.stack } }, 'getVideoUrl failed');
    return null;
  });
  if (!result?.videoUrl) {
    await p.fail(`Ep ${ep}: URL tidak ditemukan`);
    return null;
  }

  const outPath = tempPath(`ep${ep}.mp4`);
  const streamType = result.videoUrl.includes('m3u8') ? 'HLS' : 'MP4';

  try {
    p.update(`Ep ${ep} — download ${streamType}`);
    logger.info({ chatId, episode: ep, streamType, url: result.videoUrl.slice(0, 80) }, 'Download starting');
    await downloadStream(result.videoUrl, outPath, (log) => {
      if (log.includes('progress:')) {
        const t = log.split('progress: ')[1];
        p.update(`Ep ${ep} — download ${t}`);
        logger.info({ chatId, episode: ep, progress: t }, 'Download progress');
      }
    }, result.subtitleUrl);
  } catch (err) {
    cleanupFiles(outPath);
    logger.error({ chatId, episode: ep, err: { message: err.message, stack: err.stack } }, 'Download failed');
    await p.fail(`Ep ${ep}: gagal download`);
    return null;
  }

  const sizeMb = fileSizeMb(outPath);
  const cap = caption || (result.title ? `${result.title} - Ep ${ep}` : `Episode ${ep}`);
  p.update(`Ep ${ep} — upload (${sizeMb.toFixed(1)} MB)`);

  try {
    if (sizeMb > MAX_UPLOAD_MB) {
      await p.fail(`Ep ${ep}: ${sizeMb.toFixed(1)} MB — terlalu besar`);
    } else {
      const info = await getVideoInfo(outPath).catch(() => ({}));
      const opts = {
        caption: cap,
        supports_streaming: true,
        ...(info.duration && { duration: info.duration }),
        ...(info.width && { width: info.width }),
        ...(info.height && { height: info.height }),
      };
      await sendVideo(chatId, outPath, opts);
      logger.info({ chatId, episode: ep, sizeMb: sizeMb.toFixed(1) }, 'Video sent');
      await p.done(`Ep ${ep} — selesai (${sizeMb.toFixed(1)} MB)`);
    }
  } catch (err) {
    logger.error({ chatId, episode: ep, err: err.message }, 'Send failed');
    await p.fail(`Ep ${ep}: gagal kirim — ${err.message.slice(0, 100)}`);
  } finally {
    cleanupFiles(outPath);
  }

  return true;
}

// ─── Aksi: kirim per episode ───────────────────────────────────────────────────

async function actionPerEpisode(chatId, session) {
  const { subdomain, id, slug, lang, episodes } = session;
  const p = await new Progress(chatId, `Download ${episodes.length} episode`).start();
  logger.info({ chatId, subdomain, total: episodes.length, mode: 'per_ep' }, 'Starting per-episode download');

  for (let i = 0; i < episodes.length; i++) {
    const { ep, urlEp } = episodes[i];
    p.update(`[${i + 1}/${episodes.length}] Ep ${ep} — scrape`);
    logger.info({ chatId, episode: ep, progress: `${i + 1}/${episodes.length}` }, 'Processing episode');
    await downloadAndSend(chatId, subdomain, id, slug, urlEp, lang, `Ep ${ep}`);
  }

  await p.done(`${episodes.length} episode selesai`);
  logger.info({ chatId, subdomain, total: episodes.length, mode: 'per_ep' }, 'Per-episode download complete');
}

// ─── Chunk builder ────────────────────────────────────────────────────────────

function buildChunks(episodes, chunkSize = 10, minLastChunk = 6) {
  if (episodes.length === 0) return [];
  const chunks = [];
  for (let i = 0; i < episodes.length; i += chunkSize) {
    chunks.push(episodes.slice(i, i + chunkSize));
  }
  if (chunks.length > 1 && chunks[chunks.length - 1].length < minLastChunk) {
    const last = chunks.pop();
    chunks[chunks.length - 1] = [...chunks[chunks.length - 1], ...last];
  }
  return chunks;
}

// ─── Aksi: gabung per 10 episode ──────────────────────────────────────────────

async function actionMerge10(chatId, session) {
  const { subdomain, id, slug, lang, episodes } = session;
  const chunks = buildChunks(episodes, 10, 6);
  const totalParts = chunks.length;

  for (let part = 0; part < totalParts; part++) {
    const chunk = chunks[part];
    const epStart = chunk[0].ep;
    const epEnd = chunk[chunk.length - 1].ep;
    const partLabel = `Part ${part + 1} (Ep ${epStart}–${epEnd})`;

    // Rich progress untuk part ini
    const rp = await new RichProgress(chatId, partLabel, chunk).start();
    logger.info({ chatId, subdomain, part: partLabel, episodes: chunk.length }, 'Starting part download');

    const downloaded = [];
    const failedEps = [];
    for (let i = 0; i < chunk.length; i++) {
      const { ep, urlEp } = chunk[i];
      rp.updateEpisode(ep, 'scrape', `${i + 1}/${chunk.length}`);
      const result = await getVideoUrl(subdomain, id, slug, urlEp, 1, lang).catch((err) => {
        logger.error({ chatId, episode: ep, subdomain, err: { message: err.message, stack: err.stack } }, 'getVideoUrl in merge failed');
        return null;
      });
      if (!result?.videoUrl) {
        rp.updateEpisode(ep, 'fail', 'URL tidak ditemukan');
        failedEps.push(ep);
        continue;
      }

      const epFile = tempPath(`ep${ep}.mp4`);
      try {
        rp.updateEpisode(ep, 'download', 'downloading...');
        await downloadStream(result.videoUrl, epFile, (log) => {
          if (log.includes('progress:')) {
            const t = log.split('progress: ')[1];
            rp.updateEpisode(ep, 'download', t);
          }
        }, result.subtitleUrl);
        const sizeMb = fileSizeMb(epFile);
        rp.updateEpisode(ep, 'done', '', `${sizeMb.toFixed(1)} MB`);
        downloaded.push(epFile);
      } catch (err) {
        logger.error({ chatId, episode: ep, subdomain, err: { message: err.message, stack: err.stack } }, 'Download in merge failed');
        cleanupFiles(epFile);
        rp.updateEpisode(ep, 'fail', err.message.slice(0, 30));
        failedEps.push(ep);
      }
    }

    if (!downloaded.length) {
      await rp.done();
      await bot.sendMessage(chatId, `⚠️ ${partLabel}: semua gagal — Ep ${failedEps.join(', ')}. Part dilewati.`);
      continue;
    }

    if (downloaded.length < chunk.length) {
      cleanupFiles(...downloaded);
      await rp.done();
      await bot.sendMessage(chatId, `⚠️ ${partLabel}: tidak lengkap — gagal: Ep ${failedEps.join(', ')}. Part dilewati.`);
      continue;
    }

    let finalFile;
    if (downloaded.length === 1) {
      finalFile = downloaded[0];
    } else {
      finalFile = tempPath(`part${part + 1}.mp4`);
      rp.updateEpisode(chunk[0].ep, 'merge', `merge ${downloaded.length} ep`);
      try {
        await mergeVideos(downloaded, finalFile, { title: partLabel });
        cleanupFiles(...downloaded);
      } catch (err) {
        logger.error({ chatId, part: partLabel, err: { message: err.message, stack: err.stack } }, 'Merge failed');
        cleanupFiles(...downloaded, finalFile);
        continue;
      }
    }

    const sizeMb = fileSizeMb(finalFile);
    rp.updateEpisode(chunk[0].ep, 'upload', `${sizeMb.toFixed(1)} MB`);

    try {
      if (sizeMb > MAX_UPLOAD_MB) {
        logger.warn({ chatId, part: partLabel, sizeMb: sizeMb.toFixed(1), limit: MAX_UPLOAD_MB }, 'Part skipped — exceeds limit');
        rp.updateEpisode(chunk[0].ep, 'fail', `${sizeMb.toFixed(1)} MB > limit`);
      } else {
        const info = await getVideoInfo(finalFile).catch(() => ({}));
        const opts = {
          caption: partLabel,
          supports_streaming: true,
          ...(info.duration && { duration: info.duration }),
          ...(info.width && { width: info.width }),
          ...(info.height && { height: info.height }),
        };
        await sendVideo(chatId, finalFile, opts);
        logger.info({ chatId, part: partLabel, sizeMb: sizeMb.toFixed(1) }, 'Merge part sent');
      }
    } catch (err) {
      logger.error({ chatId, part: partLabel, err: err.message }, 'Part send failed');
      await bot.sendMessage(chatId, `❌ ${partLabel}: gagal kirim — ${err.message.slice(0, 100)}`);
    } finally {
      cleanupFiles(finalFile);
    }

    await rp.done();
  }

  await destroySession();
}

// ─── Handler: pesan teks ────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  logger.info({ chatId: msg.chat.id, text: msg.text, from: msg.from?.username || msg.from?.id }, 'Message received');
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (msg.successful_payment) {
    const session = sessions.get(String(chatId));
    if (session) {
      session.paid = true;
      logger.info({ chatId, stars: msg.successful_payment.total_amount }, 'Payment received');

      // Drama link → show action keyboard
      if (session.episodes && session.episodes.length > 0) {
        await bot.sendMessage(chatId, `✅ Pembayaran ${msg.successful_payment.total_amount}⭐ berhasil! Silakan pilih aksi:`, { reply_markup: mainActionKeyboard() });
      } else {
        await bot.sendMessage(chatId, `✅ Pembayaran ${msg.successful_payment.total_amount}⭐ berhasil! Kirim link file untuk download.`);
      }
    }
    return;
  }

  if (text === '/exit' || text === '/cancel') {
    if (aiChatSessions.has(chatId)) {
      aiChatSessions.delete(chatId);
      return bot.sendMessage(chatId, 'Live Chat ditutup.', { reply_markup: { remove_keyboard: true } });
    }
  }

  if (aiChatSessions.has(chatId) && !text.startsWith('/')) {
    const { askStream } = require('./ai');
    const draftId = Date.now();
    let fullText = '';
    let updateTimer = null;
    let draftFailed = false;

    try {
      await sendDraft(chatId, draftId, '<tg-thinking>Admin sedang mengetik</tg-thinking>', { format: 'html' });
    } catch (err) {
      logger.warn({ chatId, err: err.message }, 'sendDraft initial failed, batch fallback');
      draftFailed = true;
    }

    try {
      const result = await askStream(text, (token) => {
        fullText += token;
        if (draftFailed) return;
        clearTimeout(updateTimer);
        updateTimer = setTimeout(async () => {
          try {
            await sendDraft(chatId, draftId, markdownToHtml(fullText), { format: 'html' });
          } catch (e) {
            draftFailed = true;
            logger.warn({ chatId, err: e.message }, 'Draft update failed, streaming fallback');
          }
        }, 800);
      }, { timeout: 120000 });

      clearTimeout(updateTimer);

      const html = markdownToHtml(fullText);
      if (!draftFailed) {
        await sendDraft(chatId, draftId, html, { format: 'html' }).catch(() => {});
        await finalizeDraft(chatId, html, { format: 'html' });
        logger.info({ chatId, streamed: true }, 'AI response streamed');
      } else {
        await bot.sendMessage(chatId, html, { parse_mode: 'HTML' });
        logger.info({ chatId, streamed: false }, 'AI response sent (batch fallback)');
      }
    } catch (err) {
      clearTimeout(updateTimer);
      logger.error({ chatId, err: { message: err.message, stack: err.stack } }, 'AI streaming failed');

      if (fullText) {
        const html = markdownToHtml(fullText);
        if (!draftFailed) {
          await sendDraft(chatId, draftId, html, { format: 'html' }).catch(() => {});
          await finalizeDraft(chatId, html, { format: 'html' }).catch(() => {});
        } else {
          await bot.sendMessage(chatId, `⚠️ Hasil parsial:\n\n${html}`, { parse_mode: 'HTML' }).catch(() => {});
        }
      } else {
        await bot.sendMessage(chatId, `❌ Error: ${err.message.slice(0, 100)}`).catch(() => {});
      }
    }
    return;
  }

  if (text === '/status') {
    const http = require('http');
    const now = new Date().toISOString();
    const lines = [`<b>🤖 Status Bot</b>\n⏱ ${now}\n`];

    const flareOk = await new Promise(r => {
      const req = http.get(`${FLARESOLVERR_URL}/`, res => { res.resume(); r(true); });
      req.on('error', () => r(false));
      req.setTimeout(5000, () => { req.destroy(); r(false); });
    });
    lines.push(flareOk ? '✅ FlareSolverr: OK' : '❌ FlareSolverr: DOWN');

    if (LOCAL_API_PORT) {
      const apiOk = await new Promise(r => {
        const req = http.get(`http://127.0.0.1:${LOCAL_API_PORT}/`, res => { res.resume(); r(true); });
        req.on('error', () => r(false));
        req.setTimeout(5000, () => { req.destroy(); r(false); });
      });
      lines.push(apiOk ? `✅ Local API (:${LOCAL_API_PORT}): OK` : `❌ Local API (:${LOCAL_API_PORT}): DOWN`);
    }

    const { execFileSync } = require('child_process');
    const df = execFileSync('df', ['-B1', '--output=avail,size', '/home/runner/workspace'], { encoding: 'utf8' });
    const parts = df.trim().split('\n')[1]?.split(/\s+/);
    if (parts) {
      const freeGb = (Number(parts[0]) / 1e9).toFixed(1);
      const totalGb = (Number(parts[1]) / 1e9).toFixed(1);
      lines.push(`💾 Disk: ${freeGb} GB / ${totalGb} GB`);
    }

    const activeSessions = [...sessions.values()].map(s => `${s.subdomain} (${s.episodes?.length || '?'} ep)`);
    if (activeSessions.length) {
      lines.push(`👤 Sessions: ${activeSessions.length}`);
    }

    return sendRichMessage(chatId, lines.join('\n'), { format: 'markdown' });
  }

  if (text === '/balance') {
    if (!isAdmin(msg.from.id)) {
      return bot.sendMessage(chatId, '⚠️ Fitur ini hanya untuk admin.');
    }
    try {
      const result = await makePostRequest('getMyStarBalance', {});
      const stars = result.amount + (result.nanostar_amount || 0) / 1e9;
      return bot.sendMessage(chatId, `⭐ <b>Saldo Stars</b>\n${stars.toFixed(9)} ⭐`, { parse_mode: 'HTML', reply_markup: balanceKeyboard() });
    } catch (err) {
      return bot.sendMessage(chatId, `❌ Gagal cek saldo: ${err.message.slice(0, 100)}`, { reply_markup: mainMenuKeyboard(true) });
    }
  }

  if (text === '/start' || text === '/menu' || text === '/help') {
    const limit = LOCAL_API_PORT
      ? '🟢 Local API — limit 2 GB'
      : '🟡 API publik — limit 50 MB';
    const isAdminUser = isAdmin(msg.from.id);
    const menuItems = isAdminUser
      ? `- 💬 **Live Chat** — ngobrol dengan admin virtual\n` +
        `- 📊 **Status Server** — FlareSolverr, disk, session\n` +
        `- ⭐ **Cek Saldo Stars** — saldo Telegram Stars bot\n` +
        `- ❓ **Bantuan** — panduan lengkap\n`
      : `- 📊 **Status Server** — FlareSolverr, disk, session\n` +
        `- ❓ **Bantuan** — panduan lengkap\n`;
    const paymentInfo = isAdminUser
      ? ''
      : `\n**🆓 Free:** ${FREE_DOWNLOAD_LIMIT}x download gratis per hari.\n**⭐ Premium:** Bayar ${STAR_PRICE}⭐ setelah free habis.`;
    return sendRichMessage(
      chatId,
      `**👋 Halo!** Kirim link untuk download.\n\n` +
      `${limit}\n` +
      paymentInfo,
      { format: 'markdown', reply_markup: mainMenuKeyboard(isAdminUser) }
    );
  }

  if (isUcDriveUrl(text)) {
    if (!isAdmin(msg.from.id)) {
      const session = sessions.get(String(chatId));
      if (!session || !session.paid) {
        sessions.set(String(chatId), { subdomain: 'ucdrive', id: '', slug: '', lang: 'id', episodes: [], meta: {} });
        await sendInvoice(chatId, 'Download Access', 'Akses download file', String(chatId), STAR_PRICE);
        return;
      }
    }
    return handleUcDriveUrl(chatId, text);
  }

  // Batch: multiple GoFile direct URLs in one message
  const rawLines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const directUrls = rawLines.filter(l => isGofileDirectUrl(l));
  if (rawLines.length > 1 && directUrls.length === rawLines.length) {
    if (!isAdmin(msg.from.id)) {
      const session = sessions.get(String(chatId));
      if (!session || !session.paid) {
        sessions.set(String(chatId), { subdomain: 'gofile', id: '', slug: '', lang: 'id', episodes: [], meta: {} });
        await sendInvoice(chatId, 'Download Access', 'Akses download file', String(chatId), STAR_PRICE);
        return;
      }
    }
    return handleGofileBatch(chatId, directUrls);
  }

  // Batch: multiple Pixeldrain URLs in one message
  if (rawLines.length > 1) {
    const pdUrls = rawLines.filter(l => isPixeldrainUrl(l));
    if (pdUrls.length === rawLines.length) {
      for (const url of pdUrls) {
        try {
          if (!isAdmin(msg.from.id)) {
            await showPixeldrainFileInfo(chatId, url, msg.from.id);
          } else {
            await handlePixeldrainUrl(chatId, url);
          }
        } catch (err) {
          logger.error({ chatId, url: url.slice(0, 80), err: err.message }, 'Pixeldrain batch item gagal');
        }
      }
      return;
    }
  }

  if (isGofileUrl(text)) {
    if (!isAdmin(msg.from.id)) {
      const session = sessions.get(String(chatId));
      if (!session || !session.paid) {
        return showGofileFileInfo(chatId, text, msg.from.id);
      }
    }
    return handleGofileUrl(chatId, text);
  }

  if (isPixeldrainUrl(text)) {
    if (!isAdmin(msg.from.id)) {
      const session = sessions.get(String(chatId));
      if (!session || !session.paid) {
        return showPixeldrainFileInfo(chatId, text, msg.from.id);
      }
    }
    return handlePixeldrainUrl(chatId, text);
  }

  const params = parseDramaUrl(text);
  if (!params || !params.id) {
    return bot.sendMessage(chatId, '⚠️ Link tidak dikenali. Kirim link dari <b>dramafren.org</b>, <b>gofile.io</b>, <b>pixeldrain.com</b>, atau <b>uc-share.com</b>.', { parse_mode: 'HTML' });
  }

  if (params.page === 'watch') {
    return scrapeAndReport(chatId, params.subdomain, params.id, params.slug, params.ep, params.sv, params.lang);
  }

  const p = await new Progress(chatId, 'Mengambil daftar episode').start();

  try {
    const { episodes, meta } = await getAllEpisodes(params.subdomain, params.id, params.slug, params.lang);
    if (!episodes.length) {
      await p.fail('Tidak ada episode ditemukan');
      return;
    }

    sessions.set(String(chatId), {
      subdomain: params.subdomain,
      id: params.id,
      slug: params.slug,
      lang: params.lang,
      episodes,
      meta,
    });
    logger.info({ chatId, subdomain: params.subdomain, id: params.id, totalEp: episodes.length }, 'Session created');

    const epFirst = episodes[0].ep;
    const epLast = episodes[episodes.length - 1].ep;

    // Kirim poster jika ada
    let posterPath = null;
    if (meta.poster) {
      const caption = [
        `<b>${meta.title || params.subdomain}</b>`,
        '',
        meta.synopsis ? meta.synopsis.slice(0, 300) + (meta.synopsis.length > 300 ? '...' : '') : '',
        '',
        `🎞 <b>${episodes.length} episode</b> (Ep ${epFirst}–${epLast})`,
      ].filter(Boolean).join('\n');

      try {
        const ext = (() => { try { const m = meta.poster.match(/\.(jpe?g|png|webp|gif)(?:[@?#]|$)/i); return m ? '.' + m[1].toLowerCase() : '.jpg'; } catch { return '.jpg'; } })();
        posterPath = tempPath(`poster_${Date.now()}${ext}`);
        const resp = await axios({ url: meta.poster, responseType: 'stream', timeout: 15000 });
        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(posterPath);
          resp.data.pipe(ws);
          ws.on('finish', resolve);
          ws.on('error', reject);
        });
        await sendPhoto(chatId, posterPath, { caption });
      } catch {
        logger.warn({ chatId, poster: meta.poster }, 'Poster gagal dikirim, fallback ke teks');
        await bot.sendMessage(chatId, caption, { parse_mode: 'HTML' });
      } finally {
        if (posterPath) cleanupFiles(posterPath);
      }
    } else {
      await bot.sendMessage(chatId, `📋 <b>${meta.title || params.subdomain}</b>\n🎞 <b>${episodes.length} episode</b> (Ep ${epFirst}–${epLast})`, { parse_mode: 'HTML' });
    }

    if (isAdmin(msg.from.id)) {
      await bot.sendMessage(chatId, 'Pilih aksi:', { reply_markup: mainActionKeyboard() });
    } else {
      await sendInvoice(chatId, meta.title || params.subdomain, `${episodes.length} episode · ${params.subdomain}.dramafren.org`, String(chatId), STAR_PRICE);
      logger.info({ chatId, price: STAR_PRICE, subdomain: params.subdomain }, 'Invoice sent to non-admin');
    }
    await p.done('Daftar episode siap');
  } catch (err) {
    logger.error({ chatId, subdomain: params.subdomain, err: { message: err.message, stack: err.stack } }, 'Get episodes failed');
    await p.fail(`Gagal: ${err.message.slice(0, 100)}`);
  }
});

// ─── Handler: callback_query ────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data || '';

  await bot.answerCallbackQuery(query.id).catch(() => {});

  const session = sessions.get(String(chatId));

  if (data.startsWith('ep:')) {
    const ep = Number(data.slice(3));
    if (!session) return bot.sendMessage(chatId, '⚠️ Session habis. Kirim ulang link.');
    if (!isAdmin(query.from.id) && !session.paid) {
      return bot.sendMessage(chatId, `⚠️ Anda harus membayar ${STAR_PRICE}⭐ terlebih dahulu. Kirim ulang link drama untuk memulai pembayaran.`);
    }
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    return scrapeAndReport(chatId, session.subdomain, session.id, session.slug, ep, 1, session.lang);
  }

  // ─── Download file callbacks (GoFile/Pixeldrain preview) ────────────────────
  if (data.startsWith('dl:')) {
    const parts = data.split(':');
    const action = parts[1];

    if (action === 'cancel') {
      await bot.editMessageText('❌ Dibatalkan.', { chat_id: chatId, message_id: msgId }).catch(() => {});
      return;
    }

    const rawUrl = parts.slice(2).join(':');
    const fileUrl = resolveUrl(rawUrl) || decodeURIComponent(rawUrl) || '';

    // Non-admin → cek free download atau paid media
    if (!isAdmin(query.from.id)) {
      await bot.editMessageText('📥 Menyiapkan...', { chat_id: chatId, message_id: msgId }).catch(() => {});

      if (!fileUrl) {
        return bot.answerCallbackQuery(query.id, { text: '⚠️ Link kadaluarsa, kirim ulang' }).catch(() => {});
      }

      // Fetch info file dulu untuk nama
      let fileName = `file_${Date.now()}.mp4`;
      try {
        if (action === 'gofile') {
          const file = await resolveGofileFirstFile(fileUrl);
          fileName = file.name;
        } else if (action === 'pixeldrain') {
          const info = await getPixeldrainInfo(fileUrl);
          fileName = info.name;
        }
      } catch {}

      return downloadAndSendPaidMedia(chatId, fileUrl, action, fileName, query.from.id);
    }

    // Admin → download langsung tanpa bayar
    await bot.editMessageText('📥 Downloading...', { chat_id: chatId, message_id: msgId }).catch(() => {});

    if (action === 'gofile') {
      return handleGofileUrl(chatId, fileUrl);
    } else if (action === 'pixeldrain') {
      return handlePixeldrainUrl(chatId, fileUrl);
    }
  }

  if (!data.startsWith('act:')) return;
  const act = data.slice(4);

  if (act === 'back') {
    if (!session) return;
    const epFirst = session.episodes[0].ep;
    const epLast = session.episodes[session.episodes.length - 1].ep;
    return bot.editMessageText(
      `<b>${session.subdomain}.dramafren.org</b>\n` +
      `🎞 <b>${session.episodes.length} episode</b> (Ep ${epFirst}–${epLast})\n\nPilih aksi:`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: mainActionKeyboard() }
    ).catch(() => {});
  }

  if (act === 'list') {
    if (!session) return bot.sendMessage(chatId, '⚠️ Session habis.');
    return bot.editMessageText(
      `🔢 Pilih episode (hanya ambil URL, tanpa download):`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: episodeListKeyboard(session.episodes) }
    ).catch(() => {});
  }

  if (act === 'ai') {
    if (!isAdmin(query.from.id)) {
      return bot.sendMessage(chatId, '⚠️ AI Chat hanya untuk admin.');
    }
    aiChatSessions.set(chatId, true);
    return bot.editMessageText(
      `💬 <b>Live Chat Aktif</b>\n\nKetik pesan Anda. Admin akan membalas.\n\nKlik tombol di bawah untuk keluar.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: aiKeyboard() }
    ).catch(() => {});
  }

  if (act === 'ai_exit') {
    aiChatSessions.delete(chatId);
    return bot.sendMessage(
      chatId,
      `✅ Live Chat ditutup.\n\nPilih menu:`,
      { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(isAdmin(query.from.id)) }
    );
  }

  if (act === 'main_menu') {
    return bot.sendMessage(
      chatId,
      `<b>🏠 Menu Utama</b>\n\nPilih opsi di bawah:`,
      { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(isAdmin(query.from.id)) }
    );
  }

  if (act === 'status') {
    const isAdminUser = isAdmin(query.from.id);
    return bot.sendMessage(chatId, '📊 <b>Memeriksa status...</b>', { parse_mode: 'HTML' }).then(() => {
      const http = require('http');
      const now = new Date().toISOString();
    const lines = [`**🤖 Status Bot**\n⏱ ${now}\n`];

      return new Promise(r => {
        const req = http.get(`${FLARESOLVERR_URL}/`, res => { res.resume(); r(true); });
        req.on('error', () => r(false));
        req.setTimeout(5000, () => { req.destroy(); r(false); });
      }).then(flareOk => {
        lines.push(flareOk ? '✅ FlareSolverr: OK' : '❌ FlareSolverr: DOWN');
        if (LOCAL_API_PORT) {
          return new Promise(r => {
            const req = http.get(`http://127.0.0.1:${LOCAL_API_PORT}/`, res => { res.resume(); r(true); });
            req.on('error', () => r(false));
            req.setTimeout(5000, () => { req.destroy(); r(false); });
          }).then(apiOk => {
            lines.push(apiOk ? `✅ Local API (:${LOCAL_API_PORT}): OK` : `❌ Local API (:${LOCAL_API_PORT}): DOWN`);
          });
        }
      }).then(() => {
        const { execFileSync } = require('child_process');
        const df = execFileSync('df', ['-B1', '--output=avail,size', '/home/runner/workspace'], { encoding: 'utf8' });
        const parts = df.trim().split('\n')[1]?.split(/\s+/);
        if (parts) {
          const freeGb = (Number(parts[0]) / 1e9).toFixed(1);
          const totalGb = (Number(parts[1]) / 1e9).toFixed(1);
          lines.push(`💾 Disk: ${freeGb} GB / ${totalGb} GB`);
        }
        const activeSessions = [...sessions.values()].map(s => `${s.subdomain} (${s.episodes?.length || '?'} ep)`);
        if (activeSessions.length) lines.push(`👤 Sessions: ${activeSessions.length}`);
        sendRichMessage(chatId, lines.join('\n'), { format: 'markdown', reply_markup: mainMenuKeyboard(isAdminUser) });
      });
    });
  }

  if (act === 'balance') {
    const isAdminUser = isAdmin(query.from.id);
    makePostRequest('getMyStarBalance', {}).then(result => {
      const stars = result.amount + (result.nanostar_amount || 0) / 1e9;
      bot.sendMessage(chatId, `⭐ <b>Saldo Stars Bot</b>\n${stars.toFixed(9)} ⭐\n\n💡 Tarik saldo via <b>Fragment</b> — klik tombol di bawah.`, { parse_mode: 'HTML', reply_markup: balanceKeyboard() });
    }).catch(err => {
      bot.sendMessage(chatId, `❌ Gagal cek saldo: ${err.message.slice(0, 100)}`, { reply_markup: mainMenuKeyboard(isAdminUser) });
    });
    return;
  }

  if (act === 'help') {
    const limit = LOCAL_API_PORT
      ? '🟢 Local API — limit 2 GB'
      : '🟡 API publik — limit 50 MB';
    const isAdminUser = isAdmin(query.from.id);
    const paymentInfo = isAdminUser
      ? ''
      : `\n**🆓 Free:** ${FREE_DOWNLOAD_LIMIT}x download gratis per hari.\n**⭐ Premium:** Bayar ${STAR_PRICE}⭐ setelah free habis.`;
    const subdomainInfo = isAdminUser
      ? `\n\n**📋 Subdomain Drama:**\n` +
        `\`shortmax, flickreels, goodshort, dramawave, dramabox, starshort, dramapops, stardusttv, microdrama, reelshort, flextv, dramabite, netshort, kalostv, tvseries, moboreels, idrama, reelfren, shortwave\``
      : '';
    return sendRichMessage(
      chatId,
      `**❓ Bantuan**\n\n` +
      `**📖 Cara Pakai:**\n` +
      `1. Kirim link drama atau file\n` +
      `2. Pilih episode (untuk drama)\n` +
      `3. Download gratis ${FREE_DOWNLOAD_LIMIT}x/hari atau bayar Stars\n` +
      `4. File dikirim ke chat\n\n` +
      `**🔗 Link yang didukung:**\n` +
      `- **dramafren.org** → drama serial\n` +
      `- **gofile.io** → file sharing\n` +
      `- **pixeldrain.com** → file sharing\n` +
      `- **uc-share.com** → video share\n\n` +
      `${limit}` +
      paymentInfo +
      subdomainInfo,
      { format: 'markdown', reply_markup: mainMenuKeyboard(isAdminUser) }
    );
  }

  if (act === 'per_ep' || act === 'merge10') {
    if (!session) return bot.sendMessage(chatId, '⚠️ Session habis. Kirim ulang link.');
    if (!isAdmin(query.from.id) && !session.paid) {
      return bot.sendMessage(chatId, `⚠️ Anda harus membayar ${STAR_PRICE}⭐ terlebih dahulu. Kirim ulang link drama untuk memulai pembayaran.`);
    }
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    if (act === 'per_ep') return actionPerEpisode(chatId, session);
    return actionMerge10(chatId, session);
  }
});

bot.on('pre_checkout_query', async (query) => {
  try {
    await makePostRequest('answerPreCheckoutQuery', {
      pre_checkout_query_id: query.id,
      ok: true,
    });
    logger.info({ queryId: query.id, userId: query.from.id }, 'Pre-checkout approved');
  } catch (err) {
    logger.error({ queryId: query.id, err: err.message }, 'Pre-checkout answer failed');
  }
});

bot.on('polling_error', (err) => {
  logger.error({ err: err.message }, 'Polling error');
});

module.exports = {
  sendRichMessage,
  sendDraft,
  finalizeDraft,
  sendStreaming,
  detectContentType,
  markdownToHtml,
  Progress,
  RichProgress,
  STATUS_ICONS,
  isAdmin,
  sendInvoice,
  makePostRequest,
  bot,
};
})();
