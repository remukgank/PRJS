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

// Config holder untuk apiPost — di-init sekali dari bot.js facade
let _config = null;
function initTelegram(config) {
  // config: { TOKEN, API_BASE, API_HTTP, API_MAX_RETRY }
  _config = config;
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

module.exports = { sleep, floodRetryMs, initTelegram, apiPost };
