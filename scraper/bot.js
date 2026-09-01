/**
 * bot.js
 * Telegram bot untuk scraping + download video dari dramafren.org
 *
 * Mendukung Local Bot API Server (TELEGRAM_API_PORT) untuk upload hingga 2GB.
 */
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}
try { require('dotenv').config(); } catch {}

const TelegramBotLib = require('node-telegram-bot-api');
const TelegramBot = TelegramBotLib.default || TelegramBotLib;
const { getVideoUrl, getAllEpisodes, destroySession } = require('./index');
const { downloadStream, downloadWithAria2c, mergeVideos, getVideoInfo, cleanupFiles, tempPath, fileSizeMb } = require('./downloader');
const { cleanupStaleSessions } = require('./dramafren');
const { isGofileUrl, isGofileDirectUrl, filenameFromGofileUrl, resolveGofileFirstFile } = require('./gofile');
const { isPixeldrainUrl, extractPixeldrainId, getPixeldrainInfo } = require('./pixeldrain');
const { isSamehadakuUrl, resolveSamehadakuFullhd, parseSamehadakuEpisode, parseSamehadakuAnime } = require('./samehadaku');
const { isFiledonUrl, resolveFiledonFile } = require('./filedon');
const samehadakuEpisodeMap = new Map(); // fileUrl (gofile/pixeldrain) → { title, season, episode, provider }
const { getShareInfo, downloadShare, sanitize } = require('./ucdrive');
const { parseReelFrenUrl, getVideoUrlReelFren, getAllEpisodesReelFren } = require('./reelfren');
const { pool, initDatabase, getFreeDownloadCount, incrementFreeDownload: dbIncrementFreeDownload, cleanupOldDownloads, getCachedFileId, setCachedFileId, savePartFileId, getSetting, setSetting, searchDrama, listPartsWithFile, getPartFileId, upsertMedia, deletePart, deleteMedia, findMediaByName, listAllLibrary, getMediaBySlug, findMediaByPattern, saveVidaraUpload, getVidaraActiveDomain, setVidaraActiveDomain } = require('./db');
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

const API_MAX_RETRY = Number(process.env.API_MAX_RETRY) || 3;   // retry maksimal utk flood 429
const PART_SEND_DELAY_MS = Number(process.env.PART_SEND_DELAY_MS) || 8000; // jeda antar part di merge10

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parse flood limit Telegram: "Too Many Requests: retry after N" → N detik (ms)
function floodRetryMs(err) {
  const msg = err?.message?.description || err?.message || String(err || '');
  const m = msg.match(/retry after (\d+)/i);
  return m ? Number(m[1]) * 1000 : 0;
}

