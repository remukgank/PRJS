const { logger } = require('../logger');
const backpressure = require('./backpressure'); // upload accounting lapis 1
const { safeHtml, isTelegramBadRequest, sanitizeHtmlPayload, toPlainTextPayload } = require('./html');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parse flood limit Telegram: "Too Many Requests: retry after N" → N detik (ms)
function floodRetryMs(err) {
  const structuredRetryAfter = err?.response?.body?.parameters?.retry_after
    ?? err?.response?.parameters?.retry_after
    ?? err?.parameters?.retry_after;
  if (Number.isFinite(Number(structuredRetryAfter))) return Number(structuredRetryAfter) * 1000;
  const msg = err?.message?.description || err?.message || String(err || '');
  const m = msg.match(/retry after (\d+)/i);
  return m ? Number(m[1]) * 1000 : 0;
}

// Retry untuk error transient upload Telegram (bukan flood): error 500-inside TM
// semacam "Bad Request: internal Server Error during file upload" biasanya hilang
// sendiri; backoff tetap 3 s, kuota retry terpisah (max 2) dari flood.
function transientRetryMs(err) {
  const msg = err?.message?.description || err?.message || String(err || '');
  return /internal server error/i.test(msg) ? 3000 : 0;
}

// Ref file lokal untuk Local Bot API Server. Path/lokasi → prefiks `file://`;
// file_id Telegram / URL (http[s]) / attach:// dibiarkan apa adanya (jangan
// di-prefix — itu akan merusak file_id). Satu definisi, dipakai semua sender.
function toLocalFileRef(filePath) {
  if (typeof filePath !== 'string' || !filePath) return filePath;
  if (/^file:\/\//i.test(filePath)) return filePath;
  if (/^(https?:|attach:)/i.test(filePath)) return filePath;
  if (/^[/\\]|^\.{1,2}[/\\]/.test(filePath)) return `file://${filePath}`;
  return filePath; // sisanya dianggap file_id Telegram
}

// Config holder untuk apiPost + sender — di-init sekali dari bot.js facade
let _config = null;
let _bot = null;
const ANSWER_CALLBACK_WRAP_MARK = Symbol.for('prjs.telegram.answerCallbackQueryWrapped');
const HTML_SAFETY_WRAP_MARK = Symbol.for('prjs.telegram.htmlSafetyWrapped');
const HTML_TEXT_METHODS = [
  { name: 'sendMessage', textIndex: 1, optionsIndex: 2, key: 'text' },
  { name: 'editMessageText', textIndex: 0, optionsIndex: 1, key: 'text' },
  { name: 'editMessageCaption', textIndex: 0, optionsIndex: 1, key: 'caption' },
  { name: 'sendPhoto', textIndex: 2, optionsIndex: 3, key: 'caption' },
  { name: 'sendVideo', textIndex: 2, optionsIndex: 3, key: 'caption' },
  { name: 'sendDocument', textIndex: 2, optionsIndex: 3, key: 'caption' },
  { name: 'sendAudio', textIndex: 2, optionsIndex: 3, key: 'caption' },
  { name: 'sendAnimation', textIndex: 2, optionsIndex: 3, key: 'caption' },
  { name: 'sendVoice', textIndex: 2, optionsIndex: 3, key: 'caption' },
  { name: 'sendVideoNote', textIndex: 2, optionsIndex: 3, key: 'caption' },
];
const { setCachedFileId: _setCachedFileId } = require('../db');

function wrapHtmlSafety(bot) {
  if (!bot || bot[HTML_SAFETY_WRAP_MARK]) return;
  for (const spec of HTML_TEXT_METHODS) {
    const original = typeof bot[spec.name] === 'function' ? bot[spec.name].bind(bot) : null;
    if (!original) continue;
    bot[spec.name] = async (...args) => {
      const options = args[spec.optionsIndex];
      let touched = false;
      if (options && options.parse_mode === 'HTML' && typeof args[spec.textIndex] === 'string') {
        const cleaned = safeHtml(args[spec.textIndex]);
        if (cleaned !== args[spec.textIndex]) {
          args = args.slice();
          args[spec.textIndex] = cleaned;
          touched = true;
        }
      }
      try {
        return await original(...args);
      } catch (err) {
        if (!isTelegramBadRequest(err) || !options || options.parse_mode !== 'HTML') throw err;
        if (!isHtmlEntityError(err)) throw err;
        const fallback = args.slice();
        const plainOptions = { ...options };
        delete plainOptions.parse_mode;
        if (spec.key === 'caption') delete plainOptions.caption_entities;
        else delete plainOptions.entities;
        fallback[spec.optionsIndex] = plainOptions;
        logger.warn(
          { method: spec.name, err: err.message, sanitized: touched },
          'Telegram 400 pada parse_mode HTML — retry sebagai plain text'
        );
        return original(...fallback);
      }
    };
  }
  Object.defineProperty(bot, HTML_SAFETY_WRAP_MARK, { value: true, enumerable: false });
}

// Retry plain-text hanya berguna kalau 400-nya memang soal parse entities.
// "message is not modified" / "there is no text in the message to edit" adalah
// masalah lain (bukan HTML) — me-retry-nya hanya menghasilkan warning palsu.
function isHtmlEntityError(err) {
  const msg = String((err && err.message) || err || '');
  return /can't parse entities|can't parse message text|can't parse caption|unsupported start tag|unclosed tag|parse entities|entity parsing/i.test(msg);
}

function wrapAnswerCallbackQuery(bot, sleepFn = sleep) {
  if (!bot || typeof bot.answerCallbackQuery !== 'function' || bot[ANSWER_CALLBACK_WRAP_MARK]) return;

  const originalAnswerCallbackQuery = bot.answerCallbackQuery.bind(bot);
  bot.answerCallbackQuery = async (queryId, options) => {
    let attempt = 0;
    for (;;) {
      try {
        return await originalAnswerCallbackQuery(queryId, options);
      } catch (err) {
        const waitMs = floodRetryMs(err);
        if (waitMs <= 0 || attempt >= (_config?.API_MAX_RETRY || 0)) throw err;
        attempt += 1;
        logger.warn(
          { queryId, retryAfterMs: waitMs, attempt, err: err.message },
          'answerCallbackQuery flood — retry'
        );
        await sleepFn(waitMs + 500);
      }
    }
  };
  Object.defineProperty(bot, ANSWER_CALLBACK_WRAP_MARK, { value: true, enumerable: false });
}

function initTelegram(config) {
  // config: { TOKEN, API_BASE, API_HTTP, API_MAX_RETRY, bot, LOCAL_API_PORT }
  _config = config;
  if (config.bot) {
    _bot = config.bot;
    wrapAnswerCallbackQuery(config.bot);
    wrapHtmlSafety(config.bot);
  }
}
function ensureSender(caller) {
  if (!_config || !_bot) throw new Error(`lib/telegram belum di-init — panggil initTelegram({ TOKEN, API_BASE, ..., bot }) dulu (dari ${caller})`);
}

// Retry upload media: flood 429 pakai kuota API_MAX_RETRY; transient (internal
// server error) kuota tetap 2. Non-retryable error langsung di-throw.
async function withUploadRetry(label, sendFn) {
  let attempt = 0;
  for (;;) {
    try {
      return await sendFn();
    } catch (err) {
      let waitMs = floodRetryMs(err);
      let maxAttempt = _config.API_MAX_RETRY || 0;
      if (!waitMs) {
        waitMs = transientRetryMs(err);
        maxAttempt = 2;
      }
      if (waitMs > 0 && attempt < maxAttempt) {
        attempt += 1;
        logger.warn({ retryMs: waitMs, attempt, err: err.message }, `${label} upload — retry`);
        await sleep(waitMs + 500);
        continue;
      }
      throw err;
    }
  }
}

// Kirim via apiPost dengan retry: flood 429 (retry_after) atau transient
// (internal server error). Kuota terpisah: flood ~ API_MAX_RETRY, transient ~ 2.
function apiPost(method, payload, _retry, _transient, _htmlFallbackDone) {
  if (!_config) throw new Error('lib/telegram belum di-init — panggil initTelegram({ TOKEN, API_BASE, ..., bot }) dulu');
  const { TOKEN, API_BASE, API_HTTP, API_MAX_RETRY } = _config;
  if (_retry === undefined) _retry = API_MAX_RETRY;
  if (_transient === undefined) _transient = 2;
  const outgoing = sanitizeHtmlPayload(payload);
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(outgoing);
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
            err.telegramErrorCode = json.error_code;
            const floodMs = floodRetryMs(err);
            const transientMs = floodMs ? 0 : transientRetryMs(err);
            if (floodMs > 0 && _retry > 0) {
              logger.warn({ method, retryAfterMs: floodMs, remaining: _retry, err: err.message }, 'apiPost flood — retry');
              await sleep(floodMs + 500);
              resolve(await apiPost(method, payload, _retry - 1, _transient, _htmlFallbackDone));
            } else if (transientMs > 0 && _transient > 0) {
              logger.warn({ method, retryMs: transientMs, remaining: _transient, err: err.message }, 'apiPost transient — retry');
              await sleep(transientMs + 500);
              resolve(await apiPost(method, payload, _retry, _transient - 1, _htmlFallbackDone));
            } else if (
              !_htmlFallbackDone
              && json.error_code === 400
              && outgoing.parse_mode === 'HTML'
              && isHtmlEntityError({ message: json.description || '' })
            ) {
              logger.warn({ method, err: err.message }, 'apiPost 400 pada parse_mode HTML — retry sebagai plain text');
              resolve(await apiPost(method, toPlainTextPayload(outgoing), _retry, _transient, true));
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
  ensureSender('sendVideo');
  const { caption, supports_streaming, duration, width, height, message_thread_id, parse_mode } = opts;
  const cap = caption ? caption.slice(0, 1024) : undefined;
  const result = await withUploadRetry('sendVideo', () =>
    _config.LOCAL_API_PORT
      ? apiPost('sendVideo', {
          chat_id: chatId,
          video: toLocalFileRef(filePath),
          caption: cap,
          parse_mode,
          supports_streaming,
          ...(message_thread_id && { message_thread_id }),
          ...(duration && { duration }),
          ...(width && { width }),
          ...(height && { height }),
        })
      : _bot.sendVideo(chatId, filePath, {
          caption: cap,
          parse_mode,
          supports_streaming,
          ...(message_thread_id && { message_thread_id }),
          ...(duration && { duration }),
          ...(width && { width }),
          ...(height && { height }),
        })
  );
  if (cacheInfo) {
    const fileId = result?.video?.file_id;
    if (fileId) _setCachedFileId(cacheInfo.urlHash, cacheInfo.source, fileId, 'video', cacheInfo.fileName).catch(() => {});
  }
  return result;
}

async function sendAudio(chatId, filePath, opts = {}, cacheInfo = null) {
  ensureSender('sendAudio');
  const { caption } = opts;
  const cap = caption ? caption.slice(0, 1024) : undefined;
  const result = await withUploadRetry('sendAudio', () =>
    _config.LOCAL_API_PORT
      ? apiPost('sendAudio', {
          chat_id: chatId,
          audio: toLocalFileRef(filePath),
          caption: cap,
        })
      : _bot.sendAudio(chatId, filePath, { caption: cap })
  );
  if (cacheInfo) {
    const fileId = result?.audio?.file_id;
    if (fileId) _setCachedFileId(cacheInfo.urlHash, cacheInfo.source, fileId, 'audio', cacheInfo.fileName).catch(() => {});
  }
  return result;
}

async function sendDocument(chatId, filePath, opts = {}, cacheInfo = null) {
  ensureSender('sendDocument');
  const { caption } = opts;
  const cap = caption ? caption.slice(0, 1024) : undefined;
  const result = await withUploadRetry('sendDocument', () =>
    _config.LOCAL_API_PORT
      ? apiPost('sendDocument', {
          chat_id: chatId,
          document: toLocalFileRef(filePath),
          caption: cap,
        })
      : _bot.sendDocument(chatId, filePath, { caption: cap })
  );
  if (cacheInfo) {
    const fileId = result?.document?.file_id;
    if (fileId) _setCachedFileId(cacheInfo.urlHash, cacheInfo.source, fileId, 'document', cacheInfo.fileName).catch(() => {});
  }
  return result;
}

async function sendPhoto(chatId, filePath, opts = {}) {
  ensureSender('sendPhoto');
  const { caption, message_thread_id } = opts;
  const cap = caption ? caption.slice(0, 1024) : undefined;
  return _config.LOCAL_API_PORT
? await apiPost('sendPhoto', {
          chat_id: chatId,
          photo: toLocalFileRef(filePath),
          caption: cap,
        parse_mode: 'HTML',
        ...(message_thread_id && { message_thread_id }),
      })
    : await _bot.sendPhoto(chatId, filePath, {
        caption: cap,
        parse_mode: 'HTML',
        ...(message_thread_id && { message_thread_id }),
      });
}

module.exports = {
  sleep,
  floodRetryMs,
  transientRetryMs,
  toLocalFileRef,
  wrapAnswerCallbackQuery,
  initTelegram,
  apiPost,
  // Upload accounting: semua kiriman file lokal lewat sini (lihat
  // lib/backpressure.js §cakupan). track() hanya hitung, tak ubah logic.
  sendVideo: (chatId, filePath, opts, cacheInfo) => backpressure.track(sendVideo(chatId, filePath, opts, cacheInfo), filePath),
  sendAudio: (chatId, filePath, opts, cacheInfo) => backpressure.track(sendAudio(chatId, filePath, opts, cacheInfo), filePath),
  sendDocument: (chatId, filePath, opts, cacheInfo) => backpressure.track(sendDocument(chatId, filePath, opts, cacheInfo), filePath),
  sendPhoto: (chatId, filePath, opts) => backpressure.track(sendPhoto(chatId, filePath, opts), filePath),
};
