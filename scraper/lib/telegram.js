const { logger } = require('../logger');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parse flood limit Telegram: "Too Many Requests: retry after N" → N detik (ms)
function floodRetryMs(err) {
  const msg = err?.message?.description || err?.message || String(err || '');
  const m = msg.match(/retry after (\d+)/i);
  return m ? Number(m[1]) * 1000 : 0;
}

// Config holder untuk apiPost + sender — di-init sekali dari bot.js facade
let _config = null;
let _bot = null;
const { setCachedFileId: _setCachedFileId } = require('../db');
function initTelegram(config) {
  // config: { TOKEN, API_BASE, API_HTTP, API_MAX_RETRY, bot, LOCAL_API_PORT }
  _config = config;
  if (config.bot) _bot = config.bot;
}
function ensureSender(caller) {
  if (!_config || !_bot) throw new Error(`lib/telegram belum di-init — panggil initTelegram({ TOKEN, API_BASE, ..., bot }) dulu (dari ${caller})`);
}

// Kirim via apiPost dengan retry saat flood 429 (tunggu retry_after lalu ulang).
function apiPost(method, payload, _retry) {
  if (!_config) throw new Error('lib/telegram belum di-init — panggil initTelegram({ TOKEN, API_BASE, API_HTTP, API_MAX_RETRY }) dulu');
  const { TOKEN, API_BASE, API_HTTP, API_MAX_RETRY } = _config;
  if (_retry === undefined) _retry = API_MAX_RETRY;
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
  ensureSender('sendVideo');
  const { caption, supports_streaming, duration, width, height, message_thread_id, parse_mode } = opts;
  const cap = caption ? caption.slice(0, 1024) : undefined;
  let result;
  let attempt = 0;
  for (;;) {
    try {
      result = _config.LOCAL_API_PORT
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
        : await _bot.sendVideo(chatId, filePath, {
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
      if (waitMs > 0 && attempt < _config.API_MAX_RETRY) {
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
    if (fileId) _setCachedFileId(cacheInfo.urlHash, cacheInfo.source, fileId, 'video', cacheInfo.fileName).catch(() => {});
  }
  return result;
}

async function sendAudio(chatId, filePath, opts = {}, cacheInfo = null) {
  ensureSender('sendAudio');
  const { caption } = opts;
  const cap = caption ? caption.slice(0, 1024) : undefined;
  const result = _config.LOCAL_API_PORT
    ? await apiPost('sendAudio', {
        chat_id: chatId,
        audio: `file://${filePath}`,
        caption: cap,
      })
    : await _bot.sendAudio(chatId, filePath, { caption: cap });
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
  const result = _config.LOCAL_API_PORT
    ? await apiPost('sendDocument', {
        chat_id: chatId,
        document: `file://${filePath}`,
        caption: cap,
      })
    : await _bot.sendDocument(chatId, filePath, { caption: cap });
  if (cacheInfo) {
    const fileId = result?.document?.file_id;
    if (fileId) _setCachedFileId(cacheInfo.urlHash, cacheInfo.source, fileId, 'document', cacheInfo.fileName).catch(() => {});
  }
  return result;
}

async function sendPhoto(chatId, filePath, opts = {}) {
  ensureSender('sendPhoto');
  const { caption } = opts;
  const cap = caption ? caption.slice(0, 1024) : undefined;
  return _config.LOCAL_API_PORT
    ? await apiPost('sendPhoto', {
        chat_id: chatId,
        photo: `file://${filePath}`,
        caption: cap,
        parse_mode: 'HTML',
      })
    : await _bot.sendPhoto(chatId, filePath, { caption: cap, parse_mode: 'HTML' });
}

module.exports = { sleep, floodRetryMs, initTelegram, apiPost, sendVideo, sendAudio, sendDocument, sendPhoto };
