const { logger } = require('../logger');

let _bot = null;
let _config = null;

function initProgress(deps) {
  // deps: { bot, config: { TOKEN, API_BASE, API_HTTP, LOCAL_API_PORT } }
  _bot = deps.bot;
  _config = deps.config;
}

function ensureInit(caller) {
  if (!_bot || !_config) throw new Error(`lib/progress belum di-init — panggil initProgress({ bot, config }) dulu (dari ${caller})`);
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

class Progress {
  constructor(chatId, text) {
    ensureInit('Progress.constructor');
    this.chatId = chatId;
    this.text = text;
    this.msgId = null;
    this.frame = 0;
    this.t0 = Date.now();
    this.timer = null;
    this.editing = false;
  }

  async start() {
    ensureInit('Progress.start');
    try {
      const msg = await _bot.sendMessage(this.chatId, this.render(), { parse_mode: 'HTML' });
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
      await _bot.editMessageText(this.render(), {
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
      await _bot.editMessageText(`✅ ${text}\n⏱ ${mm}:${ss}`, {
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
      await _bot.editMessageText(`❌ ${text}\n⏱ ${mm}:${ss}`, {
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
    ensureInit('RichProgress.constructor');
    this.chatId = chatId;
    this.title = title;
    this.msgId = null;
    this.t0 = Date.now();
    this.timer = null;
    this.editing = false;
    this.isParts = !!opts.isParts;

    this.episodes = episodes.map(ep => ({
      ep: ep.ep || ep,
      label: this.isParts ? (ep.label || null) : null,
      status: 'pending',
      detail: '',
      size: 0,
    }));
    this.notes = [];
    this.totalEpisodes = opts.totalEpisodes || null;
  }

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
    const { TOKEN, LOCAL_API_PORT } = _config;
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
    ensureInit('RichProgress.start');
    try {
      const baseUrl = _config.LOCAL_API_PORT
        ? `http://127.0.0.1:${_config.LOCAL_API_PORT}`
        : 'https://api.telegram.org';
      const http = require(_config.LOCAL_API_PORT ? 'http' : 'https');
      const htmlContent = this.renderRichMessage();

      const payload = JSON.stringify({
        chat_id: this.chatId,
        rich_message: { html: htmlContent },
      });

      const msg = await new Promise((resolve, reject) => {
        const url = `${baseUrl}/bot${_config.TOKEN}/sendRichMessage`;
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
      try {
        const msg = await _bot.sendMessage(this.chatId, this.render(), { parse_mode: 'HTML' });
        this.msgId = msg.message_id;
      } catch {}
    }
    this.timer = setInterval(() => this.tick(), 5000);
    return this;
  }

  async tick() {
    ensureInit('RichProgress.tick');
    if (this.editing || !this.msgId) return;
    this.editing = true;
    try {
      const baseUrl = _config.LOCAL_API_PORT
        ? `http://127.0.0.1:${_config.LOCAL_API_PORT}`
        : 'https://api.telegram.org';
      const http = require(_config.LOCAL_API_PORT ? 'http' : 'https');
      const htmlContent = this.renderRichMessage();

      const payload = JSON.stringify({
        chat_id: this.chatId,
        message_id: this.msgId,
        rich_message: { html: htmlContent },
      });

      await new Promise((resolve, reject) => {
        const url = `${baseUrl}/bot${_config.TOKEN}/editMessageText`;
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
      try {
        await _bot.editMessageText(this.render(), {
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
    ensureInit('RichProgress.done');
    clearInterval(this.timer);
    const sec = Math.floor((Date.now() - this.t0) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');

    const doneCount = this.episodes.filter(e => e.status === 'done').length;
    const failCount = this.episodes.filter(e => e.status === 'fail').length;

    logger.info({ chatId: this.chatId, duration: sec, done: doneCount, fail: failCount }, 'RichProgress done');

    if (note) this.notes.push(note);
    const htmlContent = this.renderRichDone();

    for (let i = 0; i < 20 && this.editing; i++) await new Promise(r => setTimeout(r, 100));

    if (this.msgId) {
      try {
        await this._richRequest('editMessageText', {
          chat_id: this.chatId,
          message_id: this.msgId,
          rich_message: { html: htmlContent },
        });
      } catch (err) {
        logger.warn({ chatId: this.chatId, err: err.message }, 'RichProgress done edit failed, fallback _internalSendRichMessage');
        try { await _internalSendRichMessage(this.chatId, htmlContent); } catch {}
      }
    } else {
      try { await _internalSendRichMessage(this.chatId, htmlContent); } catch {}
    }
  }
}

// _internalSendRichMessage tetap privat — jangan export, agar tidak bentrok
// dengan sendRichMessage(chatId, content, opts) yang ada di bot.js (AI chat).
async function _internalSendRichMessage(chatId, htmlContent) {
  ensureInit('_internalSendRichMessage');
  const { TOKEN, LOCAL_API_PORT } = _config;
  const baseUrl = LOCAL_API_PORT ? `http://127.0.0.1:${LOCAL_API_PORT}` : 'https://api.telegram.org';
  const http = require(LOCAL_API_PORT ? 'http' : 'https');
  const payload = JSON.stringify({ chat_id: chatId, rich_message: { html: htmlContent } });
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}/bot${TOKEN}/sendRichMessage`, {
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
}

module.exports = { initProgress, Progress, RichProgress };