// Kirim via apiPost dengan retry saat flood 429 (tunggu retry_after lalu ulang).
function apiPost(method, payload, _retry = API_MAX_RETRY) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const url = `${API_BASE}/bot${TOKEN}/${method}`;
    const req = API_HTTP.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', async () => {
        try {
          const json = JSON.parse(body);
          if (json.ok) resolve(json.result);
          else {
            const err = new Error(json.description || `${method} failed`);
            const waitMs = floodRetryMs(err);
            if (waitMs > 0 && _retry > 0) {
              logger.warn({ method, retryAfterMs: waitMs, remaining: _retry, err: err.message }, 'apiPost flood — retry');
              await sleep(waitMs + 500);
              resolve(await apiPost(method, payload, _retry - 1));
            } else {
              reject(err);
            }
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendVideo(chatId, filePath, opts = {}, cacheInfo = null) {
  const { caption, supports_streaming, duration, width, height, message_thread_id, parse_mode } = opts;
  const cap = caption ? caption.slice(0, 1024) : undefined;
  let result;
  let attempt = 0;
  for (;;) {
    try {
      result = LOCAL_API_PORT
        ? await apiPost('sendVideo', {
            chat_id: chatId,
            video: `file://${filePath}`,
            caption: cap,
            parse_mode,
            supports_streaming,
            ...(message_thread_id && { message_thread_id }),
            ...(duration && { duration }),
            ...(width && { width }),
            ...(height && { height }),
          })
        : await bot.sendVideo(chatId, filePath, {
            caption: cap,
            parse_mode,
            supports_streaming,
            ...(message_thread_id && { message_thread_id }),
            ...(duration && { duration }),
            ...(width && { width }),
            ...(height && { height }),
          });
      break;
    } catch (err) {
      const waitMs = floodRetryMs(err);
      if (waitMs > 0 && attempt < API_MAX_RETRY) {
        attempt += 1;
        logger.warn({ chatId, retryAfterMs: waitMs, attempt, err: err.message }, 'sendVideo flood — retry');
        await sleep(waitMs + 500);
        continue;
      }
      throw err;
    }
  }
  if (cacheInfo) {
    const fileId = result?.video?.file_id;
    if (fileId) setCachedFileId(cacheInfo.urlHash, cacheInfo.source, fileId, 'video', cacheInfo.fileName).catch(() => {});
  }
  return result;
}

async function sendAudio(chatId, filePath, opts = {}, cacheInfo = null) {
  const { caption } = opts;
  const cap = caption ? caption.slice(0, 1024) : undefined;
  const result = LOCAL_API_PORT
    ? await apiPost('sendAudio', {
        chat_id: chatId,
        audio: `file://${filePath}`,
        caption: cap,
      })
    : await bot.sendAudio(chatId, filePath, { caption: cap });
  if (cacheInfo) {
    const fileId = result?.audio?.file_id;
    if (fileId) setCachedFileId(cacheInfo.urlHash, cacheInfo.source, fileId, 'audio', cacheInfo.fileName).catch(() => {});
  }
  return result;
}

async function sendDocument(chatId, filePath, opts = {}, cacheInfo = null) {
  const { caption } = opts;
  const cap = caption ? caption.slice(0, 1024) : undefined;
  const result = LOCAL_API_PORT
    ? await apiPost('sendDocument', {
        chat_id: chatId,
        document: `file://${filePath}`,
        caption: cap,
      })
    : await bot.sendDocument(chatId, filePath, { caption: cap });
  if (cacheInfo) {
    const fileId = result?.document?.file_id;
    if (fileId) setCachedFileId(cacheInfo.urlHash, cacheInfo.source, fileId, 'document', cacheInfo.fileName).catch(() => {});
  }
  return result;
}

async function sendPhoto(chatId, filePath, opts = {}) {
  const { caption } = opts;
  const cap = caption ? caption.slice(0, 1024) : undefined;
  return LOCAL_API_PORT
    ? await apiPost('sendPhoto', {
        chat_id: chatId,
        photo: `file://${filePath}`,
        caption: cap,
        parse_mode: 'HTML',
      })
    : await bot.sendPhoto(chatId, filePath, { caption: cap, parse_mode: 'HTML' });
}

const MAX_UPLOAD_MB = LOCAL_API_PORT ? 2000 : 49;

const ADMIN_IDS = (process.env.ADMIN_USER_IDS || '').split(',').map(Number).filter(Boolean);
const STAR_PRICE = Number(process.env.STAR_PRICE) || 10;
const FREE_DOWNLOAD_LIMIT = Number(process.env.FREE_DOWNLOAD_LIMIT) || 3;

// ─── Paket VIP & harga Stars (source: services/vipPackages.js) ────────────
const { VIP_PACKAGES, VIP_STAR_PRICES, VIP_PACKAGE_ORDER } = require('./services/vipPackages');

// ─── ReelFren group topic mirror (optional) ──────────────────────────────────
const RF_GROUP_ID = process.env.RF_GROUP_ID ? Number(process.env.RF_GROUP_ID) : null;
const RF_GROUP_ENABLED = (process.env.RF_GROUP_ENABLED || 'false') === 'true';
// Provider yang subtitlenya di-burn-in (hardcode) ke video, mis. cubetv
const BURN_SUBTITLE_PROVIDERS = (process.env.BURN_SUBTITLE_PROVIDERS || 'cubetv').split(',').map(s => s.trim()).filter(Boolean);
const RF_TOPICS_FILE = path.join(__dirname, '..', 'data', 'reelfren_topics.json');
const reelfrenTopics = new Map(); // provider -> message_thread_id

function loadReelfrenTopics() {
  try {
    const raw = fs.readFileSync(RF_TOPICS_FILE, 'utf8');
    const data = JSON.parse(raw);
    for (const [provider, threadId] of Object.entries(data)) {
      reelfrenTopics.set(provider, threadId);
    }
  } catch { /* file belum ada — mapping kosong */ }
}

function saveReelfrenTopics() {
  try {
    fs.mkdirSync(path.dirname(RF_TOPICS_FILE), { recursive: true });
    fs.writeFileSync(RF_TOPICS_FILE, JSON.stringify(Object.fromEntries(reelfrenTopics), null, 2));
  } catch (err) {
    logger.warn({ err: err.message }, 'Gagal simpan mapping topic ReelFren');
  }
}

async function getOrCreateTopic(provider) {
  if (reelfrenTopics.has(provider)) return reelfrenTopics.get(provider);
  const topic = await bot.createForumTopic(RF_GROUP_ID, provider);
  reelfrenTopics.set(provider, topic.message_thread_id);
  saveReelfrenTopics();
  logger.info({ provider, threadId: topic.message_thread_id }, 'Topic ReelFren dibuat');
  return topic.message_thread_id;
}

async function sendToProviderTopic(provider, caption, posterPath) {
  if (!RF_GROUP_ENABLED || !RF_GROUP_ID) return;
  try {
    const threadId = await getOrCreateTopic(provider);
    const base = { message_thread_id: threadId, parse_mode: 'HTML' };
    if (posterPath) {
      await bot.sendPhoto(RF_GROUP_ID, posterPath, { ...base, caption });
    } else {
      await bot.sendMessage(RF_GROUP_ID, caption, base);
    }
  } catch (err) {
    logger.warn({ provider, err: err.message }, 'Kirim ke topic grup gagal');
  }
}

/**
 * Kirim video langsung ke topic provider (tanpa lewat privat chat).
 * Mengembalikan true jika berhasil, false jika gagal/skip (untuk fallback).
 */
async function sendToTopicVideo(provider, filePath, opts = {}) {
  if (!RF_GROUP_ENABLED || !RF_GROUP_ID) return null;
  try {
    const threadId = await getOrCreateTopic(provider);
    const result = await sendVideo(RF_GROUP_ID, filePath, { ...opts, message_thread_id: threadId });
    logger.info({ provider, threadId }, 'Video terkirim ke topic grup');
    return result;
  } catch (err) {
    logger.warn({ provider, err: err.message }, 'Kirim video ke topic grup gagal');
    return null;
  }
}

loadReelfrenTopics();
const bot = new TelegramBot(TOKEN, botOptions);
const sessions = new Map();
const aiChatSessions = new Map();
const pendingDownloads = new Map(); // chatId → { url, handler, fileName }
const pendingDeletes = new Map(); // chatId → { slug, part, name }
const pendingReplaces = new Map(); // chatId → { slug, part, name }
const pendingAdds = new Map(); // chatId → { slug, nextPart, name }
const pendingAiEndpoint = new Map(); // chatId → true (menunggu input URL custom AI)
const pendingAiKey = new Map(); // chatId → true (menunggu input API key)
const pendingAiModel = new Map(); // chatId → true (menunggu input model)
const pendingVidaraDomain = new Map(); // chatId → true (menunggu input domain Vidara)
const pendingMediaAlbums = new Map(); // media_group_id → { chatId, caption, fileIds: [], timer }
const pendingDupScrape = new Map(); // chatId → { type, provider, fullId, lang, episodes, meta, userId, rfParams, params }
const vidaraBusy = new Map(); // chatId → true (upload ke Vidara sedang berjalan)
const aiChatRateLimit = new Map(); // chatId -> [timestamps]

const AI_CHAT_RATE_LIMIT = Number(process.env.AI_CHAT_RATE_LIMIT) || 3;   // pesan per menit
const AI_CHAT_WINDOW_MS = Number(process.env.AI_CHAT_WINDOW_MS) || 60_000;

function aiChatRateCheck(chatId) {
  const now = Date.now();
  const stamps = (aiChatRateLimit.get(chatId) || []).filter(t => now - t < AI_CHAT_WINDOW_MS);
  aiChatRateLimit.set(chatId, stamps);
  if (stamps.length >= AI_CHAT_RATE_LIMIT) return false;
  stamps.push(now);
  aiChatRateLimit.set(chatId, stamps);
  return true;
}

async function getImageBase64(fileId) {
  try {
    const file = await bot.getFile(fileId);
    if (!file || !file.file_path) return null;
    const baseUrl = LOCAL_API_PORT ? `http://127.0.0.1:${LOCAL_API_PORT}` : 'https://api.telegram.org';
    const url = `${baseUrl}/file/bot${TOKEN}/${file.file_path}`;
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
    const mime = file.file_path.endsWith('.png') ? 'image/png' : file.file_path.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    const base64 = Buffer.from(res.data).toString('base64');
    return `data:${mime};base64,${base64}`;
  } catch (err) {
    logger.warn({ fileId, err: err.message }, 'getImageBase64 failed');
    return null;
  }
}

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

async function sendInvoice(chatId, title, description, payload, price, label = 'Download access') {
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
        parse_mode: 'HTML',
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
        parse_mode: 'HTML',
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
  constructor(chatId, title, episodes, opts = {}) {
    this.chatId = chatId;
    this.title = title;
    this.msgId = null;
    this.t0 = Date.now();
    this.timer = null;
    this.editing = false;
    this.isParts = !!opts.isParts; // mode ringkasan per-part (merge10)

    // Track status tiap episode/part
    this.episodes = episodes.map(ep => ({
      ep: ep.ep || ep,
      label: this.isParts ? (ep.label || null) : null,
      status: 'pending',
      detail: '',
      size: 0,
    }));
    this.notes = [];
  }

  // Tambah catatan (mis. "terkirim ke topic") — dirender di bagian bawah tiap edit
  note(text) {
    if (text) this.notes.push(text);
    return this;
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

    const progressBar = `<code>${'█'.repeat(Math.floor(progress / 5))}${'░'.repeat(20 - Math.floor(progress / 5))}</code> ${progress}%`;
    const rows = this.episodes.map(e => {
      const icon = STATUS_ICONS[e.status] || '⏳';
      const detail = e.detail ? ` — ${e.detail}` : '';
      const size = e.size ? ` (${e.size})` : '';
      const name = e.label || `${e.ep}`;
      return `<tr><td>${icon} ${e.status}</td><td>${name}${detail}${size}</td></tr>`;
    }).join('');
    const table = `<table bordered striped compact><tr><th>Status</th><th>${this.isParts ? 'Part' : 'Episode'}</th></tr>${rows}</table>`;
    const notesHtml = this.notes.length ? this.notes.map(n => `<br><blockquote>${n}</blockquote>`).join('') : '';
    const footer = `<footer>⏱ ${mm}:${ss} | ✅ ${doneCount}/${total}${failCount > 0 ? ` | ❌ ${failCount}` : ''}</footer>`;

    return `<h4>📥 ${this.title}</h4>${progressBar}<br><details open><summary>${this.isParts ? 'Part' : 'Episode'} (${doneCount}✓/${total})${failCount > 0 ? ` · ${failCount}✗` : ''}</summary>${table}</details><hr/>${footer}${notesHtml}`;
  }

  _richRequest(method, payload) {
    const baseUrl = LOCAL_API_PORT ? `http://127.0.0.1:${LOCAL_API_PORT}` : 'https://api.telegram.org';
    const http = require(LOCAL_API_PORT ? 'http' : 'https');
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const req = http.request(`${baseUrl}/bot${TOKEN}/${method}`, {
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

  renderRichDone() {
    const sec = Math.floor((Date.now() - this.t0) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    const doneCount = this.episodes.filter(e => e.status === 'done').length;
    const failCount = this.episodes.filter(e => e.status === 'fail').length;
    const total = this.episodes.length;

    const totalMb = this.episodes.reduce((acc, e) => {
      if (e.status !== 'done') return acc;
      const raw = e.size ? String(e.size) : String(e.detail || '');
      const m = raw.match(/(\d+(?:\.\d+)?) MB/);
      if (m) return acc + parseFloat(m[1]);
      return acc;
    }, 0);
    const sizeStr = totalMb > 0 ? ` · ${Math.round(totalMb)} MB` : '';

    const totalUnit = this.isParts
      ? (this.totalEpisodes ? `${total} part · ${this.totalEpisodes} episode` : `${total} part`)
      : `${total} episode`;
    const okLabel = this.isParts ? 'Part berhasil' : 'Berhasil';

    const rows = this.episodes.map(e => {
      const icon = STATUS_ICONS[e.status] || '⏳';
      const name = e.label || `${e.ep}`;
      const rawSize = e.size ? String(e.size) : (String(e.detail || '').match(/(\d+(?:\.\d+)? MB)/) || [''])[0];
      const cleanDetail = e.detail && e.detail !== rawSize ? ` — ${e.detail}` : '';
      return `<tr><td>${icon}</td><td>${name}${cleanDetail}</td><td>${rawSize || '—'}</td></tr>`;
    }).join('');
    const table = `<table bordered striped compact><caption>Detail</caption><tr><th>Status</th><th>${this.isParts ? 'Part' : 'Episode'}</th><th>Ukuran</th></tr>${rows}</table>`;
    const notesHtml = this.notes.length ? this.notes.map(n => `<br><blockquote>${n}</blockquote>`).join('') : '';
    const footer = `<footer>Total: ${totalUnit}${sizeStr} · ${okLabel} ${doneCount}${failCount > 0 ? ` · Gagal ${failCount}` : ''} · ⏱ ${mm}:${ss}</footer>`;
    const button = `<tg-button-row align="center"><tg-button type="callback_data" data="act:main_menu">📚 Menu Utama</tg-button></tg-button-row>`;

    return `<h4>✅ ${this.title} — Selesai</h4><details><summary>📊 ${totalUnit}${sizeStr} · ${doneCount}✓${failCount > 0 ? ` · ${failCount}✗` : ''}</summary>${table}</details><hr/>${notesHtml}${footer}<br>${button}`;
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
      const name = e.label || `${e.ep}`;
      return `${icon} ${name}${detail}${size}`;
    });
    const notesLines = this.notes.length ? ['', ...this.notes.map(n => `• ${n}`)] : [];

    return [
      `<b>📥 ${this.title}</b>`,
      `<code>${'█'.repeat(Math.floor(progress / 5))}${'░'.repeat(20 - Math.floor(progress / 5))}</code> ${progress}%`,
      '',
      ...lines,
      '',
      `⏱ ${mm}:${ss} | ✅ ${doneCount}/${total}` + (failCount > 0 ? ` | ❌ ${failCount}` : ''),
      ...notesLines,
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

  updateLabel(label, status, detail = '', size = 0) {
    const item = this.episodes.find(e => e.label === label);
    if (item) {
      item.status = status;
      item.detail = detail;
      item.size = size;
    }
  }

  async done(note = '') {
    clearInterval(this.timer);
    const sec = Math.floor((Date.now() - this.t0) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    const doneCount = this.episodes.filter(e => e.status === 'done').length;
    const failCount = this.episodes.filter(e => e.status === 'fail').length;

    logger.info({ chatId: this.chatId, duration: sec, done: doneCount, fail: failCount }, 'RichProgress done');

    if (note) this.notes.push(note);
    const htmlContent = this.renderRichDone();

    // Anti-race dgn tick() yang masih in-flight (max ~2 detik)
    for (let i = 0; i < 20 && this.editing; i++) await sleep(100);

    if (this.msgId) {
      try {
        await this._richRequest('editMessageText', {
          chat_id: this.chatId,
          message_id: this.msgId,
          rich_message: { html: htmlContent },
        });
      } catch (err) {
        logger.warn({ chatId: this.chatId, err: err.message }, 'RichProgress done edit failed, fallback sendRichMessage');
        try { await sendRichMessage(this.chatId, htmlContent); } catch {}
      }
    } else {
      try { await sendRichMessage(this.chatId, htmlContent); } catch {}
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
    [{ text: '📚 Cari Drama/Anime', callback_data: 'act:lib_search' }],
    [{ text: '🎬 Drama', callback_data: 'act:lib_list_c:drama:1' }, { text: '🎌 Anime', callback_data: 'act:lib_list_c:anime:1' }],
    [{ text: '💬 Live Chat', callback_data: 'act:ai' }],
    [{ text: '❓ Bantuan', callback_data: 'act:help' }],
  ];
  if (isAdminUser) {
    buttons.push([{ text: '🛠 Admin Panel', callback_data: 'act:admin_panel' }]);
  }
  return { inline_keyboard: buttons };
}

function replyMainKeyboard(isAdminUser = false) {
  const rows = [
    [{ text: '📚 Katalog' }, { text: '🔍 Cari' }],
    [{ text: '💬 Live Chat' }, { text: '👤 Akun' }],
  ];
  if (isAdminUser) rows.push([{ text: '🛠 Admin Panel' }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true, one_time_keyboard: false };
}

function breadcrumbKeyboard(isAdminUser = false) {
  return {
    inline_keyboard: [
      [{ text: '📚 Katalog', callback_data: 'act:lib_list' }, { text: '🔍 Cari', callback_data: 'act:lib_search' }],
      [{ text: '🏠 Menu Utama', callback_data: 'act:main_menu' }],
    ],
  };
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

function mainActionKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📥 Telegram — per episode', callback_data: 'act:per_ep' }],
      [{ text: '🗜 Telegram — gabung 10', callback_data: 'act:merge10' }],
      [{ text: '📥 Vidara — per episode', callback_data: 'act:v_per_ep' }],
      [{ text: '🗜 Vidara — gabung 10', callback_data: 'act:v_merge10' }],
      [{ text: '📥 Vidara+TG — per episode', callback_data: 'act:vt_per_ep' }],
      [{ text: '🗜 Vidara+TG — gabung 10', callback_data: 'act:vt_merge10' }],
      [{ text: '🔢 Pilih episode', callback_data: 'act:list' }],
      [{ text: '💬 Live Chat', callback_data: 'act:ai' }],
      [{ text: '🏠 Menu Utama', callback_data: 'act:main_menu' }],
    ],
  };
}

// ─── Slug cache (Telegram callback_data max 64 bytes, slug bisa 73+) ──────────
const slugCache = new Map(); // shortId -> fullSlug
let slugCacheCounter = 0;
function cacheSlug(slug) {
  // cleanup entries > 30 menit
  if (slugCache.size > 500) {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [k, v] of slugCache) { if (v.ts < cutoff) slugCache.delete(k); }
  }
  const id = String(++slugCacheCounter);
  slugCache.set(id, { slug, ts: Date.now() });
  return id;
}
function resolveSlug(id) {
  const entry = slugCache.get(String(id));
  return entry ? entry.slug : null;
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
function truncateText(t, max = 64) {
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// ─── Library keyboards ────────────────────────────────────────────────────────

function librarySearchResultKeyboard(dramas) {
  const rows = dramas.map(d => {
    const isAnime = d.slug.startsWith('anime:');
    const unit = isAnime ? 'episode' : 'part';
    const epInfo = d.total_eps > 0 ? `${d.total_eps} ep` : `${d.lib_parts} ${unit}`;
    const tag = isAnime ? '🎌 Anime' : '🎬 Drama';
    const icon = isAnime ? '🎌' : '🎬';
    const label = d.lib_parts > 0
      ? `${icon} ${d.nama} (${epInfo}) · ${tag}`
      : `${icon} ${d.nama} · ${tag}`;
    return [{ text: truncateText(label), callback_data: `lib_menu:${cacheSlug(d.slug)}` }];
  });
  rows.push([{ text: '⬅️ Kembali', callback_data: 'act:lib_search' }]);
  return { inline_keyboard: rows };
}

async function buildLibraryKeyboard(kat = 'all', page = 1, all = null) {
  all = all || await listAllLibrary();
  const isAnime = (slug) => slug.startsWith('anime:');
  const list = kat === 'all'
    ? all
    : all.filter(d => (kat === 'anime') === isAnime(d.slug));
  const perPage = 20;
  const totalPages = Math.max(1, Math.ceil(list.length / perPage));
  const safePage = Math.min(Math.max(1, page || 1), totalPages);
  const start = (safePage - 1) * perPage;
  const slice = list.slice(start, start + perPage);

  const dramaCount = all.filter(d => !isAnime(d.slug)).length;
  const animeCount = all.length - dramaCount;

  const rows = slice.map(d => {
    const anime = isAnime(d.slug);
    const unit = anime ? 'episode' : 'part';
    const epInfo = d.total_eps > 0 ? `${d.total_eps} ep` : '';
    const label = `${anime ? '🎌' : '🎬'} ${d.nama} (${d.lib_parts} ${unit}${epInfo ? `, ${epInfo}` : ''})`;
    return [{ text: truncateText(label), callback_data: `lib_menu:${cacheSlug(d.slug)}` }];
  });
  if (!rows.length) {
    const emptyLabel = kat === 'anime' ? 'Tidak ada anime' : (kat === 'drama' ? 'Tidak ada drama' : 'Kosong');
    rows.push([{ text: `📭 ${emptyLabel}`, callback_data: 'noop' }]);
  }

  const filterRow = [
    { text: `${kat === 'drama' ? '✅' : ''}🎬 Drama`, callback_data: 'act:lib_list_c:drama:1' },
    { text: `${kat === 'all' ? '✅' : ''}👍 Semua`, callback_data: 'act:lib_list_c:all:1' },
    { text: `${kat === 'anime' ? '✅' : ''}🎌 Anime`, callback_data: 'act:lib_list_c:anime:1' },
  ];

  if (list.length > 0) {
    const nav = [];
    if (safePage > 1) nav.push({ text: '⬅️ Prev', callback_data: `act:lib_list_c:${kat}:${safePage - 1}` });
    nav.push({ text: `${safePage}/${totalPages}`, callback_data: 'noop' });
    if (safePage < totalPages) nav.push({ text: 'Next ➡️', callback_data: `act:lib_list_c:${kat}:${safePage + 1}` });
    rows.push(nav);
  }
  rows.unshift(filterRow);

  let header;
  if (kat === 'drama') header = `🎬 <b>Daftar Drama</b> — ${list.length} judul (🎌 Anime: ${animeCount})`;
  else if (kat === 'anime') header = `🎌 <b>Daftar Anime</b> — ${list.length} judul (🎬 Drama: ${dramaCount})`;
  else header = `📚 <b>Daftar Library</b> — 🎬 Drama: ${dramaCount} · 🎌 Anime: ${animeCount}`;
  return { header, rows };
}

function libraryPartsKeyboard(slug, parts, isAdminUser = false) {
  const perPage = 20;
  const totalPages = Math.ceil(parts.length / perPage);
  const page = 1;
  const start = (page - 1) * perPage;
  const slice = parts.slice(start, start + perPage);
  const isAnime = slug.startsWith('anime:');
  const unit = isAnime ? 'Ep' : 'Part';
  const sid = cacheSlug(slug);
  const rows = [];
  for (let i = 0; i < slice.length; i += 5) {
    rows.push(
      slice.slice(i, i + 5).map(p => ({
        text: `${unit} ${p.part}`,
        callback_data: `lib_part:${sid}:${p.part}`,
      }))
    );
  }
  if (totalPages > 1) {
    const nav = [];
    nav.push({ text: `${page}/${totalPages}`, callback_data: 'noop' });
    nav.push({ text: 'Next ➡️', callback_data: `lib_menu:${sid}:p:2` });
    rows.push(nav);
  }
  if (isAdminUser) {
    rows.push([{ text: '🔄 Replace', callback_data: `lib_replace:${sid}` }]);
    rows.push([{ text: '➕ Tambah', callback_data: `lib_add:${sid}` }]);
  }
  rows.push([{ text: '⬅️ Kembali', callback_data: 'act:lib_list' }]);
  return { inline_keyboard: rows };
}

function libraryPartsPageKeyboard(slug, parts, page, isAdminUser = false) {
  const perPage = 20;
  const totalPages = Math.ceil(parts.length / perPage);
  const start = (page - 1) * perPage;
  const slice = parts.slice(start, start + perPage);
  const isAnime = slug.startsWith('anime:');
  const unit = isAnime ? 'Ep' : 'Part';
  const sid = cacheSlug(slug);
  const rows = [];
  for (let i = 0; i < slice.length; i += 5) {
    rows.push(
      slice.slice(i, i + 5).map(p => ({
        text: `${unit} ${p.part}`,
        callback_data: `lib_part:${sid}:${p.part}`,
      }))
    );
  }
  const nav = [];
  if (page > 1) nav.push({ text: '⬅️ Prev', callback_data: `lib_menu:${sid}:p:${page - 1}` });
  nav.push({ text: `${page}/${totalPages}`, callback_data: 'noop' });
  if (page < totalPages) nav.push({ text: 'Next ➡️', callback_data: `lib_menu:${sid}:p:${page + 1}` });
  rows.push(nav);
  if (isAdminUser) {
    rows.push([{ text: '🔄 Replace', callback_data: `lib_replace:${sid}` }]);
    rows.push([{ text: '➕ Tambah', callback_data: `lib_add:${sid}` }]);
  }
  rows.push([{ text: '⬅️ Kembali', callback_data: 'act:lib_list' }]);
  return { inline_keyboard: rows };
}

function titlePromptKeyboard(fileName, url, detectedTitle = null) {
  const label = detectedTitle
    ? (detectedTitle.length > 32 ? detectedTitle.slice(0, 29) + '...' : detectedTitle)
    : (fileName.length > 40 ? fileName.slice(0, 37) + '...' : fileName);
  const urlId = cacheUrl(url);
  return {
    inline_keyboard: [
      [{ text: `📥 Download: ${label}`, callback_data: `dl_title_use:${urlId}` }],
      [{ text: '✏️ Ganti Judul', callback_data: `dl_title_custom:${urlId}` }],
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
  // Parse pola kuronime "juduls{season}{episode}[v{n}]" → "judul s{season} Ep {episode}"
  s = s.replace(/\b([a-z]{4,})s(\d)(\d{1,2})(?:v\d)?\b/g, (m, t, season, ep) => `${t} s${season} Ep ${String(Number(ep))}`);
  // Parse pola kuronime part "juduls{season}prt{part}{episode}" → "judul Season {season} Part {part} Episode {episode}"
  s = s.replace(/\b([a-z]{4,})s(\d)prt(\d{1,2})(\d{2})\b/g, (m, t, season, part, ep) => `${t} Season ${season} Part ${part} Episode ${String(Number(ep))}`);
  // Parse pola kuronime tanpa season "judul{episode}" → "judul Episode {episode}"
  s = s.replace(/\b([a-z]{4,})(\d{2})\b/g, (m, t, ep) => `${t} Episode ${String(Number(ep))}`);
  // Handle "Ep15" → "Ep 15"
  s = s.replace(/\b(ep)(\d{1,3})$/gi, '$1 $2');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function parseKuronimeSeasonEpisode(fileName) {
  const base = fileName.replace(/\.(mp4|mkv|mov|avi|webm|mp3|aac|ogg|m4a|wav)$/i, '');
  let m = base.match(/([a-z]{3,})s(\d)(\d{1,2})(?:v\d)?$/i);
  if (m) return { titleSlug: m[1], season: Number(m[2]), episode: Number(m[3]) };
  return null;
}

function extractPartFromFilename(fileName) {
  const kur = parseKuronimeSeasonEpisode(fileName);
  if (kur) return kur.episode;
  const base = fileName.replace(/\.(mp4|mkv|mov|avi|webm|mp3|aac|ogg|m4a|wav)$/i, '');
  let m = base.match(/\b[Ee][Pp]\s*(\d{1,3})\b/);
  if (m) return Number(m[1]);
  m = base.match(/\b[Ee]pisode\s*(\d{1,3})\b/);
  if (m) return Number(m[1]);
  m = base.match(/\b[Ee]\s*(\d{1,3})\b/);
  if (m) return Number(m[1]);
  m = base.match(/\b[Pp]art\s*(\d{1,3})\b/);
  if (m) return Number(m[1]);
  m = base.match(/(\d{1,3})\s*$/);
  if (m) return Number(m[1]);
  return 1;
}

function sanitizeSlug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function extractSourcePattern(fileName) {
  // "1080p-0nizdxx-kuronime-ymintsgai06.mp4" → "kuronime-ymintsgai"
  // "1080p-nIVJp5U-kuronime-blcktrch04.mp4" → "kuronime-blcktrch"
  // "1080p-bBeCgqA-kuronime-tssdks401.mp4" → "kuronime-tssdk" (strip s+ep)
  // "1080p-?-kuronime-tnsrantssdk12-end.mp4" → "kuronime-tnsrantssdk" (strip episode + -end)
  const base = fileName.replace(/\.(mp4|mkv|mov|avi|webm|mp3|aac|ogg|m4a|wav)$/i, '');
  // Normalize season+episode suffix: tssdks401 → tssdk, ssounfrrens201 → ssounfrren, ymintsgai21 → ymintsgai
  // Handle "-end" suffix (episode terakhir kuronime): tnsrantssdk12-end → tnsrantssdk
  let normalized = base;
  normalized = normalized.replace(/-end$/i, '');               // strip -end
  normalized = normalized.replace(/([a-z]{3,})s\d\d{1,2}$/i, '$1');
  normalized = normalized.replace(/([a-z]{3,})\d{2,3}$/i, '$1');
  const noEp = normalized.replace(/-$/, '');
  const parts = noEp.split('-');
  const filtered = parts.filter((p, i) => {
    if (/^\d{3,4}p$/i.test(p)) return false; // resolution (1080p/720p)
    if (i >= 1 && /^[a-zA-Z0-9]{5,8}$/.test(p) && /[a-z]/.test(p) && /[A-Z]/.test(p)) return false; // random hash mixed case (bBeCgqA)
    if (i >= 1 && /^[a-z0-9]{5,8}$/.test(p) && /\d/.test(p) && /[a-z]/.test(p)) return false; // random hash lowercase+digit (0nizdxx)
    if (i >= 1 && /^[A-Z0-9]{5,8}$/.test(p) && /\d/.test(p)) return false; // random hash UPPER+digit (N39X3YF, 8DQOJmA)
    if (i >= 1 && /^[A-Z]{5,8}$/.test(p)) return false; // random hash UPPER-only (XXXXXXXX, KABULK9)
    return true;
  });
  const pattern = filtered.join('-');
  return pattern.length >= 5 ? pattern : null;
}

function extractProvider(fileName) {
  // "1080p-nIVJp5U-kuronime-blcktrch04.mp4" → "kuronime"
  const base = fileName.replace(/\.(mp4|mkv|mov|avi|webm|mp3|aac|ogg|m4a|wav)$/i, '');
  const parts = base.split('-');
  for (const p of parts) {
    // Skip resolution, random hash (mixed case alphanumeric), episode numbers
    if (/^\d{3,4}p$/i.test(p)) continue;
    if (/^[a-zA-Z0-9]{5,8}$/.test(p) && /[a-z]/.test(p) && /[A-Z]/.test(p)) continue;
    if (/^\d+$/.test(p)) continue;
    if (/^[a-zA-Z]{3,}$/.test(p)) return p.toLowerCase();
  }
  return 'unknown';
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

// ─── ReelFren handler ────────────────────────────────────────────────────────

async function handleReelFrenUrl(chatId, rfParams, userId) {
  const { provider, id, fullId, slug, ep, lang } = rfParams;
  const p = await new Progress(chatId, `ReelFren — ${provider} — ambil info`).start();
  let posterPath = null;

  try {
    const { episodes, meta } = await getAllEpisodesReelFren(provider, fullId, lang);
    if (!episodes.length) {
      await p.fail('Tidak ada episode ditemukan (backend mungkin down)');
      return;
    }

    // Cek duplikat di library — jika sudah ada, tampilkan notifikasi lanjut/batal
    const mediaSlugCheck = `reelfren_${provider}:${fullId}`;
    try {
      const dupMedia = await getMediaBySlug(mediaSlugCheck);
      if (dupMedia) {
        const dupParts = await listPartsWithFile(mediaSlugCheck);
        const dupText = `⚠️ <b>Sudah ada di Library</b>\n\n🎬 <b>${dupMedia.nama}</b>\n📦 ${dupParts.length}/${dupMedia.total_eps || episodes.length} part tersimpan\n📡 Provider: <code>${provider}</code>\n\nKirim ulang akan scrape ulang <b>${episodes.length} episode</b>. Lanjutkan atau Batalkan?`;
        pendingDupScrape.set(String(chatId), { type: 'reelfren', provider, fullId, slug, lang, episodes, meta, userId, rfParams });
        await p.done('Cek duplikat');
        return bot.sendMessage(chatId, dupText, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '✅ Lanjutkan', callback_data: 'act:dup_yes' }, { text: '❌ Batalkan', callback_data: 'act:dup_no' }]] }
        });
      }
    } catch {}

    // Store session in the same format as dramafren
    sessions.set(String(chatId), {
      subdomain: `reelfren_${provider}`,
      id: fullId,
      slug,
      lang,
      userId,
      episodes,
      meta: { ...meta, provider, source: 'reelfren' },
    });
    logger.info({ chatId, provider, fullId, totalEp: episodes.length }, 'ReelFren session created');

    const epFirst = episodes[0].ep;
    const epLast = episodes[episodes.length - 1].ep;

    const caption = [
      `<b>${meta.title || fullId}</b>`,
      `📡 Provider: <code>${provider}</code>`,
      '',
      meta.synopsis ? meta.synopsis.slice(0, 300) + (meta.synopsis.length > 300 ? '...' : '') : '',
      '',
      `🎞 <b>${episodes.length} episode</b> (Ep ${epFirst}–${epLast})`,
    ].filter(Boolean).join('\n');

    await p.done(`${episodes.length} episode`);

    // Kirim poster jika ada (sama seperti flow dramafren)
    let posterFileId = null;
    if (meta.poster) {
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
        const posterResult = await sendPhoto(chatId, posterPath, { caption });
        posterFileId = Array.isArray(posterResult?.photo) ? posterResult.photo[posterResult.photo.length - 1]?.file_id || null : posterResult?.photo?.file_id || null;
        // Simpan poster_file_id ke session untuk disimpan ke library
        const curSession = sessions.get(String(chatId));
        if (curSession) curSession.meta.poster_file_id = posterFileId;
      } catch {
        logger.warn({ chatId, poster: meta.poster }, 'ReelFren poster gagal dikirim, fallback ke teks');
        await bot.sendMessage(chatId, caption, { parse_mode: 'HTML' });
      }
    } else {
      await bot.sendMessage(chatId, caption, { parse_mode: 'HTML' });
    }

    // Keyboard opsi download (sendPhoto tidak meneruskan reply_markup)
    await bot.sendMessage(chatId, 'Pilih aksi:', { reply_markup: mainActionKeyboard() });

    // Mirror ke topic grup per provider (hanya admin)
    if (isAdmin(userId)) {
      await sendToProviderTopic(provider, caption, posterPath);
    }
  } catch (err) {
    logger.error({ chatId, provider, fullId, err: err.message }, 'ReelFren handler error');
    await p.fail(`Error: ${err.message.slice(0, 100)}`);
  } finally {
    if (posterPath) cleanupFiles(posterPath);
  }
}

async function handleGofileUrl(chatId, url, customTitle = null) {
  const gofileToken = (process.env.GOFILE_TOKEN || '').trim();
  const urlHash = hashUrl(url);
  const extraHeaders = {
    'Referer': 'https://gofile.io/',
    ...(gofileToken && { 'Authorization': `Bearer ${gofileToken}` }),
  };
  // Deteksi Samehadaku: pakai season/episode dari map (provider samehadaku)
  const sami = samehadakuEpisodeMap.get(url);
  const isSame = !!sami;

  if (isGofileDirectUrl(url)) {
    const fileName = filenameFromGofileUrl(url);

    // Auto-detect title dari source pattern jika gak ada custom title
    if (!customTitle) {
      const pattern = extractSourcePattern(fileName);
      logger.info({ pattern, fileName }, 'Checking source pattern for auto-detect (gofile)');
      if (pattern) {
        const matched = await findMediaByPattern(pattern);
        logger.info({ matched: matched?.nama || null, pattern }, 'Pattern match result (gofile)');
        if (matched) {
          customTitle = matched.nama;
          logger.info({ pattern, matched: matched.nama }, 'Auto-detected title from source pattern (gofile)');
        }
      }
    }

    const cap = customTitle || cleanCaption(fileName);
    const goPartInit = extractPartFromFilename(fileName);
    const capWithEp = customTitle ? `${cap} — Episode ${goPartInit}` : cap;
    const cacheInfo = { urlHash, source: 'gofile', fileName };
    const rp = await new RichProgress(chatId, cap, [{ ep: capWithEp }]).start();
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

      if (sizeMb > MAX_UPLOAD_MB) {
        rp.updateEpisode(capWithEp, 'fail', `${sizeMb.toFixed(1)} MB > limit`);
        return;
      }

      rp.updateEpisode(capWithEp, 'upload', `${sizeMb.toFixed(1)} MB`);

      const info = await getVideoInfo(outPath).catch(() => ({}));
      const ext = path.extname(outPath).toLowerCase();
      let sendResult = null;

      // Build caption: Samehadaku prioritas, lalu kuronime Season detect, else generic
      const kurSame = parseKuronimeSeasonEpisode(fileName);
      const goPart = extractPartFromFilename(fileName);
      let finalCap = cap;
      if (customTitle) {
        if (isSame && sami) {
          const cleanTitle = sami.title || customTitle.replace(/\s*(?:Episode|Ep|Part|E)\s*\d+\s*/gi, ' ').trim();
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
              `➧ Episode :- Episode ${sami.episode}`,
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
            `➧ Episode :- Episode ${goPart}`,
            `➧ Provider :- ${extractProvider(fileName)}`,
          ].join('\n');
        }
      }

      if (VIDEO_EXTS.has(ext)) {
        sendResult = await sendVideo(chatId, outPath, {
          caption: finalCap,
          supports_streaming: true,
          ...(info.duration && { duration: info.duration }),
          ...(info.width && { width: info.width }),
          ...(info.height && { height: info.height }),
        }, cacheInfo);
      } else if (AUDIO_EXTS.has(ext)) {
        await sendAudio(chatId, outPath, { caption: finalCap }, cacheInfo);
      } else {
        await sendDocument(chatId, outPath, { caption: finalCap }, cacheInfo);
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
    // Auto-detect title dari source pattern jika gak ada custom title
    if (!customTitle) {
      const pattern = extractSourcePattern(file.name);
      logger.info({ pattern, fileName: file.name }, 'Checking source pattern for auto-detect (gofile share)');
      if (pattern) {
        const matched = await findMediaByPattern(pattern);
        logger.info({ matched: matched?.nama || null, pattern }, 'Pattern match result (gofile share)');
        if (matched) {
          customTitle = matched.nama;
          logger.info({ pattern, matched: matched.nama }, 'Auto-detected title from source pattern (gofile share)');
        }
      }
    }
    cap = customTitle || cleanCaption(file.name);
    const fileName = file.name;
    const cacheInfo = { urlHash, source: 'gofile', fileName };
    const capWithEp = customTitle ? `${cap} — Episode ${extractPartFromFilename(file.name)}` : cap;
    rp = await new RichProgress(chatId, cap, [{ ep: capWithEp }]).start();

    if (file.size / 1024 / 1024 > MAX_UPLOAD_MB) {
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
    const batchPart = extractPartFromFilename(file.name);
    let finalCap = cap;
    if (customTitle) {
      if (isSame && sami) {
        const cleanTitle = sami.title || customTitle.replace(/\s*(?:Episode|Ep|Part|E)\s*\d+\s*/gi, ' ').trim();
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
            `➧ Episode :- Episode ${sami.episode}`,
            `➧ Provider :- samehadaku`,
          ].join('\n');
        }
      } else {
        const cleanTitle = customTitle.replace(/\s*(?:Episode|Ep|Part|E)\s*\d+\s*/gi, ' ').trim();
        finalCap = [
          `➧ Judul :- ${cleanTitle || customTitle}`,
          `➧ Episode :- Episode ${batchPart}`,
          `➧ Provider :- ${extractProvider(file.name)}`,
        ].join('\n');
      }
    }

    if (VIDEO_EXTS.has(fext)) {
      sendResult = await sendVideo(chatId, outPath, {
        caption: finalCap,
        supports_streaming: true,
        ...(info.duration && { duration: info.duration }),
        ...(info.width && { width: info.width }),
        ...(info.height && { height: info.height }),
      }, cacheInfo);
    } else if (AUDIO_EXTS.has(fext)) {
      await sendAudio(chatId, outPath, { caption: finalCap }, cacheInfo);
    } else {
      await sendDocument(chatId, outPath, { caption: finalCap }, cacheInfo);
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

async function handlePixeldrainUrl(chatId, url, customTitle = null) {
  let outPath = null;
  const sami = samehadakuEpisodeMap.get(url);
  const isSame = !!sami;
  let rp;
  let cap = '';
  const urlHash = hashUrl(url);
  try {
    const info = await getPixeldrainInfo(url);
    const sizeMb = (info.size / 1024 / 1024).toFixed(1);
    const fileName = info.name;

    // Auto-detect title dari source pattern jika gak ada custom title
    if (!customTitle) {
      const pattern = extractSourcePattern(fileName);
      logger.info({ pattern, fileName }, 'Checking source pattern for auto-detect');
      if (pattern) {
        const matched = await findMediaByPattern(pattern);
        logger.info({ matched: matched?.nama || null, pattern }, 'Pattern match result');
        if (matched) {
          customTitle = matched.nama;
          logger.info({ pattern, matched: matched.nama }, 'Auto-detected title from source pattern');
        }
      }
    }

    cap = customTitle || cleanCaption(fileName);
    const pixPart = extractPartFromFilename(info.name);
    const capWithEp = customTitle ? `${cap} — Episode ${pixPart}` : cap;
    const cacheInfo = { urlHash, source: 'pixeldrain', fileName };
    rp = await new RichProgress(chatId, cap, [{ ep: capWithEp }]).start();

    const capWithEpForLimit = capWithEp;
    if (info.size / 1024 / 1024 > MAX_UPLOAD_MB) {
      rp.updateEpisode(capWithEpForLimit, 'fail', `${sizeMb} MB > limit`);
      rp.done();
      return;
    }

    const ext = path.extname(info.name) || '';
    outPath = tempPath(`pixeldrain_${Date.now()}${ext}`);

    rp.updateEpisode(cap, 'download');
    const capEp = cap;
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
    const part = extractPartFromFilename(info.name);
    let finalCap = cap;
    if (customTitle) {
      if (isSame && sami) {
        const cleanTitle = sami.title || customTitle.replace(/\s*(?:Episode|Ep|Part|E)\s*\d+\s*/gi, ' ').trim();
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
            `➧ Episode :- Episode ${sami.episode}`,
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
          `➧ Episode :- Episode ${part}`,
          `➧ Provider :- ${extractProvider(info.name)}`,
        ].join('\n');
      }
    }

    const vinfo = await getVideoInfo(outPath).catch(() => ({}));
    const fext = path.extname(outPath).toLowerCase();
    let sendResult = null;
    if (VIDEO_EXTS.has(fext)) {
      sendResult = await sendVideo(chatId, outPath, {
        caption: finalCap,
        supports_streaming: true,
        ...(vinfo.duration && { duration: vinfo.duration }),
        ...(vinfo.width && { width: vinfo.width }),
        ...(vinfo.height && { height: vinfo.height }),
      }, cacheInfo);
    } else if (AUDIO_EXTS.has(fext)) {
      await sendAudio(chatId, outPath, { caption: finalCap }, cacheInfo);
    } else {
      await sendDocument(chatId, outPath, { caption: finalCap }, cacheInfo);
    }
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
      supports_streaming: supports_streaming ?? true,
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

    const dlId = cacheUrl(url);
    await bot.sendMessage(chatId,
      `📁 <b>${cap}</b>\n` +
      `💾 Ukuran: ${sizeStr}\n` +
      `🔗 Sumber: gofile.io\n\n` +
      `${freeInfo}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: `📥 Download (${sizeStr})`, callback_data: `dl:gofile:${dlId}` }]] } }
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

    const dlId = cacheUrl(url);
    await bot.sendMessage(chatId,
      `📁 <b>${cap}</b>\n` +
      `💾 Ukuran: ${sizeStr}\n` +
      `🔗 Sumber: pixeldrain.com\n\n` +
      `${freeInfo}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: `📥 Download (${sizeStr})`, callback_data: `dl:pixeldrain:${dlId}` }]] } }
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

  let result;
  if (subdomain.startsWith('reelfren_')) {
    // ReelFren multi-provider
    const provider = subdomain.replace('reelfren_', '');
    result = await getVideoUrlReelFren(provider, id, ep, lang).catch((err) => {
      logger.error({ chatId, episode: ep, err: { message: err.message, stack: err.stack } }, 'getVideoUrlReelFren failed');
      return null;
    });
  } else {
    result = await getVideoUrl(subdomain, id, slug, ep, 1, lang).catch((err) => {
      logger.error({ chatId, episode: ep, err: { message: err.message, stack: err.stack } }, 'getVideoUrl failed');
      return null;
    });
  }
  if (!result?.videoUrl) {
    await p.fail(`Ep ${ep}: URL tidak ditemukan`);
    return null;
  }

const outPath = tempPath(`ep${ep}.mp4`);
  const streamType = result.videoUrl.includes('m3u8') ? 'HLS' : 'MP4';
  const isReelFren = subdomain.startsWith('reelfren_');
  const provider = isReelFren ? subdomain.replace('reelfren_', '') : null;
  const burnSubtitle = !!provider && BURN_SUBTITLE_PROVIDERS.includes(provider);

  try {
    p.update(`Ep ${ep} — download ${streamType}`);
    logger.info({ chatId, episode: ep, streamType, url: result.videoUrl.slice(0, 80), burnSubtitle }, 'Download starting');
    await downloadStream(result.videoUrl, outPath, (log) => {
      if (log.includes('progress:')) {
        const t = log.split('progress: ')[1];
        p.update(`Ep ${ep} — download ${t}`);
      }
    }, result.subtitleUrl, { burnSubtitle });
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
      const session = sessions.get(String(chatId));
      const mirrorToTopic = isReelFren && isAdmin(session?.userId) && RF_GROUP_ENABLED && RF_GROUP_ID;
      if (mirrorToTopic) {
        const sent = await sendToTopicVideo(provider, outPath, opts);
        if (sent) {
          logger.info({ chatId, episode: ep, sizeMb: sizeMb.toFixed(1) }, 'Video sent to topic');
          await p.done(`Ep ${ep} — terkirim ke topic <b>${provider}</b> di grup`);
        } else {
          await sendVideo(chatId, outPath, opts);
          logger.info({ chatId, episode: ep, sizeMb: sizeMb.toFixed(1) }, 'Video sent (fallback chat)');
          await p.done(`Ep ${ep} — selesai (${sizeMb.toFixed(1)} MB)`);
        }
      } else {
        await sendVideo(chatId, outPath, opts);
        logger.info({ chatId, episode: ep, sizeMb: sizeMb.toFixed(1) }, 'Video sent');
        await p.done(`Ep ${ep} — selesai (${sizeMb.toFixed(1)} MB)`);
      }
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
  const isReelFren = subdomain.startsWith('reelfren_');
  const provider = isReelFren ? subdomain.replace('reelfren_', '') : null;
  const burnSubtitle = !!provider && BURN_SUBTITLE_PROVIDERS.includes(provider);
  const dramaTitle = session?.meta?.title || (slug ? slug.replace(/-/g, ' ') : subdomain);

  // 1 rich message untuk SEMUA part — baris = part, di-update in-place
  const partLabels = chunks.map((chunk, i) => {
    const epStart = chunk[0].ep;
    const epEnd = chunk[chunk.length - 1].ep;
    return { ep: i + 1, label: `Part ${i + 1} (Ep ${epStart}–${epEnd})` };
  });
  const rp = await new RichProgress(chatId, dramaTitle, partLabels, { isParts: true }).start();
  rp.totalEpisodes = episodes.length;
  logger.info({ chatId, subdomain, totalParts, totalEp: episodes.length }, 'Starting merge10 batch');

  for (let part = 0; part < totalParts; part++) {
    const chunk = chunks[part];
    const epStart = chunk[0].ep;
    const epEnd = chunk[chunk.length - 1].ep;
    const partLabel = `Part ${part + 1} (Ep ${epStart}–${epEnd})`;
    let sentNote = '';

    logger.info({ chatId, subdomain, part: partLabel, episodes: chunk.length }, 'Starting part download');

    const downloaded = [];
    const downloadedByEp = new Map();
    const failedEps = [];
    let doneCount = 0; // episode sukses download di part ini
    const processEpisode = async ({ ep, urlEp }, progressLabel, attempt = 1) => {
      rp.updateLabel(partLabel, 'scrape', attempt > 1 ? `retry ${attempt}` : progressLabel);
      let result;
      if (subdomain.startsWith('reelfren_')) {
        const provider = subdomain.replace('reelfren_', '');
        result = await getVideoUrlReelFren(provider, id, urlEp, lang).catch((err) => {
          logger.error({ chatId, episode: ep, subdomain, err: { message: err.message, stack: err.stack } }, 'getVideoUrlReelFren in merge failed');
          return null;
        });
      } else {
        result = await getVideoUrl(subdomain, id, slug, urlEp, 1, lang).catch((err) => {
          logger.error({ chatId, episode: ep, subdomain, err: { message: err.message, stack: err.stack } }, 'getVideoUrl in merge failed');
          return null;
        });
      }
      if (!result?.videoUrl) {
        rp.updateLabel(partLabel, 'scrape', `${progressLabel} · URL tdk ditemukan`);
        return null;
      }

      const epFile = tempPath(`ep${ep}.mp4`);
      try {
        rp.updateLabel(partLabel, 'download', `${progressLabel} downloading...`);
        await downloadStream(result.videoUrl, epFile, (log) => {
          if (log.includes('progress:')) {
            const t = log.split('progress: ')[1];
            rp.updateLabel(partLabel, 'download', `${progressLabel} ${t}`);
          }
        }, result.subtitleUrl, { burnSubtitle });
        const sizeMb = fileSizeMb(epFile);
        doneCount += 1;
        rp.updateLabel(partLabel, 'download', `${doneCount}/${chunk.length} · ${sizeMb.toFixed(1)} MB`);
        return epFile;
      } catch (err) {
        logger.error({ chatId, episode: ep, subdomain, err: { message: err.message, stack: err.stack } }, 'Download in merge failed');
        cleanupFiles(epFile);
        rp.updateLabel(partLabel, 'fail', err.message.slice(0, 30));
        return null;
      }
    };

    // Download paralel (10 sekaligus) — urutan merge tetap dari downloadedByEp
    const DOWNLOAD_CONCURRENCY = 10;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, chunk.length) }, async () => {
      while (cursor < chunk.length) {
        const i = cursor++;
        const episode = chunk[i];
        const epFile = await processEpisode(episode, `${i + 1}/${chunk.length}`);
        if (epFile) {
          downloadedByEp.set(episode.ep, epFile);
        } else {
          failedEps.push(episode.ep);
        }
      }
    });
    await Promise.all(workers);

    if (failedEps.length) {
      const retryEps = [...failedEps];
      failedEps.length = 0;
      for (const ep of retryEps) {
        const episode = chunk.find((item) => item.ep === ep);
        const epFile = await processEpisode(episode, 'retry', 2);
        if (epFile) {
          downloadedByEp.set(ep, epFile);
        } else {
          failedEps.push(ep);
        }
      }
    }

    for (const episode of chunk) {
      const epFile = downloadedByEp.get(episode.ep);
      if (epFile) downloaded.push(epFile);
    }

    if (!downloaded.length) {
      rp.updateLabel(partLabel, 'fail', 'semua gagal');
      rp.note(`⚠️ ${partLabel}: semua gagal — Ep ${failedEps.join(', ')}. Part dilewati.`);
      continue;
    }

    if (downloaded.length < chunk.length) {
      cleanupFiles(...downloaded);
      rp.updateLabel(partLabel, 'fail', `tidak lengkap (${downloaded.length}/${chunk.length})`);
      rp.note(`⚠️ ${partLabel}: tidak lengkap — gagal: Ep ${failedEps.join(', ')}. Part dilewati.`);
      continue;
    }

    // Estimasi sebelum merge: jika total > limit Telegram, pecah 10 → 5+5 agar semua sukses
    const estimatedMb = downloaded.reduce((acc, p) => acc + fileSizeMb(p), 0);
    if (estimatedMb > MAX_UPLOAD_MB && downloaded.length > 1) {
      const subSize = 5;
      const subChunks = [];
      for (let i = 0; i < chunk.length; i += subSize) subChunks.push(chunk.slice(i, i + subSize));
      logger.info({ chatId, part: partLabel, estimatedMb: estimatedMb.toFixed(1), limit: MAX_UPLOAD_MB, subParts: subChunks.length }, 'Part melebihi limit — pecah otomatis 5+5');
      rp.note(`ℹ️ ${partLabel}: estimasi ${estimatedMb.toFixed(1)} MB > ${MAX_UPLOAD_MB} MB — pecah otomatis ${subChunks.map(c => `${c[0].ep}-${c[c.length-1].ep}`).join(' + ')}`);
      let subDone = 0;
      let subFail = 0;
      for (let sIdx = 0; sIdx < subChunks.length; sIdx++) {
        const subChunk = subChunks[sIdx];
        const subEpStart = subChunk[0].ep;
        const subEpEnd = subChunk[subChunk.length - 1].ep;
        const subLabel = `Part ${part + 1}${String.fromCharCode(97 + sIdx)} (Ep ${subEpStart}–${subEpEnd})`;
        const subDownloaded = subChunk.map(e => downloadedByEp.get(e.ep)).filter(Boolean);
        if (!subDownloaded.length) {
          rp.note(`⚠️ ${subLabel}: tidak ada file — dilewati`);
          subFail++;
          continue;
        }
        let subFinal;
        if (subDownloaded.length === 1) {
          subFinal = subDownloaded[0];
        } else {
          subFinal = tempPath(`part${part + 1}${String.fromCharCode(97 + sIdx)}.mp4`);
          rp.updateLabel(partLabel, 'merge', `${subLabel} merge ${subDownloaded.length} ep`);
          try {
            await mergeVideos(subDownloaded, subFinal, { title: subLabel });
          } catch (err) {
            logger.error({ chatId, part: subLabel, err: { message: err.message, stack: err.stack } }, 'Sub-merge failed');
            cleanupFiles(subFinal);
            rp.note(`⚠️ ${subLabel}: merge gagal — ${err.message.slice(0, 50)}`);
            subFail++;
            continue;
          }
        }
        const subSizeMb = fileSizeMb(subFinal);
        rp.updateLabel(partLabel, 'upload', `${subLabel} ${subSizeMb.toFixed(1)} MB`);
        try {
          if (subSizeMb > MAX_UPLOAD_MB) {
            logger.warn({ chatId, part: subLabel, sizeMb: subSizeMb.toFixed(1), limit: MAX_UPLOAD_MB }, 'Sub-part still exceeds limit — skip Telegram');
            rp.note(`⚠️ ${subLabel}: ${subSizeMb.toFixed(1)} MB > limit — hanya Vidara`);
            subFail++;
          } else {
            const subInfo = await getVideoInfo(subFinal).catch(() => ({}));
            const cleanProvider2 = subdomain.replace(/^reelfren_/, '');
            const subOpts = {
              caption: [
                `➧ Judul :- <b>${dramaTitle}</b>`,
                `➧ Episode/Part :- <b>${subLabel}</b>`,
                `➧ Provider :- <tg-spoiler>${cleanProvider2}</tg-spoiler>`,
              ].join('\n'),
              parse_mode: 'HTML',
              supports_streaming: true,
              ...(subInfo.duration && { duration: subInfo.duration }),
              ...(subInfo.width && { width: subInfo.width }),
              ...(subInfo.height && { height: subInfo.height }),
            };
            let subResult = null;
            const subMirror = isReelFren && isAdmin(session?.userId) && RF_GROUP_ENABLED && RF_GROUP_ID;
            if (subMirror) {
              subResult = await sendToTopicVideo(provider, subFinal, subOpts);
              if (subResult) {
                logger.info({ chatId, part: subLabel, sizeMb: subSizeMb.toFixed(1) }, 'Sub-merge part sent to topic');
              } else {
                subResult = await sendVideo(chatId, subFinal, subOpts);
                logger.info({ chatId, part: subLabel, sizeMb: subSizeMb.toFixed(1) }, 'Sub-merge part sent (fallback chat)');
              }
            } else {
              subResult = await sendVideo(chatId, subFinal, subOpts);
              logger.info({ chatId, part: subLabel, sizeMb: subSizeMb.toFixed(1) }, 'Sub-merge part sent');
            }
            if (subResult?.video?.file_id && (await getSetting('libsimpan')) === 'on') {
              const mediaSlug = `${subdomain}:${id}`;
              const totalEps2 = session?.episodes?.length || 0;
              const sourceUrl2 = `https://${subdomain}.dramafren.org/index.php?page=detail&id=${id}&lang=${session?.lang || 'id'}`;
              const posterUrl2 = session?.meta?.poster || null;
              const posterFileId2 = session?.meta?.poster_file_id || null;
              const synopsis2 = session?.meta?.synopsis || null;
              try { await upsertMedia(mediaSlug, dramaTitle, totalEps2, sourceUrl2, null, posterUrl2, posterFileId2, synopsis2); } catch {}
              const capLib = [
                `➧ Judul :- <b>${dramaTitle}</b>`,
                `➧ Episode/Part :- <b>${subLabel}</b>`,
                `➧ Provider :- <tg-spoiler>${cleanProvider2}</tg-spoiler>`,
              ].join('\n');
              await savePartFileId(mediaSlug, part + 1 + sIdx * 0.1, subResult.video.file_id, Math.round(subSizeMb * 1024 * 1024), `Part ${part + 1}${String.fromCharCode(97 + sIdx)}.mp4`, capLib);
            }
            rp.note(`✅ ${subLabel}: ${subSizeMb.toFixed(1)} MB terkirim`);
            subDone++;
          }
        } catch (err) {
          logger.error({ chatId, part: subLabel, err: err.message }, 'Sub-part send failed');
          rp.note(`❌ ${subLabel}: gagal kirim — ${err.message.slice(0, 60)}`);
          subFail++;
        } finally {
          if (subFinal && subDownloaded.length > 1) cleanupFiles(subFinal);
        }
      }
      cleanupFiles(...downloaded);
      if (subDone > 0 && subFail === 0) {
        rp.updateLabel(partLabel, 'done', '', `${subDone} sub-part ok`);
      } else if (subDone > 0) {
        rp.updateLabel(partLabel, 'done', `${subDone} ok / ${subFail} fail`);
      } else {
        rp.updateLabel(partLabel, 'fail', 'semua sub-part gagal');
      }
      if (part < totalParts - 1 && PART_SEND_DELAY_MS > 0) {
        logger.info({ chatId, part: partLabel, delayMs: PART_SEND_DELAY_MS }, 'Jeda antar part');
        await sleep(PART_SEND_DELAY_MS);
      }
      continue;
    }

    let finalFile;
    if (downloaded.length === 1) {
      finalFile = downloaded[0];
    } else {
      finalFile = tempPath(`part${part + 1}.mp4`);
      rp.updateLabel(partLabel, 'merge', `merge ${downloaded.length} ep`);
      try {
        await mergeVideos(downloaded, finalFile, { title: partLabel });
        cleanupFiles(...downloaded);
      } catch (err) {
        logger.error({ chatId, part: partLabel, err: { message: err.message, stack: err.stack } }, 'Merge failed');
        cleanupFiles(...downloaded, finalFile);
        rp.updateLabel(partLabel, 'fail', 'merge gagal');
        rp.note(`⚠️ ${partLabel}: merge gagal (${err.message.slice(0, 50)}). Part dilewati.`);
        continue;
      }
    }

    const sizeMb = fileSizeMb(finalFile);
    rp.updateLabel(partLabel, 'upload', `${sizeMb.toFixed(1)} MB`);

    try {
      if (sizeMb > MAX_UPLOAD_MB) {
        logger.warn({ chatId, part: partLabel, sizeMb: sizeMb.toFixed(1), limit: MAX_UPLOAD_MB }, 'Part skipped — exceeds limit');
        rp.updateLabel(partLabel, 'fail', `${sizeMb.toFixed(1)} MB > limit`);
      } else {
        const info = await getVideoInfo(finalFile).catch(() => ({}));
        const cleanProvider = subdomain.replace(/^reelfren_/, '');
        const opts = {
          caption: [
            `➧ Judul :- <b>${dramaTitle}</b>`,
            `➧ Episode/Part :- <b>${partLabel}</b>`,
            `➧ Provider :- <tg-spoiler>${cleanProvider}</tg-spoiler>`,
          ].join('\n'),
          parse_mode: 'HTML',
          supports_streaming: true,
          ...(info.duration && { duration: info.duration }),
          ...(info.width && { width: info.width }),
          ...(info.height && { height: info.height }),
        };
        let sendResult = null;
        const mirrorToTopic = isReelFren && isAdmin(session?.userId) && RF_GROUP_ENABLED && RF_GROUP_ID;
        if (mirrorToTopic) {
          sendResult = await sendToTopicVideo(provider, finalFile, opts);
          if (sendResult) {
            logger.info({ chatId, part: partLabel, sizeMb: sizeMb.toFixed(1) }, 'Merge part sent to topic');
            sentNote = `📤 ${partLabel} — terkirim ke topic <b>${provider}</b> di grup`;
          } else {
            sendResult = await sendVideo(chatId, finalFile, opts);
            logger.info({ chatId, part: partLabel, sizeMb: sizeMb.toFixed(1) }, 'Merge part sent (fallback chat)');
          }
        } else {
          sendResult = await sendVideo(chatId, finalFile, opts);
          logger.info({ chatId, part: partLabel, sizeMb: sizeMb.toFixed(1) }, 'Merge part sent');
        }
        // Simpan file_id ke library jika libsimpan ON — upsert media dulu cegah FK violation
        if (sendResult?.video?.file_id && (await getSetting('libsimpan')) === 'on') {
          const mediaSlug = `${subdomain}:${id}`;
          const totalEps2 = session?.episodes?.length || 0;
          const sourceUrl2 = `https://${subdomain}.dramafren.org/index.php?page=detail&id=${id}&lang=${session?.lang || 'id'}`;
          const posterUrl2 = session?.meta?.poster || null;
          const posterFileId2 = session?.meta?.poster_file_id || null;
          const synopsis2 = session?.meta?.synopsis || null;
          try { await upsertMedia(mediaSlug, dramaTitle, totalEps2, sourceUrl2, null, posterUrl2, posterFileId2, synopsis2); } catch {}
          const capLib = [
            `➧ Judul :- <b>${dramaTitle}</b>`,
            `➧ Episode/Part :- <b>${partLabel}</b>`,
            `➧ Provider :- <tg-spoiler>${cleanProvider}</tg-spoiler>`,
          ].join('\n');
          await savePartFileId(mediaSlug, part + 1, sendResult.video.file_id, Math.round(sizeMb * 1024 * 1024), `Part ${part + 1}.mp4`, capLib);
        }
        rp.updateLabel(partLabel, 'done', '', `${sizeMb.toFixed(1)} MB`);
        rp.note(sentNote);
      }
    } catch (err) {
      logger.error({ chatId, part: partLabel, err: err.message }, 'Part send failed');
      rp.updateLabel(partLabel, 'fail', `kirim gagal: ${err.message.slice(0, 40)}`);
      rp.note(`❌ ${partLabel}: gagal kirim — ${err.message.slice(0, 100)}`);
    } finally {
      cleanupFiles(finalFile);
    }

    if (part < totalParts - 1 && PART_SEND_DELAY_MS > 0) {
      logger.info({ chatId, part: partLabel, delayMs: PART_SEND_DELAY_MS }, 'Jeda antar part');
      await sleep(PART_SEND_DELAY_MS);
    }
  }

  await rp.done();
  await destroySession();
}

// ─── Aksi: upload ke Vidara ──────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }

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
  const V = require('./vidara-uploader');
  const { ensureMp4 } = require('./services/vidaraService');
  if (!V.VIDARA_KEY) return bot.sendMessage(chatId, '⚠️ <code>VIDARA_API</code> belum diset.', { parse_mode: 'HTML' });

  const { subdomain, id, episodes, meta } = session;
  const providerLabel = subdomain.replace(/^reelfren_/, '');
  const dramaKey = `${providerLabel}:${id}`;
  const title = meta?.title || id;
  const resolveVideoUrl = buildResolveVideoUrl(session);
  const workDir = path.join(V.DOWNLOADS, 'tmp', `vidper_${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  vidaraBusy.set(String(chatId), true);
  const p = await new Progress(chatId, `Upload Vidara — ${episodes.length} episode`).start();
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
        await ensureMp4(url, dest);
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
    await bot.sendMessage(chatId, `📤 <b>${title}</b>\n✅ ${done} ok · ❌ ${fail} gagal\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  } catch (err) {
    await p.fail(`Error: ${err.message.slice(0, 100)}`);
  } finally {
    vidaraBusy.delete(String(chatId));
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

async function actionVidaraMerge10(chatId, session) {
  const V = require('./vidara-uploader');
  const { ensureMp4, uploadDramaBatchesVidara } = require('./services/vidaraService');
  if (!V.VIDARA_KEY) return bot.sendMessage(chatId, '⚠️ <code>VIDARA_API</code> belum diset.', { parse_mode: 'HTML' });

  const { subdomain, id, episodes, meta } = session;
  const providerLabel = subdomain.replace(/^reelfren_/, '');
  const dramaKey = `${providerLabel}:${id}`;
  const title = meta?.title || id;
  const resolveVideoUrl = buildResolveVideoUrl(session);

  vidaraBusy.set(String(chatId), true);
  const p = await new Progress(chatId, `Upload Vidara — batch 10`).start();
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
    await bot.sendMessage(chatId, `📤 <b>${title}</b>\n✅ ${result.done} batch · ❌ ${result.fail} gagal\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  } catch (err) {
    await p.fail(`Error: ${err.message.slice(0, 100)}`);
  } finally {
    vidaraBusy.delete(String(chatId));
  }
}

// ─── Aksi: Vidara + Telegram (download sekali, upload keduanya, baru cleanup) ──

async function actionVidaraAndTelegramMerge10(chatId, session) {
  const V = require('./vidara-uploader');
  const { ensureMp4, ffmpegConcat, uploadDramaBatchesVidara } = require('./services/vidaraService');
  if (!V.VIDARA_KEY) return bot.sendMessage(chatId, '⚠️ <code>VIDARA_API</code> belum diset.', { parse_mode: 'HTML' });

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

  vidaraBusy.set(String(chatId), true);
  const rp = await new RichProgress(chatId, title, chunks.map((chunk, i) => ({
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
          await ensureMp4(url, dest);
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
        const mirrorToTopic = isReelFren && isAdmin(session?.userId) && RF_GROUP_ENABLED && RF_GROUP_ID;
        if (sizeMb > MAX_UPLOAD_MB) {
          rp.note(`⚠️ ${partLabel}: ${sizeMb.toFixed(1)} MB > limit Telegram (${MAX_UPLOAD_MB}) — hanya upload ke Vidara`);
          logger.warn({ chatId, part: partLabel, sizeMb: sizeMb.toFixed(1), limit: MAX_UPLOAD_MB }, 'vt_merge10 part skipped Telegram — exceeds limit');
          tgFail++;
        } else {
          try {
            if (mirrorToTopic) {
              const sendResult = await sendToTopicVideo(provider, mergedFile, options);
              if (sendResult) {
                tgDone++;
                rp.note(`📤 ${partLabel} — terkirim ke topic <b>${provider}</b> di grup`);
              } else {
                await sendVideo(chatId, mergedFile, options);
                tgDone++;
              }
            } else {
              await sendVideo(chatId, mergedFile, options);
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

      if (ci < chunks.length - 1 && PART_SEND_DELAY_MS > 0) await sleep(PART_SEND_DELAY_MS);
    }

    await rp.done();

    // Summary
    const vdom = V.VIDARA_DOMAIN || 'vidara.so';
    const vidLines = Object.entries(vidFiles).map(([label, fc]) => `Ep ${label}: <code>https://${vdom}/e/${fc}</code>`);
    await bot.sendMessage(chatId, `📤 <b>${title}</b> — Vidara + Telegram selesai\n✅ Vidara: ${vidDone} batch · ❌ ${vidFail}\n✅ Telegram: ${tgDone} batch · ❌ ${tgFail}\n\n${vidLines.join('\n')}`, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error({ chatId, err: err.message }, 'vt_merge10 outer error');
    await rp.fail(err.message.slice(0, 100));
  } finally {
    vidaraBusy.delete(String(chatId));
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    await destroySession();
  }
}

async function actionVidaraAndTelegramPerEp(chatId, session) {
  const V = require('./vidara-uploader');
  const { ensureMp4 } = require('./services/vidaraService');
  if (!V.VIDARA_KEY) return bot.sendMessage(chatId, '⚠️ <code>VIDARA_API</code> belum diset.', { parse_mode: 'HTML' });

  const { subdomain, id, slug, lang, episodes, meta } = session;
  const providerLabel = subdomain.replace(/^reelfren_/, '');
  const dramaKey = `${providerLabel}:${id}`;
  const title = meta?.title || id;
  const resolveVideoUrl = buildResolveVideoUrl(session);
  const workDir = path.join(V.DOWNLOADS, 'tmp', `vtper_${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  vidaraBusy.set(String(chatId), true);
  const p = await new Progress(chatId, `Vidara + Telegram — ${episodes.length} episode`).start();
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
        await ensureMp4(url, dest);

        // Upload to Vidara
        p.update(`[${i + 1}/${episodes.length}] Ep ${epStr} — upload Vidara`);
        const fc = await V.uploadFileViaCurl(dest);

        // Send to Telegram (same file)
        p.update(`[${i + 1}/${episodes.length}] Ep ${epStr} — kirim Telegram`);
        await downloadAndSend(chatId, subdomain, id, slug, epObj.urlEp, lang, `Ep ${epObj.ep}`);
      } catch (e) {
        logger.error({ chatId, ep: epStr, err: e.message }, 'Vidara+TG per-ep fail');
      }
    }
    await p.done(`${episodes.length} episode selesai (Vidara + Telegram)`);
  } catch (err) {
    await p.fail(`Error: ${err.message.slice(0, 100)}`);
  } finally {
    vidaraBusy.delete(String(chatId));
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

// ─── Handler: pesan teks ────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  logger.info({ chatId: msg.chat.id, text: msg.text || msg.caption || '', from: msg.from?.username || msg.from?.id, hasMedia: !!(msg.photo || msg.video || msg.document) }, 'Message received');
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || '';

  // Skip echo pesan bot sendiri (mis. poster yang dikirim ke topic grup)
  if (msg.from?.is_bot) return;

  if (msg.successful_payment) {
    const session = sessions.get(String(chatId));

    // ─── VIP membership via Stars (payload: vip:<days>:<userId>) ─────────────
    const vipPayload = (msg.successful_payment.invoice_payload || '').match(/^vip:(\d+):(\d+)$/);
    if (vipPayload) {
      const days = Number(vipPayload[1]);
      const stars = msg.successful_payment.total_amount;
      const username = msg.from?.username || msg.from?.first_name || null;
      const vipService = require('./services/vipService');
      try {
        await vipService.addVipUser(msg.from.id, days, { username, paymentMethod: 'stars', amount: stars });
        await vipService.recordPayment({
          orderId: `stars_${msg.successful_payment.telegram_payment_charge_id}`,
          userId: msg.from.id, username, amount: stars, method: 'stars', vipDays: days,
          message: `VIP ${days}h via Stars`,
        });
        await bot.sendMessage(chatId, `✅ Pembayaran ${stars}⭐ berhasil!\n💎 <b>VIP ${days} hari langsung aktif!</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '💎 Cek Status VIP', callback_data: 'act:vip' }]] } });
        if (ADMIN_IDS.length) {
          bot.sendMessage(ADMIN_IDS[0], `💳 <b>PEMBAYARAN STARS VIP BERHASIL</b>\n\n👤 User: @${username || msg.from.id} (<code>${msg.from.id}</code>)\n📦 Paket: <b>${days} hari VIP</b>\n⭐ Dibayar: ${stars}`, { parse_mode: 'HTML' }).catch(() => {});
        }
      } catch (vipErr) {
        logger.error({ err: vipErr.message, userId: msg.from.id }, 'VIP activate via Stars failed');
        await bot.sendMessage(chatId, `⚠️ Pembayaran ${stars}⭐ diterima tapi VIP gagal aktif. Hubungi admin ya.`);
        if (ADMIN_IDS.length) {
          bot.sendMessage(ADMIN_IDS[0], `🚨 <b>VIP ACTIVATION FAILED (STARS)</b>\n\n👤 User: <code>${msg.from.id}</code>\n📦 Paket: ${days} hari\n⭐ Dibayar: ${stars}\n❌ ${vipErr.message}\n⚡ <b>Aktifkan manual:</b> <code>/addvip ${msg.from.id} ${days}</code>`, { parse_mode: 'HTML' }).catch(() => {});
        }
      }
      return;
    }

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

  // ─── Handle video/document for pending replace ──────────────────────────────
  if (pendingReplaces.has(String(chatId)) && (msg.video || msg.document || msg.audio || msg.photo)) {
    const pending = pendingReplaces.get(String(chatId));
    pendingReplaces.delete(String(chatId));
    const file = msg.video || msg.document || msg.audio || (msg.photo && msg.photo[msg.photo.length - 1]);
    if (!file || !file.file_id) return bot.sendMessage(chatId, '❌ File tidak valid.');
    const sizeMb = ((file.file_size || 0) / 1024 / 1024).toFixed(1);
    const fileName = file.file_name || file.file_id.slice(0, 20);
    const existing = await getPartFileId(pending.slug, pending.part);
    if (existing) {
      await pool.query(
        'UPDATE media_parts SET file_id = $1, file_size = $2, file_name = $3 WHERE media_slug = $4 AND part = $5',
        [file.file_id, file.file_size || 0, fileName, pending.slug, pending.part]
      );
    } else {
      try { await upsertMedia(pending.slug, pending.name, 0, null); } catch {}
      await savePartFileId(pending.slug, pending.part, file.file_id, file.file_size || 0, fileName);
    }
    const isAnime = pending.slug.startsWith('anime:');
    const unit = isAnime ? 'Episode' : 'Part';
    return bot.sendMessage(
      chatId,
      `✅ <b>${unit} ${pending.part}</b> — <b>${pending.name}</b> berhasil di-replace!\n📁 File: ${fileName} (${sizeMb} MB)`,
      { parse_mode: 'HTML' }
    );
  }

  // ─── Handle video/document for pending add ──────────────────────────────────
  if (pendingAdds.has(String(chatId)) && (msg.video || msg.document || msg.audio || msg.photo)) {
    const pending = pendingAdds.get(String(chatId));
    pendingAdds.delete(String(chatId));
    const file = msg.video || msg.document || msg.audio || (msg.photo && msg.photo[msg.photo.length - 1]);
    if (!file || !file.file_id) return bot.sendMessage(chatId, '❌ File tidak valid.');
    const sizeMb = ((file.file_size || 0) / 1024 / 1024).toFixed(1);
    const fileName = file.file_name || file.file_id.slice(0, 20);
    const existing = await getPartFileId(pending.slug, pending.nextPart);
    if (existing) {
      return bot.sendMessage(chatId, `❌ ${pending.nextPart} sudah ada. Gunakan 🔄 Replace untuk overwrite.`);
    }
    await upsertMedia(pending.slug, pending.name, 0, null);
    await savePartFileId(pending.slug, pending.nextPart, file.file_id, file.file_size || 0, fileName);
    const isAnime = pending.slug.startsWith('anime:');
    const unit = isAnime ? 'Episode' : 'Part';
    return bot.sendMessage(
      chatId,
      `✅ <b>${unit} ${pending.nextPart}</b> — <b>${pending.name}</b> berhasil ditambahkan!\n📁 File: ${fileName} (${sizeMb} MB)`,
      { parse_mode: 'HTML' }
    );
  }

  if (text === '/exit' || text === '/cancel' || text === '/batal') {
    let handled = false;
    if (aiChatSessions.has(chatId)) {
      aiChatSessions.delete(chatId);
      handled = true;
    }
    if (pendingAiEndpoint.has(String(chatId))) {
      pendingAiEndpoint.delete(String(chatId));
      return bot.sendMessage(chatId, '❌ Setup AI endpoint dibatalkan.');
    }
    if (pendingAiKey.has(String(chatId))) {
      pendingAiKey.delete(String(chatId));
      return bot.sendMessage(chatId, '❌ Setup AI key dibatalkan.');
    }
    if (pendingAiModel.has(String(chatId))) {
      pendingAiModel.delete(String(chatId));
      return bot.sendMessage(chatId, '❌ Setup AI model dibatalkan.');
    }
    if (handled) {
      return bot.sendMessage(chatId, 'Live Chat ditutup.', { reply_markup: { remove_keyboard: true } });
    }
  }

  // ─── Pending AI endpoint input (admin manual URL) ──────────────────────────
  if (pendingAiEndpoint.has(String(chatId))) {
    if (!isAdmin(msg.from.id)) {
      pendingAiEndpoint.delete(String(chatId));
      return bot.sendMessage(chatId, '⚠️ Hanya admin yang bisa set AI endpoint.');
    }
    const input = text.trim();
    if (['hapus', 'reset', 'off', 'clear'].includes(input.toLowerCase())) {
      pendingAiEndpoint.delete(String(chatId));
      await setSetting('ai_endpoint', '');
      return bot.sendMessage(chatId, '✅ AI endpoint dihapus. Live Chat nonaktif sampai diset ulang.', { parse_mode: 'HTML' });
    }
    const urlCandidate = input.split(/\s+/)[0];
    try {
      const u = new URL(urlCandidate);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('invalid protocol');
    } catch {
      return bot.sendMessage(chatId, '❌ URL tidak valid. Contoh:\n<code>https://tokenharbor.ai/v1</code> atau <code>https://api.example.com/v1/chat/completions</code>', { parse_mode: 'HTML' });
    }
    await setSetting('ai_endpoint', urlCandidate);
    pendingAiEndpoint.delete(String(chatId));
    return bot.sendMessage(chatId, `✅ AI endpoint disimpan:\n<code>${urlCandidate}</code>\n\nLanjut set 🔑 API Key dan 🧠 Model di 🛠 Admin Panel jika belum.`, { parse_mode: 'HTML' });
  }

  if (pendingAiKey.has(String(chatId))) {
    if (!isAdmin(msg.from.id)) {
      pendingAiKey.delete(String(chatId));
      return bot.sendMessage(chatId, '⚠️ Hanya admin yang bisa set API key.');
    }
    const input = text.trim();
    if (['hapus', 'reset', 'off', 'clear'].includes(input.toLowerCase())) {
      pendingAiKey.delete(String(chatId));
      await setSetting('ai_api_key', '');
      return bot.sendMessage(chatId, '✅ API key dihapus.', { parse_mode: 'HTML' });
    }
    await setSetting('ai_api_key', input);
    pendingAiKey.delete(String(chatId));
    try { await bot.deleteMessage(chatId, msg.message_id).catch(() => {}); } catch {}
    return bot.sendMessage(chatId, '✅ API key disimpan. (pesan key dihapus)', { parse_mode: 'HTML' });
  }

  if (pendingAiModel.has(String(chatId))) {
    if (!isAdmin(msg.from.id)) {
      pendingAiModel.delete(String(chatId));
      return bot.sendMessage(chatId, '⚠️ Hanya admin yang bisa set model.');
    }
    const input = text.trim();
    if (['hapus', 'reset', 'off', 'clear'].includes(input.toLowerCase())) {
      pendingAiModel.delete(String(chatId));
      await setSetting('ai_model', '');
      return bot.sendMessage(chatId, '✅ Model dihapus.', { parse_mode: 'HTML' });
    }
    await setSetting('ai_model', input);
    pendingAiModel.delete(String(chatId));
    return bot.sendMessage(chatId, `✅ Model disimpan: <code>${input}</code>`, { parse_mode: 'HTML' });
  }

  if (pendingVidaraDomain.has(String(chatId))) {
    if (!isAdmin(msg.from.id)) {
      pendingVidaraDomain.delete(String(chatId));
      return bot.sendMessage(chatId, '⚠️ Hanya admin yang bisa set domain Vidara.');
    }
    const input = text.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (['hapus', 'reset', 'off', 'clear'].includes(input.toLowerCase())) {
      pendingVidaraDomain.delete(String(chatId));
      await setVidaraActiveDomain('');
      return bot.sendMessage(chatId, '✅ Domain Vidara di-reset ke default (<code>vidara.so</code>).', { parse_mode: 'HTML' });
    }
    if (!input || !input.includes('.')) {
      return bot.sendMessage(chatId, '❌ Domain tidak valid. Contoh: <code>vidara.to</code>', { parse_mode: 'HTML' });
    }
    await setVidaraActiveDomain(input);
    pendingVidaraDomain.delete(String(chatId));
    return bot.sendMessage(chatId, `✅ Domain Vidara disimpan: <code>${input}</code>\n🔗 Embed link: <code>https://${input}/e/&lt;filecode&gt;</code>`, { parse_mode: 'HTML' });
  }

  // ─── Live Chat: biar menu reply keyboard bisa akhiri sesi otomatis ───────
  if (aiChatSessions.has(chatId) && ['📚 Katalog', '🔍 Cari', '👤 Akun', '🛠 Admin Panel', '⬅️ Keluar', '❌ Keluar', '⬅️ Kembali ke menu utama'].includes(text)) {
    aiChatSessions.delete(chatId);
    // jangan return — biarkan handler menu di bawah proses text yang sama
    // (tanpa ini Live Chat nyangkut dan menu tidak merespon)
  }

  // ─── Live Chat album (4-5 gambar sekaligus) — buffer 1.5 detik ───────────
  if (msg.media_group_id && aiChatSessions.has(chatId) && (msg.photo || msg.document || msg.video)) {
    const groupId = msg.media_group_id;
    let entry = pendingMediaAlbums.get(groupId);
    if (!entry) {
      entry = { chatId, caption: text.trim(), fileIds: [], timer: null, fromId: msg.from.id };
      pendingMediaAlbums.set(groupId, entry);
    }
    const file = msg.photo ? msg.photo[msg.photo.length - 1] : msg.document || msg.video;
    if (file && file.file_id) entry.fileIds.push(file.file_id);
    if (text.trim() && !entry.caption) entry.caption = text.trim();
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(async () => {
      pendingMediaAlbums.delete(groupId);
      const caption = entry.caption || '';
      const fileIds = entry.fileIds.slice(0, 5);
      const images = [];
      for (const fid of fileIds) {
        const b64 = await getImageBase64(fid);
        if (b64) images.push(b64);
      }
      if (!caption && !images.length) return;
      try {
        const isAdminUser2 = isAdmin(entry.fromId);
        if (!isAdminUser2 && !aiChatRateCheck(entry.chatId)) {
          await bot.sendMessage(entry.chatId, `⏳ <b>Tenang, santai dulu~</b>\n\nKamu udah kirim ${AI_CHAT_RATE_LIMIT} pesan dalam 1 menit.`, { parse_mode: 'HTML' });
          return;
        }
        const aiEndpoint2 = await getSetting('ai_endpoint');
        const aiModel2 = await getSetting('ai_model');
        const aiApiKey2 = await getSetting('ai_api_key');
        if (!aiEndpoint2) {
          await bot.sendMessage(entry.chatId, '⚙️ AI endpoint belum diset.', { parse_mode: 'HTML' });
          return;
        }
        const { askStream: askStream2 } = require('./ai');
        const draftId2 = Date.now();
        let fullText2 = '';
        let updateTimer2 = null;
        let draftFailed2 = false;
        try { await sendDraft(entry.chatId, draftId2, '<tg-thinking>Admin sedang mengetik</tg-thinking>', { format: 'html' }); } catch { draftFailed2 = true; }
        await askStream2(caption, (token) => {
          fullText2 += token;
          if (draftFailed2) return;
          clearTimeout(updateTimer2);
          updateTimer2 = setTimeout(async () => {
            try { await sendDraft(entry.chatId, draftId2, markdownToHtml(fullText2), { format: 'html' }); } catch { draftFailed2 = true; }
          }, 800);
        }, { timeout: 120000, endpoint: aiEndpoint2, model: aiModel2, apiKey: aiApiKey2, images });
        clearTimeout(updateTimer2);
        const html = markdownToHtml(fullText2);
        if (!draftFailed2) { await sendDraft(entry.chatId, draftId2, html, { format: 'html' }).catch(() => {}); await finalizeDraft(entry.chatId, html, { format: 'html' }); }
        else { await bot.sendMessage(entry.chatId, html, { parse_mode: 'HTML' }); }
      } catch (err) {
        logger.error({ chatId: entry.chatId, err: err.message }, 'AI album failed');
        await bot.sendMessage(entry.chatId, `❌ Error: ${err.message.slice(0, 200)}`).catch(() => {});
      }
    }, 1500);
    return;
  }

  if (aiChatSessions.has(chatId) && !text.startsWith('/')) {
    const isAdminUser = isAdmin(msg.from.id);
    if (!isAdminUser && !aiChatRateCheck(chatId)) {
      return bot.sendMessage(chatId, `⏳ <b>Tenang, santai dulu~</b>\n\nKamu udah kirim ${AI_CHAT_RATE_LIMIT} pesan dalam 1 menit. Tunggu sebentar ya, AI butuh napas 😄`, { parse_mode: 'HTML' });
    }
    // Custom endpoint check — Live Chat pakai endpoint manual, bukan opencode default
    const aiEndpoint = await getSetting('ai_endpoint');
    const aiModel = await getSetting('ai_model');
    const aiApiKey = await getSetting('ai_api_key');
    if (!aiEndpoint) {
      if (isAdminUser) {
        return bot.sendMessage(chatId, '⚙️ AI endpoint belum diset.\n\nBuka 🛠 Admin Panel → 🤖 AI Endpoint atau kirim <code>/setai https://api.example.com/v1/chat/completions [model]</code>', { parse_mode: 'HTML' });
      }
      return bot.sendMessage(chatId, '💬 Live Chat belum tersedia. Hubungi admin.', { parse_mode: 'HTML' });
    }
    // Kumpulkan gambar single (bukan album — album sudah di-handle di atas)
    let singleImages = [];
    if ((msg.photo || (msg.document && msg.document.mime_type?.startsWith('image/'))) && !msg.media_group_id) {
      const file = msg.photo ? msg.photo[msg.photo.length - 1] : msg.document;
      if (file && file.file_id) {
        const b64 = await getImageBase64(file.file_id);
        if (b64) singleImages.push(b64);
      }
    }
    if (!text.trim() && !singleImages.length) {
      if (msg.media_group_id) return;
      if (msg.photo || msg.video || msg.document || msg.audio) {
        return bot.sendMessage(chatId, '📷 Kirim caption bersama foto untuk diproses.', { parse_mode: 'HTML' });
      }
      return;
    }
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
      }, { timeout: 120000, endpoint: aiEndpoint, model: aiModel, apiKey: aiApiKey, images: singleImages });

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

  // ─── Pending download: custom title input ─────────────────────────────────────

  const pendingKey = String(chatId);
  if (pendingDownloads.has(pendingKey) && text && !text.startsWith('/')) {
    const pending = pendingDownloads.get(pendingKey);
    pendingDownloads.delete(pendingKey);
    const customTitle = text.trim();
    await bot.sendMessage(chatId, `📥 Download dengan judul: <b>${customTitle}</b>`, { parse_mode: 'HTML' });
    if (pending.handler === 'gofile') return handleGofileUrl(chatId, pending.url, customTitle);
    if (pending.handler === 'pixeldrain') return handlePixeldrainUrl(chatId, pending.url, customTitle);
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

  // ─── AI custom endpoint (admin manual URL) ───────────────────────────────
  if (text.startsWith('/setai')) {
    if (!isAdmin(msg.from.id)) return bot.sendMessage(chatId, '⚠️ Hanya admin.');
    // /setai <url> [model]  atau  /setai hapus  /  /setai (info)
    // Hindari tabrakan dengan /setaikey /setaimodel
    if (text.startsWith('/setaikey') || text.startsWith('/setaimodel')) {
      // lanjut ke handler di bawah
    } else {
      const args = text.split(/\s+/).slice(1);
      if (!args.length) {
        const curEp = await getSetting('ai_endpoint');
        const curModel = await getSetting('ai_model');
        const curKey = await getSetting('ai_api_key');
        return bot.sendMessage(chatId,
          `🤖 <b>AI Custom Endpoint</b>\nEndpoint: ${curEp ? `<code>${curEp}</code>` : '<i>belum diset</i>'}\nModel: ${curModel ? `<code>${curModel}</code>` : '<i>belum diset</i>'}\nAPI key: ${curKey ? '✅ set' : '❌ belum'}\n\nPakai:\n<code>/setai https://api.example.com/v1/chat/completions [model]</code>\n<code>/setai hapus</code> — reset\n<code>/setaikey &lt;key&gt;</code>\n<code>/setaimodel &lt;model&gt;</code>`,
          { parse_mode: 'HTML' });
      }
      if (['hapus', 'reset', 'off', 'clear'].includes(args[0].toLowerCase())) {
        await setSetting('ai_endpoint', '');
        await setSetting('ai_model', '');
        return bot.sendMessage(chatId, '✅ AI endpoint & model dihapus. Live Chat nonaktif.');
      }
      const url = args[0];
      try { const u = new URL(url); if (!['http:', 'https:'].includes(u.protocol)) throw new Error(); } catch {
        return bot.sendMessage(chatId, '❌ URL tidak valid. Contoh: https://api.example.com/v1/chat/completions');
      }
      await setSetting('ai_endpoint', url);
      if (args[1]) await setSetting('ai_model', args[1]);
      return bot.sendMessage(chatId, `✅ AI endpoint: <code>${url}</code>${args[1] ? `\nModel: <code>${args[1]}</code>` : ''}`, { parse_mode: 'HTML' });
    }
  }
  if (text.startsWith('/setaikey')) {
    if (!isAdmin(msg.from.id)) return bot.sendMessage(chatId, '⚠️ Hanya admin.');
    const key = text.split(/\s+/).slice(1).join(' ').trim();
    if (!key) {
      const cur = await getSetting('ai_api_key');
      return bot.sendMessage(chatId, `🔑 API key: ${cur ? '✅ set' : '❌ belum'}\nPakai: <code>/setaikey &lt;key&gt;</code>  atau  <code>/setaikey hapus</code>`, { parse_mode: 'HTML' });
    }
    if (['hapus', 'reset', 'off', 'clear'].includes(key.toLowerCase())) {
      await setSetting('ai_api_key', '');
      return bot.sendMessage(chatId, '✅ API key dihapus.');
    }
    await setSetting('ai_api_key', key);
    try { await bot.deleteMessage(chatId, msg.message_id).catch(() => {}); } catch {}
    return bot.sendMessage(chatId, '✅ API key disimpan.');
  }
  if (text.startsWith('/setaimodel')) {
    if (!isAdmin(msg.from.id)) return bot.sendMessage(chatId, '⚠️ Hanya admin.');
    const model = text.split(/\s+/).slice(1).join(' ').trim();
    if (!model) {
      const cur = await getSetting('ai_model');
      return bot.sendMessage(chatId, `🤖 Model: ${cur ? `<code>${cur}</code>` : '<i>belum diset</i>'}\nPakai: <code>/setaimodel &lt;model&gt;</code>`, { parse_mode: 'HTML' });
    }
    if (['hapus', 'reset', 'off', 'clear'].includes(model.toLowerCase())) {
      await setSetting('ai_model', '');
      return bot.sendMessage(chatId, '✅ Model dihapus.');
    }
    await setSetting('ai_model', model);
    return bot.sendMessage(chatId, `✅ Model: <code>${model}</code>`, { parse_mode: 'HTML' });
  }

  if (text === '/start' || text === '/menu' || text === '/help') {
    // Deep link: /start lib_{slug}_{part}
    const libMatch = text.match(/^\/start lib_([a-z0-9]+)_(\d+)$/i);
    if (libMatch) {
      if (!isAdmin(msg.from.id)) {
        try {
          const vipService = require('./services/vipService');
          const isVip = await vipService.isVipUser(msg.from.id);
          if (!isVip) {
            const rateLimiter = require('./utils/rateLimiter');
            if (rateLimiter.isLimited(msg.from.id, 'lib_view')) {
              return bot.sendMessage(chatId, '⏳ Rate limit 1/menit — VIP unlimited. Cek 👤 Akun → 💎 VIP', { reply_markup: mainMenuKeyboard(false) });
            }
          }
        } catch {}
      }
      const [, slug, part] = libMatch;
      const file = await getPartFileId(slug, Number(part));
      if (!file) return bot.sendMessage(chatId, '⚠️ Part tidak ditemukan di library.');
      const media = await getMediaBySlug(slug);
      const dramaName = media?.nama || slug.replace(/^[^:]+:/, '');
      const isAnime = slug.startsWith('anime:');
      const unit = isAnime ? 'Episode' : 'Part';
      const caption = [
        `➧ Judul :- <b>${dramaName}</b>`,
        `➧ ${unit} :- <b>${unit} ${part}</b>`,
        `➧ Provider :- <tg-spoiler>${extractProvider(file.file_name || '')}</tg-spoiler>`,
      ].join('\n');
      return bot.sendVideo(chatId, file.file_id, { caption, parse_mode: 'HTML' });
    }

    const isAdminUser = isAdmin(msg.from.id);
    let welcome;
    if (isAdminUser) {
      welcome = [
        '👋 <b>Halo Admin!</b>',
        '',
        'Panel admin aktif. Gunakan 🛠 Admin untuk:',
        '• 💾 Simpan ke Library',
        '• 📚 Cari Drama/Anime',
        '• 📊 Status Server',
        '• ⭐ Saldo Stars',
      ].join('\n');
    } else {
      welcome = [
        '👋 <b>Halo!</b>',
        '',
        'Selamat datang di <b>Drama Bot</b> 🎬',
        '',
        'Nonton drama & anime favorit langsung di Telegram.',
        'Rate limit: 1 video/menit (free).',
        'Ingin unlimited? Aktifkan <b>💎 VIP</b> di 👤 Akun.',
      ].join('\n');
    }
    // Kirim welcome + inline menu
    return bot.sendMessage(chatId, welcome, { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(isAdminUser) })
      .catch(err => logger.error({ chatId, err: err.message }, 'send welcome failed'));
  }

  // ─── Reply Keyboard handler (interrelated dengan inline) ─────────────────────
  if (['📚 Katalog', '🔍 Cari', '💬 Live Chat', '👤 Akun', '🛠 Admin Panel'].includes(text)) {
    const isAdminUser = isAdmin(msg.from.id);
    if (text === '📚 Katalog') {
      const all = await listAllLibrary();
      if (!all.length) return bot.sendMessage(chatId, '📭 Library kosong.', { reply_markup: breadcrumbKeyboard(isAdminUser) });
      const { header, rows } = await buildLibraryKeyboard('all', 1, all);
      rows.push([{ text: '🔍 Cari', callback_data: 'act:lib_search' }, { text: '🏠 Menu', callback_data: 'act:main_menu' }]);
      return bot.sendMessage(chatId, header, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
    }
    if (text === '🔍 Cari') {
      return bot.sendMessage(chatId, '🔍 <b>Cari Drama/Anime</b>\n\nKetik: <code>/cari nama</code>', { parse_mode: 'HTML', reply_markup: breadcrumbKeyboard(isAdminUser) });
    }
    if (text === '💬 Live Chat') {
      aiChatSessions.set(chatId, true);
      return bot.sendMessage(chatId, '💬 <b>Live Chat Aktif</b>\n\nKetik pesan Anda. Admin akan membalas.\n\n<i>Tap menu lain atau ⬅️ Keluar untuk akhiri.</i>', { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '⬅️ Keluar', callback_data: 'act:ai_exit' }]] } });
    }
    if (text === '👤 Akun') {
      const stars = await bot.getMyStarBalance?.().catch(() => null);
      const balanceText = stars ? `⭐ Stars: ${stars}⭐` : '⭐ Stars: -';
      let vipText = '👤 Free';
      let remain = 3;
      try {
        const vipService = require('./services/vipService');
        const isVip = isAdminUser || await vipService.isVipUser(msg.from.id);
        vipText = isVip ? '💎 VIP Aktif — unlimited' : '👤 Free — 3/menit';
        const rateLimiter = require('./utils/rateLimiter');
        remain = rateLimiter.getRemaining(msg.from.id, 'lib_view');
      } catch {}
      const accText = `👤 <b>Akun</b>\n\n${balanceText}\n${vipText}\n⏳ Sisa kuota: ${remain}/1 per menit\n\nPilih:`;
      return bot.sendMessage(chatId, accText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '💎 VIP / Payment', callback_data: 'act:vip' }, { text: '📊 Status', callback_data: 'act:status' }], [{ text: '🏠 Menu Utama', callback_data: 'act:main_menu' }]] } });
    }
    if (text === '🛠 Admin Panel') {
      if (!isAdminUser) return bot.sendMessage(chatId, '⚠️ Hanya admin.');
      const libsimpan = (await getSetting('libsimpan')) === 'on';
      const aiEpA = await getSetting('ai_endpoint');
      const aiModelA = await getSetting('ai_model');
      const aiKeyA = await getSetting('ai_api_key');
      return bot.sendMessage(chatId, '🛠 <b>Admin Panel</b>', { parse_mode: 'HTML', reply_markup: adminPanelKeyboard(libsimpan, aiEpA, aiModelA, aiKeyA) });
    }
  }

  // ─── Library commands ─────────────────────────────────────────────────────────

  const cariMatch = text.match(/^\/cari\s+(.+)/i);
  if (cariMatch) {
    const query = cariMatch[1].trim();
    if (query.length < 2) return bot.sendMessage(chatId, '⚠️ Minimal 2 karakter.');
    const dramas = await searchDrama(query);
    if (!dramas.length) return bot.sendMessage(chatId, `🔍 Tidak ditemukan drama dengan kata "<b>${query}</b>"`, { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(isAdmin(msg.from.id)) });
    const lines = dramas.map((d, i) => {
      const isAnime = d.slug.startsWith('anime:');
      const unit = isAnime ? 'episode' : 'part';
      const epInfo = d.total_eps > 0 ? `${d.total_eps} ep` : `${d.lib_parts} ${unit}`;
      const tag = isAnime ? '🎌 Anime' : '🎬 Drama';
      return `${i + 1}. ${isAnime ? '🎌' : '🎬'} <b>${d.nama}</b> — ${epInfo} · ${tag}`;
    });
    return bot.sendMessage(chatId, `🔍 <b>Hasil pencarian:</b>\n\n${lines.join('\n')}`, {
      parse_mode: 'HTML',
      reply_markup: librarySearchResultKeyboard(dramas),
    });
  }

  // ─── /addvip <user_id> <days> — aktivasi VIP manual oleh admin ─────────────

  const addvipMatch = text.match(/^\/addvip\s+(\d+)\s+(\d+)/i);
  if (addvipMatch) {
    if (!isAdmin(msg.from.id)) return bot.sendMessage(chatId, '⚠️ Hanya admin.');
    const targetId = addvipMatch[1];
    const days = Number(addvipMatch[2]);
    if (days < 1 || days > 3650) return bot.sendMessage(chatId, '⚠️ Hari harus 1–3650.');
    try {
      const vipService = require('./services/vipService');
      await vipService.addVipUser(targetId, days, { username: null, paymentMethod: 'manual' });
      await vipService.recordPayment({ orderId: `manual_${Date.now()}_${targetId}`, userId: targetId, username: null, amount: null, method: 'manual', vipDays: days, message: 'Aktivasi manual admin' });
      await bot.sendMessage(chatId, `✅ VIP ${days} hari diaktifkan untuk <code>${targetId}</code>.`);
      if (String(targetId) !== String(msg.from.id)) {
        bot.sendMessage(targetId, `🎉 <b>VIP AKTIF!</b>\n\n💰 Paket: ${days} hari\n✅ Selamat menikmati fitur VIP.`, { parse_mode: 'HTML' }).catch(() => {});
      }
    } catch (e) {
      logger.error({ err: e.message }, '/addvip failed');
      return bot.sendMessage(chatId, `❌ Gagal aktivasi: ${e.message}`);
    }
    return;
  }

  // ─── !dell — hapus part atau seluruh media dari library ──────────────────────

  const dellMatch = text.match(/^!dell\s+(.+)/i);
  if (dellMatch) {
    if (!isAdmin(msg.from.id)) return bot.sendMessage(chatId, '⚠️ Hanya admin.');
    const args = dellMatch[1].trim().split(/\s+/);
    const lastArg = args[args.length - 1];
    const partNum = Number(lastArg);
    const mediaName = (!isNaN(partNum) && args.length > 1)
      ? args.slice(0, -1).join(' ')
      : args.join(' ');

    const found = await findMediaByName(mediaName);
    if (!found.length) return bot.sendMessage(chatId, `❌ Tidak ditemukan: "<b>${mediaName}</b>"`, { parse_mode: 'HTML' });

    if (found.length > 1 && isNaN(partNum)) {
      const lines = found.map((m, i) => `${i + 1}. <b>${m.nama}</b> (${m.slug})`);
      return bot.sendMessage(chatId, `⚠️ Multiple hasil, spesifikkan:\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
    }

    const target = found[0];
    const isDeleteAll = isNaN(partNum);
    const label = isDeleteAll ? `semua part dari <b>${target.nama}</b>` : `Part ${partNum} dari <b>${target.nama}</b>`;

    pendingDeletes.set(String(chatId), { slug: target.slug, part: isDeleteAll ? null : partNum, name: target.nama });
    return bot.sendMessage(chatId, `⚠️ <b>Konfirmasi hapus:</b>\n\n${label}\n\nYakin?`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🗑️ Ya, Hapus', callback_data: 'dell_confirm' }, { text: '❌ Batal', callback_data: 'dell_cancel' }],
        ],
      },
    });
  }

  if (text === '/libsimpan' || text === '/libsimpan on' || text === '/libsimpan off') {
    if (!isAdmin(msg.from.id)) return bot.sendMessage(chatId, '⚠️ Hanya admin.');
    const current = await getSetting('libsimpan');
    const isOn = text.includes('on') ? true : text.includes('off') ? false : current === 'on';
    if (text !== '/libsimpan') await setSetting('libsimpan', isOn ? 'on' : 'off');
    const status = isOn ? '✅ AKTIF' : '❌ MATI';
    const aiEp2 = await getSetting('ai_endpoint');
    const aiModel2 = await getSetting('ai_model');
    const aiKey2 = await getSetting('ai_api_key');
    return bot.sendMessage(chatId, `💾 <b>Simpan ke Library:</b> ${status}\n\nSaat ${isOn ? 'ON' : 'OFF'}: ${isOn ? 'semua part yang terkirim otomatis masuk library' : 'video tidak disimpan ke library'}`, {
      parse_mode: 'HTML',
      reply_markup: adminPanelKeyboard(isOn, aiEp2, aiModel2, aiKey2),
    });
  }

  if (isUcDriveUrl(text)) {
    if (!isAdmin(msg.from.id)) {
      return bot.sendMessage(chatId, '⚠️ Scraper khusus admin.', { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(false) });
    }
    return handleUcDriveUrl(chatId, text);
  }

  // Batch: multiple GoFile direct URLs in one message
  const rawLines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
  const directUrls = rawLines.filter(l => isGofileDirectUrl(l));
  if (rawLines.length > 1 && directUrls.length === rawLines.length) {
    if (!isAdmin(msg.from.id)) {
      return bot.sendMessage(chatId, '⚠️ Scraper khusus admin.', { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(false) });
    }
    return handleGofileBatch(chatId, directUrls);
  }

  // Batch: multiple Pixeldrain URLs in one message
  if (rawLines.length > 1) {
    const pdUrls = rawLines.filter(l => isPixeldrainUrl(l));
    if (pdUrls.length === rawLines.length) {
      if (!isAdmin(msg.from.id)) {
        return bot.sendMessage(chatId, '⚠️ Scraper khusus admin.', { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(false) });
      }
      for (const url of pdUrls) {
        try {
          await handlePixeldrainUrl(chatId, url);
        } catch (err) {
          logger.error({ chatId, url: url.slice(0, 80), err: err.message }, 'Pixeldrain batch item gagal');
        }
      }
      return;
    }
  }

  if (isSamehadakuUrl(text)) {
    if (!isAdmin(msg.from.id)) {
      return bot.sendMessage(chatId, '⚠️ Scraper khusus admin.', { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(false) });
    }
    const statusMsg = await bot.sendMessage(chatId, '🔍 Mengambil daftar server Samehadaku...').catch(() => null);
    try {
      const res = await resolveSamehadakuFullhd(text);
      // Anime page: tampilkan daftar episode — pakai cacheUrl (short id) agar BUTTON_DATA <64 byte
      if (res.type === 'anime' && res.episodes?.length) {
        const eps = res.episodes;
        const keyboard = [];
        const chunk = 5;
        for (let i = 0; i < eps.length; i += chunk) {
          const row = eps.slice(i, i + chunk).map((e) => ({ text: `Ep ${e.ep}`, callback_data: `sam_ep:${cacheUrl(e.url)}` }));
          keyboard.push(row);
        }
        const title = eps[0]?.title?.split('Episode')[0]?.trim() || 'Samehadaku';
        const caption = `📺 <b>${title}</b>\n${eps.length} episode — pilih episode:`;
        if (statusMsg) {
          return bot.editMessageText(caption, {
            chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard },
          }).catch(() => bot.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }));
        }
        return bot.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
      }
      // Episode page: tampilkan server FULLHD/4K — pakai cacheUrl biar BUTTON_DATA <64
      const { quality, servers } = res;
      const caption = `📺 <b>Samehadaku ${quality}</b>\n\nPilih server untuk download:`;
      const urlId = cacheUrl(text);
      const keyboard = [
        ...(servers.gofile ? [[{ text: `⬇️ Gofile (${quality})`, callback_data: `sam_dl:gofile:${urlId}` }]] : []),
        ...(servers.krakenfiles ? [[{ text: `⬇️ Krakenfiles (${quality})`, callback_data: `sam_dl:krakenfiles:${urlId}` }]] : []),
        ...(servers.pixeldrain ? [[{ text: `⬇️ Pixeldrain (${quality})`, callback_data: `sam_dl:pixeldrain:${urlId}` }]] : []),
        ...(servers.filedon ? [[{ text: `⬇️ Filedon (${quality})`, callback_data: `sam_dl:filedon:${urlId}` }]] : []),
      ];
      if (statusMsg) {
        return bot.editMessageText(caption, {
          chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: keyboard },
        }).catch(() => bot.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }));
      }
      return bot.sendMessage(chatId, caption, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
    } catch (err) {
      if (statusMsg) await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `⚠️ Samehadaku gagal: ${err.message.slice(0, 200)}`, { parse_mode: 'HTML' });
    }
  }

  if (isGofileUrl(text)) {
    if (!isAdmin(msg.from.id)) {
      return bot.sendMessage(chatId, '⚠️ Scraper khusus admin.', { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(false) });
    }
    const statusMsg = await bot.sendMessage(chatId, '🔍 Mengambil info share GoFile...').catch(() => null);
    try {
      let fileName = 'file_gofile';
      if (isGofileDirectUrl(text)) {
        fileName = filenameFromGofileUrl(text);
      } else {
        const file = await resolveGofileFirstFile(text);
        fileName = file.name;
      }
      let detectedTitle = null;
      try {
        const pattern = extractSourcePattern(fileName);
        if (pattern) {
          const matched = await findMediaByPattern(pattern);
          if (matched) detectedTitle = matched.nama;
        }
      } catch {}
      const promptText = detectedTitle
        ? `📥 <b>GoFile Download</b>\n\nFile: <code>${fileName}</code>\n➧ Judul :- <b>${detectedTitle}</b>\n➧ Episode :- Episode ${extractPartFromFilename(fileName)}\n➧ Provider :- ${extractProvider(fileName)}\n\nPilih judul untuk caption:`
        : `📥 <b>GoFile Download</b>\n\nFile: <code>${fileName}</code>\n\nPilih judul untuk caption:`;
      if (statusMsg) {
        return bot.editMessageText(promptText, {
          chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML',
          reply_markup: titlePromptKeyboard(fileName, text, detectedTitle),
        }).catch(() => bot.sendMessage(chatId, promptText, { parse_mode: 'HTML', reply_markup: titlePromptKeyboard(fileName, text, detectedTitle) }));
      }
      return bot.sendMessage(chatId, promptText, {
        parse_mode: 'HTML',
        reply_markup: titlePromptKeyboard(fileName, text, detectedTitle),
      });
    } catch (err) {
      if (statusMsg) await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return handleGofileUrl(chatId, text);
    }
  }

  if (isPixeldrainUrl(text)) {
    if (!isAdmin(msg.from.id)) {
      return bot.sendMessage(chatId, '⚠️ Scraper khusus admin.', { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(false) });
    }
    try {
      const info = await getPixeldrainInfo(text);
      let detectedTitle = null;
      try {
        const pattern = extractSourcePattern(info.name);
        if (pattern) {
          const matched = await findMediaByPattern(pattern);
          if (matched) detectedTitle = matched.nama;
        }
      } catch {}
      const promptText = detectedTitle
        ? `📥 <b>Pixeldrain Download</b>\n\nFile: <code>${info.name}</code>\n➧ Judul :- <b>${detectedTitle}</b>\n➧ Episode :- Episode ${extractPartFromFilename(info.name)}\n➧ Provider :- ${extractProvider(info.name)}\n\nPilih judul untuk caption:`
        : `📥 <b>Pixeldrain Download</b>\n\nFile: <code>${info.name}</code>\n\nPilih judul untuk caption:`;
      return bot.sendMessage(chatId, promptText, {
        parse_mode: 'HTML',
        reply_markup: titlePromptKeyboard(info.name, text, detectedTitle),
      });
    } catch (err) {
      return handlePixeldrainUrl(chatId, text);
    }
  }

  // ReelFren multi-provider aggregator — admin only
  const rfParams = parseReelFrenUrl(text);
  if (rfParams) {
    if (!isAdmin(msg.from.id)) {
      return bot.sendMessage(chatId, '⚠️ Scraper khusus admin.', { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(false) });
    }
    return handleReelFrenUrl(chatId, rfParams, msg.from.id);
  }

  const params = parseDramaUrl(text);
  if (!params || !params.id) {
    return bot.sendMessage(chatId, '⚠️ Link tidak dikenali. Kirim link dari <b>dramafren.org</b>, <b>reelfren.dramafren.org</b>, <b>v2.samehadaku.how</b>, <b>gofile.io</b>, <b>pixeldrain.com</b>, atau <b>uc-share.com</b>.', { parse_mode: 'HTML' });
  }

  // Dramafren scraper — admin only
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(chatId, '⚠️ Scraper khusus admin.', { parse_mode: 'HTML', reply_markup: mainMenuKeyboard(false) });
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

    // Cek duplikat di library
    const mediaSlugDram = `${params.subdomain}:${params.id}`;
    try {
      const dupMediaDram = await getMediaBySlug(mediaSlugDram);
      if (dupMediaDram) {
        const dupPartsDram = await listPartsWithFile(mediaSlugDram);
        const dupTextDram = `⚠️ <b>Sudah ada di Library</b>\n\n🎬 <b>${dupMediaDram.nama}</b>\n📦 ${dupPartsDram.length}/${dupMediaDram.total_eps || episodes.length} part tersimpan\n📡 Provider: <code>${params.subdomain}</code>\n\nKirim ulang akan scrape ulang <b>${episodes.length} episode</b>. Lanjutkan atau Batalkan?`;
        pendingDupScrape.set(String(chatId), { type: 'dramafren', params, episodes, meta });
        await p.done('Cek duplikat');
        return bot.sendMessage(chatId, dupTextDram, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '✅ Lanjutkan', callback_data: 'act:dup_yes' }, { text: '❌ Batalkan', callback_data: 'act:dup_no' }]] }
        });
      }
    } catch {}

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
        `📡 Provider: <code>${params.subdomain}</code>`,
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
        const posterResult = await sendPhoto(chatId, posterPath, { caption });
        // Simpan poster_file_id ke session
        const curSession = sessions.get(String(chatId));
        if (curSession) curSession.meta.poster_file_id = Array.isArray(posterResult?.photo) ? posterResult.photo[posterResult.photo.length - 1]?.file_id || null : posterResult?.photo?.file_id || null;
      } catch {
        logger.warn({ chatId, poster: meta.poster }, 'Poster gagal dikirim, fallback ke teks');
        await bot.sendMessage(chatId, caption, { parse_mode: 'HTML' });
      } finally {
        if (posterPath) cleanupFiles(posterPath);
      }
    } else {
      const captionElse = [
        `<b>${meta.title || params.subdomain}</b>`,
        `📡 Provider: <code>${params.subdomain}</code>`,
        '',
        meta.synopsis ? meta.synopsis.slice(0, 300) + (meta.synopsis.length > 300 ? '...' : '') : '',
        '',
        `🎞 <b>${episodes.length} episode</b> (Ep ${epFirst}–${epLast})`,
      ].filter(Boolean).join('\n');
      await bot.sendMessage(chatId, captionElse, { parse_mode: 'HTML' });
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
    if (!isAdmin(query.from.id)) {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ Hanya admin' }).catch(() => {}) || bot.sendMessage(chatId, '⚠️ Scraper khusus admin.');
    }
    const ep = Number(data.slice(3));
    if (!session) return bot.sendMessage(chatId, '⚠️ Session habis. Kirim ulang link.');
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
    const fileUrl = resolveUrl(rawUrl) || decodeURIComponent(rawUrl);

    if (!isAdmin(query.from.id)) {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ Hanya admin' }).catch(() => {}) || bot.sendMessage(chatId, '⚠️ Scraper khusus admin.');
    }

    if (!fileUrl) {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ Link kadaluarsa, kirim ulang' }).catch(() => {});
    }

    await bot.editMessageText('📥 Downloading...', { chat_id: chatId, message_id: msgId }).catch(() => {});

    if (action === 'gofile') {
      return handleGofileUrl(chatId, fileUrl);
    } else if (action === 'pixeldrain') {
      return handlePixeldrainUrl(chatId, fileUrl);
    }
  }

  // ─── Samehadaku server select callbacks ──────────────────────────────────────
  if (data.startsWith('sam_ep:')) {
    if (!isAdmin(query.from.id)) {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ Hanya admin' }).catch(() => {}) || bot.sendMessage(chatId, '⚠️ Scraper khusus admin.');
    }
    const rawUrl = data.slice(7);
    const episodeUrl = resolveUrl(rawUrl) || decodeURIComponent(rawUrl);
    logger.info({ rawUrl: rawUrl.slice(0, 20), episodeUrl: episodeUrl?.slice(0, 80) }, 'sam_ep click');
    if (!episodeUrl) {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ Link kadaluarsa, kirim ulang' }).catch(() => {});
    }
    await bot.editMessageText('🔍 Mengambil server Samehadaku...', { chat_id: chatId, message_id: msgId }).catch(() => {});
    try {
      const res = await resolveSamehadakuFullhd(episodeUrl);
      logger.info({ resType: res?.type, quality: res?.quality }, 'sam_ep resolved');
      if (!res?.servers) return bot.editMessageText(`⚠️ Gagal: no servers — coba episode lain.`, { chat_id: chatId, message_id: msgId }).catch(() => {});
      const { quality, servers } = res;
      const urlId = cacheUrl(episodeUrl);
      const keyboard = [
        ...(servers.gofile ? [[{ text: `⬇️ Gofile (${quality})`, callback_data: `sam_dl:gofile:${urlId}` }]] : []),
        ...(servers.krakenfiles ? [[{ text: `⬇️ Krakenfiles (${quality})`, callback_data: `sam_dl:krakenfiles:${urlId}` }]] : []),
        ...(servers.pixeldrain ? [[{ text: `⬇️ Pixeldrain (${quality})`, callback_data: `sam_dl:pixeldrain:${urlId}` }]] : []),
        ...(servers.filedon ? [[{ text: `⬇️ Filedon (${quality})`, callback_data: `sam_dl:filedon:${urlId}` }]] : []),
        [{ text: `⬅️ Kembali ke list episode`, callback_data: `sam_back:${cacheUrl(episodeUrl.split('/episode-')[0] + '/')}` }],
      ];
      return bot.editMessageText(`📺 <b>Samehadaku ${quality}</b>\n\nPilih server untuk download:`, {
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard },
      }).catch(() => bot.sendMessage(chatId, `📺 <b>Samehadaku ${quality}</b>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }));
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'sam_ep failed');
      return bot.editMessageText(`⚠️ Gagal ambil server: ${err.message.slice(0, 100)}\n\nKirim ulang link anime.`, { chat_id: chatId, message_id: msgId }).catch(() => {});
    }
  }

  if (data.startsWith('sam_back:')) {
    const rawUrl = data.slice(9);
    let animeUrl = resolveUrl(rawUrl) || decodeURIComponent(rawUrl);
    if (!animeUrl) return bot.answerCallbackQuery(query.id, { text: '⚠️ Link kadaluarsa' }).catch(() => {});
    // fallback: jika sam_back dari episode, reconstruct anime base
    if (!animeUrl.includes('/anime/')) animeUrl = animeUrl.replace(/\/tensei[^/]+\/.*/, '/anime/tensei-shitara-slime-datta-ken-season-4/');
    await bot.editMessageText('🔍 Memuat daftar episode...', { chat_id: chatId, message_id: msgId }).catch(() => {});
    try {
      const res = await resolveSamehadakuFullhd(animeUrl);
      if (res.type !== 'anime' || !res.episodes?.length) return bot.editMessageText('⚠️ Gagal load episode.', { chat_id: chatId, message_id: msgId }).catch(() => {});
      const eps = res.episodes;
      const keyboard = [];
      const chunk = 5;
      for (let i = 0; i < eps.length; i += chunk) {
        const row = eps.slice(i, i + chunk).map((e) => ({ text: `Ep ${e.ep}`, callback_data: `sam_ep:${cacheUrl(e.url)}` }));
        keyboard.push(row);
      }
      const title = eps[0]?.title?.split('Episode')[0]?.trim() || 'Samehadaku';
      return bot.editMessageText(`📺 <b>${title}</b>\n${eps.length} episode — pilih episode:`, {
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard },
      }).catch(() => {});
    } catch (err) {
      return bot.editMessageText(`⚠️ Gagal: ${err.message.slice(0, 80)}`, { chat_id: chatId, message_id: msgId }).catch(() => {});
    }
  }

  if (data.startsWith('sam_dl:')) {
    if (!isAdmin(query.from.id)) {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ Hanya admin' }).catch(() => {}) || bot.sendMessage(chatId, '⚠️ Scraper khusus admin.');
    }
    const parts2 = data.split(':');
    const server = parts2[1];
    const rawUrl = parts2.slice(2).join(':');
    const episodeUrl = resolveUrl(rawUrl) || decodeURIComponent(rawUrl);
    logger.info({ server, rawUrl: rawUrl.slice(0, 20), episodeUrl: episodeUrl?.slice(0, 80) }, 'sam_dl click');
    if (!episodeUrl) {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ Link kadaluarsa, kirim ulang' }).catch(() => {});
    }
    const sameInfo = parseSamehadakuEpisode(episodeUrl);
    await bot.editMessageText('🔍 Mengambil link server...', { chat_id: chatId, message_id: msgId }).catch(() => {});
    let fileUrl = null;
    try {
      const { servers } = await resolveSamehadakuFullhd(episodeUrl);
      fileUrl = servers[server];
      if (!fileUrl) return bot.editMessageText(`⚠️ Server ${server} tidak tersedia.`, { chat_id: chatId, message_id: msgId }).catch(() => {});
      if (sameInfo) samehadakuEpisodeMap.set(fileUrl, sameInfo);
      if (/krakenfiles\.com/i.test(fileUrl)) {
        return bot.editMessageText(`⚠️ Server Krakenfiles belum didukung (gofile/pixeldrain/filedon saja).`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: `sam_ep:${cacheUrl(episodeUrl)}` }]] } }).catch(() => {});
      }
      const sameTitleArg = sameInfo
        ? `${sameInfo.title}${sameInfo.season ? ` S${sameInfo.season}` : ''}${sameInfo.part ? ` P${sameInfo.part}` : ''}`
        : null;
      const titleArg = sameTitleArg;
      if (isGofileUrl(fileUrl)) {
        try { return await handleGofileUrl(chatId, fileUrl, titleArg); }
        catch (e) { return bot.sendMessage(chatId, `⚠️ Gofile gagal: ${e.message.slice(0, 80)}\n\nCoba server lain:`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali ke pilihan server', callback_data: `sam_ep:${cacheUrl(episodeUrl)}` }]] } }).catch(()=>{}); }
      }
      if (isPixeldrainUrl(fileUrl)) {
        try { return await handlePixeldrainUrl(chatId, fileUrl, titleArg); }
        catch (e) { return bot.sendMessage(chatId, `⚠️ Pixeldrain gagal: ${e.message.slice(0, 80)}\n\nCoba server lain:`, { reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali ke pilihan server', callback_data: `sam_ep:${cacheUrl(episodeUrl)}` }]] } }).catch(()=>{}); }
      }
      if (isFiledonUrl(fileUrl)) {
        const sami2 = parseSamehadakuEpisode(episodeUrl);
        try {
          const fd = await resolveFiledonFile(fileUrl);
          const cap = sami2 ? `${sami2.title} — ${sami2.season ? `Season ${sami2.season} ` : ''}Episode ${sami2.episode}` : fd.name;
          let rp2 = null;
          let sendResult2 = null;
          try {
            rp2 = await new RichProgress(chatId, cap, [{ ep: cap }]).start();
            rp2.updateEpisode(cap, 'download');
            const outPath2 = tempPath(fd.name);
            await downloadWithAria2c(fd.url, outPath2, (log) => {
              if (log.includes('progress:')) rp2.updateEpisode(cap, 'download', log.split('progress: ')[1]);
              else if (log.startsWith('DL:')) rp2.updateEpisode(cap, 'download', log);
            }, {}, fd.size);
            const finalSize2 = fileSizeMb(outPath2);
            logger.info({ chatId, file: fd.name, sizeMb: finalSize2.toFixed(1) }, 'Filedon download selesai');
            rp2.updateEpisode(cap, 'upload', `${finalSize2.toFixed(1)} MB`);
            const info2 = await getVideoInfo(outPath2).catch(() => ({}));
            const ext2 = path.extname(outPath2).toLowerCase();
            let finalCap2;
            if (sami2) {
              const p2 = sami2.part ? ` Part ${sami2.part}` : '';
              if (sami2.season)               finalCap2 = `➧ Judul :- ${sami2.title}\n➧ Season :- ${sami2.season}${p2} Episode ${sami2.episode}\n➧ Provider :- samehadaku`;
              else finalCap2 = `➧ Judul :- ${sami2.title}\n➧ Episode :- Episode ${sami2.episode}\n➧ Provider :- samehadaku`;
            } else finalCap2 = cap;
            if (VIDEO_EXTS.has(ext2)) sendResult2 = await sendVideo(chatId, outPath2, { caption: finalCap2, supports_streaming: true, ...(info2.duration && { duration: info2.duration }), ...(info2.width && { width: info2.width }), ...(info2.height && { height: info2.height }) }, { urlHash: hashUrl(fd.url), source: 'filedon', fileName: fd.name });
            else sendResult2 = await sendDocument(chatId, outPath2, { caption: finalCap2 }, { urlHash: hashUrl(fd.url), source: 'filedon', fileName: fd.name });
            if (sendResult2?.video?.file_id && (await getSetting('libsimpan')) === 'on' && sami2) {
              const fullTitle = `${sami2.title}${sami2.season ? ` S${sami2.season}` : ''}${sami2.part ? ` P${sami2.part}` : ''}`;
              const slug = `anime:${sanitizeSlug(fullTitle)}`;
              const existing = await getPartFileId(slug, sami2.episode);
              if (!existing) {
                const sourcePattern = fullTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                await upsertMedia(slug, fullTitle, 0, `https://v2.samehadaku.how/anime/${sami2.slug}/`, sourcePattern);
                await savePartFileId(slug, sami2.episode, sendResult2.video.file_id, Math.round(finalSize2 * 1024 * 1024), fd.name, finalCap2);
              }
            }
            rp2.updateEpisode(cap, 'done', `${finalSize2.toFixed(1)} MB`);
            rp2.done(); cleanupFiles(outPath2); return;
          } catch (e2) {
            if (rp2) { rp2.updateEpisode(cap, 'fail', e2.message.slice(0, 30)); rp2.done().catch(()=>{}); }
            throw e2;
          }
        } catch (e) { return bot.sendMessage(chatId, `⚠️ Filedon gagal: ${e.message.slice(0, 100)}\n\nCoba server lain:`, { reply_markup: { inline_keyboard: [[{ text: `⬅️ Kembali ke pilihan server`, callback_data: `sam_ep:${cacheUrl(episodeUrl)}` }]] } }).catch(()=>{}); }
      }
      return bot.editMessageText('⚠️ Link server belum didukung.', { chat_id: chatId, message_id: msgId }).catch(() => {});
    } catch (err) {
      return bot.editMessageText(`⚠️ Gagal: ${err.message.slice(0, 100)}`, { chat_id: chatId, message_id: msgId }).catch(() => {});
    }
  }

  // ─── Title prompt callbacks ───────────────────────────────────────────────────

  if (data.startsWith('dl_title_use:') || data.startsWith('dl_title_custom:')) {
    const rawUrl = data.split(':').slice(1).join(':');
    const url = resolveUrl(rawUrl) || decodeURIComponent(rawUrl);
    const isCustom = data.startsWith('dl_title_custom:');

    if (isCustom) {
      pendingDownloads.set(String(chatId), { url, handler: isGofileUrl(url) ? 'gofile' : 'pixeldrain' });
      await bot.editMessageText('✏️ Ketik judul untuk caption video:', { chat_id: chatId, message_id: msgId }).catch(() => {});
      return;
    }

    // Teruskan judul terdeteksi dari prompt agar tidak hilang
    let detectedTitle = null;
    try {
      const fileName = isGofileUrl(url) ? filenameFromGofileUrl(url) : (await getPixeldrainInfo(url).catch(() => null))?.name;
      if (fileName) {
        const pat = extractSourcePattern(fileName);
        if (pat) {
          const m = await findMediaByPattern(pat);
          if (m) detectedTitle = m.nama;
        }
      }
    } catch {}
    await bot.editMessageText('📥 Memproses...', { chat_id: chatId, message_id: msgId }).catch(() => {});
    if (isGofileUrl(url)) return handleGofileUrl(chatId, url, detectedTitle || undefined);
    if (isPixeldrainUrl(url)) return handlePixeldrainUrl(chatId, url, detectedTitle || undefined);
  }

  // ─── Delete confirmation callbacks ───────────────────────────────────────────

  if (data === 'dell_confirm') {
    const pending = pendingDeletes.get(String(chatId));
    pendingDeletes.delete(String(chatId));
    if (!pending) return bot.answerCallbackQuery(query.id, { text: '⚠️ Session habis' });

    if (pending.part === null) {
      await deleteMedia(pending.slug);
      return bot.editMessageText(
        `🗑️ <b>${pending.name}</b> dihapus dari library (semua part)`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
      ).catch(() => {});
    }

    const ok = await deletePart(pending.slug, pending.part);
    if (!ok) return bot.editMessageText(`❌ Part ${pending.part} tidak ditemukan`, { chat_id: chatId, message_id: msgId }).catch(() => {});
    const remaining = await listPartsWithFile(pending.slug);
    return bot.editMessageText(
      `🗑️ Part ${pending.part} dihapus dari <b>${pending.name}</b>\n📁 Sisa: ${remaining.length} part`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
    ).catch(() => {});
  }

  if (data === 'dell_cancel') {
    pendingDeletes.delete(String(chatId));
    return bot.editMessageText('❌ Dibatalkan.', { chat_id: chatId, message_id: msgId }).catch(() => {});
  }

  // ─── Replace callbacks ────────────────────────────────────────────────────────

  if (data.startsWith('lib_replace:') && !data.includes('_pick') && !data.includes('_confirm')) {
    if (!isAdmin(query.from.id)) return bot.answerCallbackQuery(query.id, { text: '⚠️ Hanya admin' });
    const slug = resolveSlug(data.slice(12));
    if (!slug) return bot.answerCallbackQuery(query.id, { text: '⚠️ Session expired', show_alert: true });
    const parts = await listPartsWithFile(slug);
    if (!parts.length) return bot.answerCallbackQuery(query.id, { text: '⚠️ Tidak ada part' });
    const media = await getMediaBySlug(slug);
    const dramaName = media?.nama || slug.replace(/^[^:]+:/, '');
    const isAnime = slug.startsWith('anime:');
    const unit = isAnime ? 'Ep' : 'Part';
    const sid = cacheSlug(slug);
    const rows = parts.map(p => ([{ text: `🔄 ${unit} ${p.part}`, callback_data: `lib_replace_pick:${sid}:${p.part}` }]));
    rows.push([{ text: '⬅️ Batal', callback_data: `lib_menu:${sid}` }]);
    return bot.editMessageText(
      `🔄 <b>Replace — ${dramaName}</b>\n\nPilih ${isAnime ? 'episode' : 'part'} yang mau di-replace:`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } }
    ).catch(() => {});
  }

  if (data.startsWith('lib_replace_pick:')) {
    if (!isAdmin(query.from.id)) return bot.answerCallbackQuery(query.id, { text: '⚠️ Hanya admin' });
    const partStr = data.split(':').pop();
    const slugId = data.slice(17, data.length - partStr.length - 1);
    const slug = resolveSlug(slugId);
    if (!slug) return bot.answerCallbackQuery(query.id, { text: '⚠️ Session expired', show_alert: true });
    const part = Number(partStr);
    const media = await getMediaBySlug(slug);
    const dramaName = media?.nama || slug.replace(/^[^:]+:/, '');
    const isAnime = slug.startsWith('anime:');
    const unit = isAnime ? 'Episode' : 'Part';
    pendingReplaces.set(String(chatId), { slug, part, name: dramaName });
    return bot.editMessageText(
      `🔄 <b>Replace ${unit} ${part} — ${dramaName}</b>\n\nKirim video/audio baru untuk mengganti ${unit} ${part}:`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
    ).catch(() => {});
  }

  if (data.startsWith('lib_add:')) {
    if (!isAdmin(query.from.id)) return bot.answerCallbackQuery(query.id, { text: '⚠️ Hanya admin' });
    const slug = resolveSlug(data.slice(8));
    if (!slug) return bot.answerCallbackQuery(query.id, { text: '⚠️ Session expired', show_alert: true });
    const parts = await listPartsWithFile(slug);
    const maxPart = parts.reduce((max, p) => Math.max(max, p.part), 0);
    const nextPart = maxPart + 1;
    const media = await getMediaBySlug(slug);
    const dramaName = media?.nama || slug.replace(/^[^:]+:/, '');
    const isAnime = slug.startsWith('anime:');
    const unit = isAnime ? 'Episode' : 'Part';
    pendingAdds.set(String(chatId), { slug, nextPart, name: dramaName });
    return bot.editMessageText(
      `➕ <b>Tambah ${unit} Baru — ${dramaName}</b>\n\n${unit} berikutnya: <b>${unit} ${nextPart}</b>\n\nKirim video/audio baru:`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
    ).catch(() => {});
  }

  // ─── Library callbacks ────────────────────────────────────────────────────────

  if (data.startsWith('lib_menu:')) {
    let slugId, page;
    const pMatch = data.match(/^lib_menu:(.+):p:(\d+)$/);
    if (pMatch) {
      slugId = pMatch[1];
      page = parseInt(pMatch[2]) || 1;
    } else {
      slugId = data.slice(9);
      page = 1;
    }
    const slug = resolveSlug(slugId);
    if (!slug) return bot.answerCallbackQuery(query.id, { text: '⚠️ Session expired — buka ulang', show_alert: true });
    const parts = await listPartsWithFile(slug);
    if (!parts.length) return bot.answerCallbackQuery(query.id, { text: '⚠️ Belum ada part di library' });
    const media = await getMediaBySlug(slug);
    const dramaName = media?.nama || slug.replace(/^[^:]+:/, '');
    const isAnime = slug.startsWith('anime:');
    const unit = isAnime ? 'episode' : 'part';
    const perPage = 20;
    const totalPages = Math.ceil(parts.length / perPage);
    const isAdminUserLib = isAdmin(query.from.id);
    const kb = page > 1 ? libraryPartsPageKeyboard(slug, parts, page, isAdminUserLib) : libraryPartsKeyboard(slug, parts, isAdminUserLib);
    const synopsis = media?.synopsis ? media.synopsis.slice(0, 380) + (media.synopsis.length > 380 ? '…' : '') : '';
    const escSyn = synopsis ? synopsis.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
    const provider = slug.split(':')[0].replace('reelfren_', '');
    const katTag = isAnime ? '🎌 Anime' : '🎬 Drama';
    const caption = [`<b>${dramaName}</b> — ${katTag}`, `📡 Provider: <code>${provider}</code>`, '', escSyn, '', `📁 ${parts.length} ${unit} tersedia di library`].filter(Boolean).join('\n');
    // Coba kirim poster jika ada (page 1 saja)
    if (page === 1 && (media?.poster_file_id || media?.poster_url)) {
      try {
        if (media.poster_file_id) {
          await bot.sendPhoto(chatId, media.poster_file_id, { caption, parse_mode: 'HTML', reply_markup: kb });
        } else {
          await bot.sendPhoto(chatId, media.poster_url, { caption, parse_mode: 'HTML', reply_markup: kb });
        }
        await bot.answerCallbackQuery(query.id).catch(() => {});
        await bot.deleteMessage(chatId, msgId).catch(() => {});
        return;
      } catch {}
    }
    return bot.editMessageText(
      caption,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: kb }
    ).catch(() => {});
  }

  if (data.startsWith('lib_part:')) {
    // Rate limit untuk free user (admin & VIP bypass) — 1/menit streaming
    if (!isAdmin(query.from.id)) {
      try {
        const vipService = require('./services/vipService');
        const isVip = await vipService.isVipUser(query.from.id);
        if (!isVip) {
          const rateLimiter = require('./utils/rateLimiter');
          if (rateLimiter.isLimited(query.from.id, 'lib_view')) {
            const remain = rateLimiter.getRemaining(query.from.id, 'lib_view');
            return bot.answerCallbackQuery(query.id, { text: `⏳ Rate limit 1/menit — sisa ${remain}, VIP unlimited`, show_alert: true });
          }
        }
      } catch {}
    }
    const partStr = data.split(':').pop();
    const slugId = data.slice(9, data.length - partStr.length - 1);
    const slug = resolveSlug(slugId);
    if (!slug) return bot.answerCallbackQuery(query.id, { text: '⚠️ Session expired — buka ulang', show_alert: true });
    const part = Number(partStr);
    const file = await getPartFileId(slug, part);
    if (!file) return bot.answerCallbackQuery(query.id, { text: '⚠️ Part tidak ditemukan' });
    const media = await getMediaBySlug(slug);
    const dramaName = media?.nama || slug.replace(/^[^:]+:/, '');
    const isAnime = slug.startsWith('anime:');
    const unit = isAnime ? 'Episode' : 'Part';
    const caption = file.caption || [
      `➧ Judul :- <b>${dramaName}</b>`,
      `➧ ${unit} :- <b>${unit} ${part}</b>`,
      `➧ Provider :- <tg-spoiler>${extractProvider(file.file_name || '')}</tg-spoiler>`,
    ].join('\n');
    try {
      // Kirim poster jika ada
      if (media?.poster_file_id) {
        await bot.sendPhoto(chatId, media.poster_file_id, { caption, parse_mode: 'HTML' }).catch(() => {});
      } else if (media?.poster_url) {
        try {
          const ext = (() => { try { const m = media.poster_url.match(/\.(jpe?g|png|webp|gif)(?:[@?#]|$)/i); return m ? '.' + m[1].toLowerCase() : '.jpg'; } catch { return '.jpg'; } })();
          const posterPath = tempPath(`poster_lib_${Date.now()}${ext}`);
          const resp = await axios({ url: media.poster_url, responseType: 'stream', timeout: 15000 });
          await new Promise((resolve, reject) => {
            const ws = fs.createWriteStream(posterPath);
            resp.data.pipe(ws);
            ws.on('finish', resolve);
            ws.on('error', reject);
          });
          await sendPhoto(chatId, posterPath, { caption, parse_mode: 'HTML' });
          cleanupFiles(posterPath);
        } catch {
          logger.warn({ slug, poster: media.poster_url }, 'Library poster gagal dikirim');
        }
      }
      await bot.sendVideo(chatId, file.file_id, { caption, parse_mode: 'HTML' });
    } catch (err) {
      logger.error({ chatId, slug, part, err: err.message }, 'Library send failed');
      await bot.sendMessage(chatId, `❌ Gagal kirim ${unit} ${part}: ${err.message.slice(0, 100)}`);
    }
    return;
  }

  if (data === 'noop') return bot.answerCallbackQuery(query.id);

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

  if (act === 'back_main') {
    return bot.editMessageText(
      '🎬 <b>PRJS Bot</b>\n\nPilih menu:',
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: mainMenuKeyboard(isAdmin(query.from.id)) }
    ).catch(() => {});
  }

  if (act === 'list') {
    if (!isAdmin(query.from.id)) {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ Hanya admin' }).catch(() => {});
    }
    if (!session) return bot.sendMessage(chatId, '⚠️ Session habis.');
    return bot.editMessageText(
      `🔢 Pilih episode (hanya ambil URL, tanpa download):`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: episodeListKeyboard(session.episodes) }
    ).catch(() => {});
  }

  if (act === 'ai') {
    aiChatSessions.set(chatId, true);
    return bot.editMessageText(
      `💬 <b>Live Chat Aktif</b>\n\nKetik pesan Anda. Admin akan membalas.\n\n<i>Tap menu lain atau ⬅️ Keluar untuk akhiri.</i>`,
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

  if (act === 'admin_panel') {
    if (!isAdmin(query.from.id)) return bot.answerCallbackQuery(query.id, { text: '⚠️ Hanya admin' });
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

  if (act === 'ai_endpoint') {
    if (!isAdmin(query.from.id)) return bot.answerCallbackQuery(query.id, { text: '⚠️ Hanya admin' });
    const curEp = await getSetting('ai_endpoint');
    const cur = curEp ? `<code>${curEp}</code>` : '<i>belum diset (Live Chat nonaktif)</i>';
    pendingAiEndpoint.set(String(chatId), true);
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(
      chatId,
      `🤖 <b>AI Endpoint</b>\n\nSaat ini:\n${cur}\n\nKirim URL endpoint baru (OpenAI-compatible), contoh:\n<code>https://tokenharbor.ai/v1</code>\natau full:\n<code>https://api.example.com/v1/chat/completions</code>\n\nKetik <code>hapus</code> untuk reset, atau /cancel untuk batal.`,
      { parse_mode: 'HTML' }
    );
  }

  if (act === 'ai_key') {
    if (!isAdmin(query.from.id)) return bot.answerCallbackQuery(query.id, { text: '⚠️ Hanya admin' });
    const curKey = await getSetting('ai_api_key');
    const cnt = curKey ? curKey.split(',').filter(Boolean).length : 0;
    const cur = cnt ? `✅ ${cnt} key${cnt > 1 ? 's' : ''} diset` : '❌ belum diset';
    pendingAiKey.set(String(chatId), true);
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(
      chatId,
      `🔑 <b>AI API Key</b> (support multi, cascade)\n\nSaat ini: ${cur}\n\nKirim 1 key atau comma-separated untuk multi, contoh:\n<code>sk-aaa,sk-bbb,sk-ccc</code>\nJika key pertama 401/429/quota → otomatis coba berikutnya.\n\nKetik <code>hapus</code> untuk reset, atau /cancel untuk batal.\n\n<i>Pesan key akan dihapus otomatis.</i>`,
      { parse_mode: 'HTML' }
    );
  }

  if (act === 'ai_model') {
    if (!isAdmin(query.from.id)) return bot.answerCallbackQuery(query.id, { text: '⚠️ Hanya admin' });
    const curModel = await getSetting('ai_model');
    const cur = curModel ? `<code>${curModel}</code>` : '<i>belum diset</i>';
    pendingAiModel.set(String(chatId), true);
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(
      chatId,
      `🧠 <b>AI Model</b> (support multi, cascade otomatis)\n\nSaat ini:\n${cur}\n\nKirim 1 model atau comma-separated untuk cascade, contoh:\n<code>qwen3-8b:free,deepseek-v4-flash:free,mimo-v2.5:free</code>\n\nJika model pertama mati/error → otomatis coba berikutnya.\n\nKetik <code>hapus</code> untuk reset, atau /cancel untuk batal.`,
      { parse_mode: 'HTML' }
    );
  }

  if (act === 'vidara_domain') {
    if (!isAdmin(query.from.id)) return bot.answerCallbackQuery(query.id, { text: '⚠️ Hanya admin' });
    const curDomain = await getVidaraActiveDomain();
    const cur = curDomain ? `<code>${curDomain}</code>` : '<i>default: vidara.so</i>';
    pendingVidaraDomain.set(String(chatId), true);
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(
      chatId,
      `🌐 <b>Domain Vidara</b> (untuk embed link)\n\nSaat ini: ${cur}\n\nKirim domain baru, contoh:\n<code>vidara.to</code>\n<code>vidmatrixa.com</code>\n\nDomain akan dipakai untuk generate link embed: <code>https://&lt;domain&gt;/e/&lt;filecode&gt;</code>\n\nKetik <code>hapus</code> untuk reset ke default, atau /cancel untuk batal.`,
      { parse_mode: 'HTML' }
    );
  }

  if (act === 'dup_yes') {
    const pending = pendingDupScrape.get(String(chatId));
    if (!pending) return bot.answerCallbackQuery(query.id, { text: '⚠️ Session expired — kirim ulang link', show_alert: true });
    pendingDupScrape.delete(String(chatId));
    await bot.answerCallbackQuery(query.id, { text: 'Lanjutkan...' });
    try { await bot.deleteMessage(chatId, msgId).catch(() => {}); } catch {}
    if (pending.type === 'reelfren') {
      const { provider, fullId, slug, lang, episodes, meta, userId } = pending;
      sessions.set(String(chatId), { subdomain: `reelfren_${provider}`, id: fullId, slug, lang, userId, episodes, meta: { ...meta, provider, source: 'reelfren' } });
      const epFirst = episodes[0].ep;
      const epLast = episodes[episodes.length - 1].ep;
      const caption = [
        `<b>${meta.title || fullId}</b>`,
        `📡 Provider: <code>${provider}</code>`,
        '',
        meta.synopsis ? meta.synopsis.slice(0, 300) + (meta.synopsis.length > 300 ? '...' : '') : '',
        '',
        `🎞 <b>${episodes.length} episode</b> (Ep ${epFirst}–${epLast})`,
      ].filter(Boolean).join('\n');
      let posterPathDup = null;
      let posterFileIdDup = null;
      if (meta.poster) {
        try {
          const ext = (() => { try { const m = meta.poster.match(/\.(jpe?g|png|webp|gif)(?:[@?#]|$)/i); return m ? '.' + m[1].toLowerCase() : '.jpg'; } catch { return '.jpg'; } })();
          posterPathDup = tempPath(`poster_${Date.now()}${ext}`);
          const resp = await axios({ url: meta.poster, responseType: 'stream', timeout: 15000 });
          await new Promise((resolve, reject) => { const ws = fs.createWriteStream(posterPathDup); resp.data.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); });
          const posterResultDup = await sendPhoto(chatId, posterPathDup, { caption });
          posterFileIdDup = Array.isArray(posterResultDup?.photo) ? posterResultDup.photo[posterResultDup.photo.length - 1]?.file_id || null : posterResultDup?.photo?.file_id || null;
          const curSessionDup = sessions.get(String(chatId));
          if (curSessionDup) curSessionDup.meta.poster_file_id = posterFileIdDup;
          if (isAdmin(userId)) { try { await sendToProviderTopic(provider, caption, posterPathDup); } catch {} }
        } catch {
          await bot.sendMessage(chatId, caption, { parse_mode: 'HTML' });
        } finally { if (posterPathDup) cleanupFiles(posterPathDup); }
      } else {
        await bot.sendMessage(chatId, caption, { parse_mode: 'HTML' });
      }
      await bot.sendMessage(chatId, 'Pilih aksi:', { reply_markup: mainActionKeyboard() });
    } else if (pending.type === 'dramafren') {
      const { params, episodes, meta } = pending;
      sessions.set(String(chatId), { subdomain: params.subdomain, id: params.id, slug: params.slug, lang: params.lang, episodes, meta });
      const epFirst = episodes[0].ep;
      const epLast = episodes[episodes.length - 1].ep;
      let posterPath2 = null;
      const caption2 = [
        `<b>${meta.title || params.subdomain}</b>`,
        `📡 Provider: <code>${params.subdomain}</code>`,
        '',
        meta.synopsis ? meta.synopsis.slice(0, 300) + (meta.synopsis.length > 300 ? '...' : '') : '',
        '',
        `🎞 <b>${episodes.length} episode</b> (Ep ${epFirst}–${epLast})`,
      ].filter(Boolean).join('\n');
      if (meta.poster) {
        try {
          const ext = (() => { try { const m = meta.poster.match(/\.(jpe?g|png|webp|gif)(?:[@?#]|$)/i); return m ? '.' + m[1].toLowerCase() : '.jpg'; } catch { return '.jpg'; } })();
          posterPath2 = tempPath(`poster_${Date.now()}${ext}`);
          const resp = await axios({ url: meta.poster, responseType: 'stream', timeout: 15000 });
          await new Promise((resolve, reject) => { const ws = fs.createWriteStream(posterPath2); resp.data.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); });
          const posterResult2 = await sendPhoto(chatId, posterPath2, { caption: caption2 });
          const curSession2 = sessions.get(String(chatId));
          if (curSession2) curSession2.meta.poster_file_id = Array.isArray(posterResult2?.photo) ? posterResult2.photo[posterResult2.photo.length - 1]?.file_id || null : posterResult2?.photo?.file_id || null;
        } catch { await bot.sendMessage(chatId, caption2, { parse_mode: 'HTML' }); } finally { if (posterPath2) cleanupFiles(posterPath2); }
      } else {
        await bot.sendMessage(chatId, caption2, { parse_mode: 'HTML' });
      }
      await bot.sendMessage(chatId, 'Pilih aksi:', { reply_markup: mainActionKeyboard() });
    }
    return;
  }
  if (act === 'dup_no') {
    pendingDupScrape.delete(String(chatId));
    await bot.answerCallbackQuery(query.id, { text: 'Dibatalkan' });
    try { await bot.editMessageText('❌ Scrape dibatalkan — drama tetap di library.', { chat_id: chatId, message_id: msgId }); } catch { await bot.sendMessage(chatId, '❌ Dibatalkan.'); }
    return;
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
      `**📚 Library:**\n` +
      `- \`/cari nama drama\` → cari di koleksi\n` +
      `- Tap Part → video instan dari Telegram\n\n` +
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

  // ─── Library callbacks ────────────────────────────────────────────────────────

  if (act === 'lib_toggle') {
    if (!isAdmin(query.from.id)) return bot.answerCallbackQuery(query.id, { text: '⚠️ Hanya admin' });
    const current = await getSetting('libsimpan');
    const isOn = current !== 'on';
    await setSetting('libsimpan', isOn ? 'on' : 'off');
    const status = isOn ? '✅ AKTIF' : '❌ MATI';
    const aiEp = await getSetting('ai_endpoint');
    const aiModel = await getSetting('ai_model');
    const aiKey = await getSetting('ai_api_key');
    return bot.editMessageText(
      `💾 <b>Simpan ke Library:</b> ${status}\n\nSaat ${isOn ? 'ON' : 'OFF'}: ${isOn ? 'semua part yang terkirim otomatis masuk library' : 'video tidak disimpan ke library'}`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: 'HTML',
        reply_markup: adminPanelKeyboard(isOn, aiEp, aiModel, aiKey),
      }
    ).catch(() => {});
  }

  if (act === 'lib_list' || act.startsWith('lib_list_p:') || act.startsWith('lib_list_c:')) {
    try {
      let kat = 'all';
      let page = 1;
      if (act.startsWith('lib_list_c:')) {
        const parts = act.split(':');
        kat = parts[1] || 'all';
        page = parseInt(parts[2]) || 1;
      } else if (act.startsWith('lib_list_p:')) {
        page = parseInt(act.split(':')[1]) || 1;
      }
      const all = await listAllLibrary();
      if (!all.length) {
        try { await bot.editMessageText('📭 Library kosong.', { chat_id: chatId, message_id: msgId }); } catch { await bot.sendMessage(chatId, '📭 Library kosong.'); }
        return;
      }
      const { header, rows } = await buildLibraryKeyboard(kat, page, all);
      rows.push([{ text: '⬅️ Kembali', callback_data: 'act:back_main' }]);
      try {
        await bot.editMessageText(header, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
      } catch (e) {
        await bot.sendMessage(chatId, header, { parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
      }
      return;
    } catch (e) {
      logger.error({ err: e.message, act }, 'lib_list failed');
      try { await bot.sendMessage(chatId, `❌ Gagal buka library: ${e.message.slice(0, 80)}`); } catch {}
      return;
    }
  }

  if (act === 'lib_search') {
    return bot.editMessageText(
      '📚 <b>Cari Drama/Anime</b>\n\nKetik: <code>/cari nama</code>',
      { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
    ).catch(() => {});
  }

  // ─── Paket VIP: bikin baris keyboard paket untuk QRIS/Stars ───────────────

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

  if (act === 'vip') {
    const vipService = require('./services/vipService');
    const pricing = VIP_PACKAGE_ORDER.map((d) => {
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

  if (act === 'select_payment_qris') {
    if (!process.env.SAWERIA_USERNAME || !process.env.SAWERIA_USER_ID) {
      return bot.answerCallbackQuery(query.id, { text: 'QRIS belum dikonfigurasi, hubungi admin', show_alert: true });
    }
    const rows = vipPaymentRows('qris');
    return bot.editMessageText('⬛ <b>QRIS Payment</b>\n\nPilih paket (nominal kelipatan Rp 1.000):', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
  }

  if (act === 'select_payment_stars') {
    const rows = vipPaymentRows('stars');
    return bot.editMessageText('⭐ <b>Stars Payment</b>\n\nPilih paket (dibayar via Telegram Stars):', { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: rows } });
  }

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
      const saweriaService = require('./services/saweriaService');
      const ctx = {
        from: query.from,
        chat: { id: chatId },
        answerCbQuery: (text, opts) => text
          ? bot.answerCallbackQuery(query.id, Object.assign({ text, show_alert: !!opts?.show_alert }, opts))
          : bot.answerCallbackQuery(query.id),
        reply: (html, opts) => bot.sendMessage(chatId, html, opts),
        replyWithPhoto: (photo, opts) => bot.sendPhoto(chatId, photo, opts),
        telegram: {
          deleteMessage: (cid, mid) => bot.deleteMessage(cid, mid),
          editMessageText: (cid, mid, _inlineId, html, opts) => bot.editMessageText(html, Object.assign({ chat_id: cid, message_id: mid }, opts)),
          sendMessage: (cid, html, opts) => bot.sendMessage(cid, html, opts),
        },
        notify: (html) => ADMIN_IDS.length ? bot.sendMessage(ADMIN_IDS[0], html, { parse_mode: 'HTML' }) : Promise.resolve(),
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
      const saweriaService = require('./services/saweriaService');
      await saweriaService.cancelAndCleanup({
        telegram: { deleteMessage: (cid, mid) => bot.deleteMessage(cid, mid) },
      }, donationId);
      await bot.sendMessage(chatId, '❌ Pembayaran dibatalkan.', { reply_markup: { inline_keyboard: [[{ text: '💎 Menu VIP', callback_data: 'act:vip' }]] } });
    } catch (e) {
      logger.warn({ err: e.message }, 'saweria cancel failed');
    }
    return;
  }

  if (act === 'pay_stars') {
    if (!session) return bot.sendMessage(chatId, '⚠️ Kirim link drama dulu.');
    return sendInvoice(chatId, session?.meta?.title || 'VIP Access', `${session?.episodes?.length || 0} episode`, String(chatId), STAR_PRICE);
  }

  if (act === 'per_ep' || act === 'merge10') {
    if (!isAdmin(query.from.id)) {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ Hanya admin' }).catch(() => {}) || bot.sendMessage(chatId, '⚠️ Scraper khusus admin.');
    }
    if (!session) return bot.sendMessage(chatId, '⚠️ Session habis. Kirim ulang link.');
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    if (act === 'per_ep') return actionPerEpisode(chatId, session);
    return actionMerge10(chatId, session);
  }

  if (act === 'v_per_ep' || act === 'v_merge10' || act === 'vt_per_ep' || act === 'vt_merge10') {
    if (!isAdmin(query.from.id)) {
      return bot.answerCallbackQuery(query.id, { text: '⚠️ Hanya admin' }).catch(() => {}) || bot.sendMessage(chatId, '⚠️ Scraper khusus admin.');
    }
    if (!session) return bot.sendMessage(chatId, '⚠️ Session habis. Kirim ulang link.');
    await bot.deleteMessage(chatId, msgId).catch(() => {});
    if (act === 'v_per_ep') return actionVidaraPerEp(chatId, session);
    if (act === 'v_merge10') return actionVidaraMerge10(chatId, session);
    if (act === 'vt_per_ep') return actionVidaraAndTelegramPerEp(chatId, session);
    if (act === 'vt_merge10') return actionVidaraAndTelegramMerge10(chatId, session);
    return;
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
