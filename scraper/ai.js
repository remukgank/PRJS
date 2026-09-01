const axios = require('axios');
const { logger } = require('./logger');

function normalizeEndpoint(url) {
  let ep = String(url).trim().replace(/\/+$/, '');
  if (ep.includes('/chat/completions')) return ep;
  if (/^https?:\/\/[^\/]+$/.test(ep)) return ep + '/v1/chat/completions';
  if (/\/v1$/.test(ep)) return ep + '/chat/completions';
  return ep + '/chat/completions';
}

function getEndpoint(opts = {}) {
  const raw = opts.endpoint || process.env.AI_ENDPOINT || process.env.OPENCODE_ZEN_URL || null;
  return raw ? normalizeEndpoint(raw) : null;
}

function getApiKey(opts = {}) {
  return opts.apiKey || process.env.AI_API_KEY || process.env.OPENCODE_API_KEY || null;
}
function getApiKeys(opts = {}) {
  const raw = getApiKey(opts);
  if (!raw) return [null];
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}

function generateSessionId() {
  return `tg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const SYSTEM_PROMPT = `Kamu adalah Hokireceh (panggil saja Hoki), admin yang membantu user. Jawab dengan ramah seperti manusia, dalam Bahasa Indonesia.
Gunakan formatting markdown untuk response yang lebih baik:
- **bold** untuk judul/penekanan
- *italic* untuk istilah teknis
- \`code\` untuk inline code
- \`\`\` untuk code block
- Gunakan list (bullet point) untuk penjelasan bertahap
- Berikan contoh jika relevan
Jangan gunakan HTML, cukup markdown saja.
Jangan pernah menyebut bahwa kamu adalah AI, asisten AI, atau bot. Cukup jawab sebagai Hoki.
Jangan gunakan frasa "Sebagai AI" atau "saya adalah AI" atau sejenisnya.`;

function extractText(msg) {
  if (msg.content) return msg.content;
  if (msg.reasoning_content) return msg.reasoning_content;
  if (msg.reasoning) return msg.reasoning;
  return '';
}

function resolveModels(opts = {}) {
  const primary = opts.model || process.env.AI_MODEL || process.env.OPENCODE_MODEL;
  if (primary) {
    const ids = String(primary).split(',').map(s => s.replace('opencode/', '').trim()).filter(Boolean);
    if (ids.length) return ids;
  }
  const fallbackEnv = process.env.AI_FALLBACK_MODELS || process.env.OPENCODE_FALLBACK_MODELS;
  if (fallbackEnv) return fallbackEnv.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

async function runModel(model, messages, opts = {}) {
  const { timeout = 60000 } = opts;
  const endpoint = getEndpoint(opts);
  if (!endpoint) {
    throw new Error('AI endpoint belum dikonfigurasi. Admin: set di 🛠 Admin Panel → 🤖 AI Endpoint atau /setai <url> [model]');
  }
  if (!model) {
    throw new Error('AI model belum dikonfigurasi. Set via /setai <url> <model> atau env AI_MODEL');
  }

  const body = {
    model,
    messages,
    max_tokens: 2048,
  };

  // Support multi API key — coba satu per satu jika 401/429/403 atau key-related error
  const apiKeys = getApiKeys(opts);
  let lastRes = null;
  let lastErrMsg = null;
  for (const apiKey of apiKeys) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await axios.post(endpoint, body, {
      timeout,
      headers,
      validateStatus: () => true,
    });
    if (res.status === 200) {
      const choice = res.data?.choices?.[0];
      if (!choice?.message) throw new Error('Empty response from model');
      const text = extractText(choice.message).trim();
      if (!text) throw new Error('Empty content from model');
      return { text };
    }
    const errMsg = res.data?.error?.message || res.data?.error || `HTTP ${res.status}`;
    const isKeyError = res.status === 401 || res.status === 403 || res.status === 429 || /api key|unauthorized|quota|rate limit|We can't serve/i.test(errMsg);
    if (isKeyError && apiKeys.length > 1) {
      logger.warn({ model, keyPrefix: apiKey ? apiKey.slice(0, 8) + '…' : 'none', err: errMsg }, 'API key failed, trying next key');
      lastErrMsg = errMsg;
      lastRes = res;
      continue;
    }
    throw new Error(errMsg);
  }
  throw new Error(lastErrMsg || `HTTP ${lastRes?.status || 500}`);
}

function buildMessages(question, opts = {}) {
  if (opts.images && opts.images.length) {
    const content = [];
    const q = (question || '').trim() || 'Jelaskan gambar ini.';
    content.push({ type: 'text', text: q });
    for (const img of opts.images) {
      content.push({ type: 'image_url', image_url: { url: img } });
    }
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
    ];
  }
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question },
  ];
}

async function ask(question, opts = {}) {
  const messages = buildMessages(question, opts);
  const models = resolveModels(opts);
  if (!models.length) {
    throw new Error('AI model belum dikonfigurasi. Set via /setai <url> <model> atau env AI_MODEL');
  }
  let lastErr;

  for (const model of models) {
    try {
      return await runModel(model, messages, opts);
    } catch (err) {
      lastErr = err;
      logger.warn({ model, err: err.message }, 'Model failed, trying next');
    }
  }

  throw lastErr || new Error('All fallback models failed');
}

async function askStream(question, onToken, opts = {}) {
  const messages = buildMessages(question, opts);
  const models = resolveModels(opts);
  if (!models.length) {
    throw new Error('AI model belum dikonfigurasi. Set via /setai <url> <model> atau env AI_MODEL');
  }
  let lastErr;

  for (const model of models) {
    try {
      const result = await runModel(model, messages, opts);
      if (onToken && result.text) {
        onToken(result.text);
      }
      return result;
    } catch (err) {
      lastErr = err;
      logger.warn({ model, err: err.message }, 'Model failed, trying next');
    }
  }

  throw lastErr || new Error('All fallback models failed');
}

module.exports = { ask, askStream, generateSessionId };
