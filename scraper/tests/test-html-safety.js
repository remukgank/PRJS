'use strict';

// Unit test: lapisan keamanan HTML terpusat (scraper/lib/html.js + wrapper di lib/telegram.js)
// Melindungi semua path kirim ber-parse_mode HTML dari 400 "can't parse entities".

const assert = require('assert');
const http = require('http');
const { safeHtml, escapeHtml, isTelegramBadRequest, sanitizeHtmlPayload, toPlainTextPayload, ALLOWED_TAGS } = require('../lib/html');
const telegramLib = require('../lib/telegram');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { const r = fn(); if (r && typeof r.then === 'function') return r.then(() => { passed++; console.log(`PASS  ${name}`); }, (e) => { failed++; console.error(`FAIL  ${name}: ${e.message}`); }); passed++; console.log(`PASS  ${name}`); return null; }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); return null; }
}

(async () => {
  t('safeHtml: & telanjang di-escape', () => assert.strictEqual(safeHtml('Tom & Jerry'), 'Tom &amp; Jerry'));
  t('safeHtml: < > di luar tag di-escape', () => assert.strictEqual(safeHtml('5 < 6 > 2'), '5 &lt; 6 &gt; 2'));
  t('safeHtml: tag sah dipertahankan (b/i/code/pre/tg-spoiler/a/blockquote)', () => {
    for (const tag of ['b', 'i', 'code', 'pre', 'tg-spoiler', 'a', 'blockquote']) {
      const html = `<${tag}>x</${tag}>`;
      assert.strictEqual(safeHtml(html), html, `tag ${tag} harus utuh`);
    }
  });
  t('safeHtml: entitas valid dipertahankan (&amp; &lt; &#128512; &#x1F600;)', () => {
    assert.strictEqual(safeHtml('a &amp; b &#128512; &#x1F600; &lt;'), 'a &amp; b &#128512; &#x1F600; &lt;');
  });
  t('safeHtml: tag tak ditutup → auto-close', () => assert.strictEqual(safeHtml('<b>tebal'), '<b>tebal</b>'));
  t('safeHtml: nesting salah → dirapikan (Telegram butuh nesting valid)', () => {
    assert.strictEqual(safeHtml('<b><i>x</b></i>'), '<b><i>x</i></b>&lt;/i&gt;');
  });
  t('safeHtml: tag tak didukung di-escape jadi teks (tak hilang)', () => {
    assert.strictEqual(safeHtml('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
  });
  t('safeHtml: tag penutup liar jadi teks', () => assert.strictEqual(safeHtml('</b> liar'), '&lt;/b&gt; liar'));
  t('safeHtml: input non-string & null aman', () => {
    assert.strictEqual(safeHtml(null), null);
    assert.strictEqual(safeHtml(42), 42);
  });
  t('escapeHtml: helper lama konsisten', () => assert.strictEqual(escapeHtml('a & "b" <c>'), 'a &amp; &quot;b&quot; &lt;c&gt;'));
  t('ALLOWED_TAGS hanya berisi tag resmi (tanpa tag karangan)', () => {
    for (const tag of ALLOWED_TAGS) assert.ok(/^(b|strong|i|em|u|ins|s|strike|del|span|tg-spoiler|a|tg-emoji|tg-time|code|pre|blockquote)$/.test(tag), tag);
  });

  t('isTelegramBadRequest: TelegramError library (response.body.error_code=400)', () => {
    const err = Object.assign(new Error('400 Bad Request: can\'t parse entities'), { code: 'ETELEGRAM', response: { status: 400, body: { ok: false, error_code: 400 } } });
    assert.strictEqual(isTelegramBadRequest(err), true);
  });
  t('isTelegramBadRequest: apiPost error (telegramErrorCode=400)', () => {
    const err = new Error('Bad Request: can\'t parse entities');
    err.telegramErrorCode = 400;
    assert.strictEqual(isTelegramBadRequest(err), true);
  });
  t('isTelegramBadRequest: 429 & error lain = false', () => {
    assert.strictEqual(isTelegramBadRequest(Object.assign(new Error('x'), { code: 'ETELEGRAM', response: { status: 429, body: { error_code: 429 } } })), false);
    assert.strictEqual(isTelegramBadRequest(new Error('socket hang up')), false);
    assert.strictEqual(isTelegramBadRequest(null), false);
  });

  t('sanitizeHtmlPayload: text/caption di-sanitize hanya saat parse_mode HTML', () => {
    const a = sanitizeHtmlPayload({ chat_id: 1, text: 'a & b', parse_mode: 'HTML' });
    assert.strictEqual(a.text, 'a &amp; b');
    const b = sanitizeHtmlPayload({ chat_id: 1, text: 'a & b' });
    assert.strictEqual(b.text, 'a & b');
    const c = sanitizeHtmlPayload({ chat_id: 1, caption: 'x < y', parse_mode: 'HTML' });
    assert.strictEqual(c.caption, 'x &lt; y');
  });
  t('toPlainTextPayload: parse_mode dibuang, teks tetap aman', () => {
    const p = toPlainTextPayload({ chat_id: 1, text: 'a & b', parse_mode: 'HTML' });
    assert.ok(!('parse_mode' in p));
    assert.strictEqual(p.text, 'a &amp; b');
  });

  await t('wrapper bot: pesan invalid di-sanitize sebelum dikirim', async () => {
    const calls = [];
    const fakeBot = { sendMessage: (chatId, text, options) => { calls.push({ text, options }); return Promise.resolve({ message_id: 1 }); } };
    telegramLib.initTelegram({ TOKEN: 'x', API_BASE: 'http://127.0.0.1:1', API_HTTP: http, API_MAX_RETRY: 0, bot: fakeBot });
    await fakeBot.sendMessage(1, 'Tom & Jerry <b>film</b>', { parse_mode: 'HTML' });
    assert.strictEqual(calls[0].text, 'Tom &amp; Jerry <b>film</b>');
    assert.strictEqual(calls[0].options.parse_mode, 'HTML');
  });

  await t('wrapper bot: 400 → retry sekali sebagai plain text', async () => {
    const calls = [];
    const fakeBot = {
      sendMessage: (chatId, text, options) => {
        calls.push({ text, options });
        if (options.parse_mode === 'HTML') {
          const err = new Error("400 Bad Request: can't parse entities: Unsupported start tag");
          err.code = 'ETELEGRAM';
          err.response = { status: 400, body: { ok: false, error_code: 400, description: "can't parse entities" } };
          return Promise.reject(err);
        }
        return Promise.resolve({ message_id: 2 });
      },
    };
    telegramLib.initTelegram({ TOKEN: 'x', API_BASE: 'http://127.0.0.1:1', API_HTTP: http, API_MAX_RETRY: 0, bot: fakeBot });
    const res = await fakeBot.sendMessage(1, 'x <bad> & y', { parse_mode: 'HTML' });
    assert.strictEqual(res.message_id, 2);
    assert.strictEqual(calls.length, 2, 'harus 2 percobaan');
    assert.ok(!('parse_mode' in calls[1].options), 'retry tanpa parse_mode');
  });

  await t('wrapper bot: error non-400 dilempar apa adanya (tanpa retry)', async () => {
    let attempts = 0;
    const fakeBot = {
      sendPhoto: (chatId, photo, options) => {
        attempts++;
        const err = new Error('429 flood');
        err.code = 'ETELEGRAM';
        err.response = { status: 429, body: { error_code: 429, parameters: { retry_after: 1 } } };
        return Promise.reject(err);
      },
    };
    telegramLib.initTelegram({ TOKEN: 'x', API_BASE: 'http://127.0.0.1:1', API_HTTP: http, API_MAX_RETRY: 0, bot: fakeBot });
    await assert.rejects(() => fakeBot.sendPhoto(1, 'file_id', { caption: 'a & b', parse_mode: 'HTML' }));
    assert.strictEqual(attempts, 1, '429 tak boleh memicu retry plain-text');
  });

  t('anti-drift: initTelegram memasang wrapHtmlSafety', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'telegram.js'), 'utf8');
    assert.ok(src.includes('wrapHtmlSafety(config.bot)'), 'initTelegram harus pasang wrapper');
    assert.ok(src.includes('400 pada parse_mode HTML — retry sebagai plain text'), 'retry plain-text harus ada');
  });

  await t('apiPost: 400 pada parse_mode HTML → retry plain text via HTTP nyata', async () => {
    const received = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const payload = JSON.parse(body || '{}');
        received.push(payload);
        if (payload.parse_mode === 'HTML') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: Unsupported start tag" }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { message_id: 77 } }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    telegramLib.initTelegram({ TOKEN: 'test-token', API_BASE: `http://127.0.0.1:${port}`, API_HTTP: http, API_MAX_RETRY: 1 });
    try {
      const result = await telegramLib.apiPost('sendMessage', { chat_id: 1, text: 'Film <bad> & keseruan', parse_mode: 'HTML' });
      assert.strictEqual(result.message_id, 77);
      assert.strictEqual(received.length, 2, 'percobaan pertama (HTML) + fallback (plain)');
      assert.strictEqual(received[0].parse_mode, 'HTML');
      assert.strictEqual(received[0].text, 'Film &lt;bad&gt; &amp; keseruan', 'payload pertama sudah di-sanitasi');
      assert.ok(!('parse_mode' in received[1]), 'fallback tanpa parse_mode');
    } finally {
      server.close();
    }
  });

  t('anti-drift: bot.js rich message html di-sanitasi', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'bot.js'), 'utf8');
    const hits = (src.match(/format === 'html' \? safeHtml\(content\) : content/g) || []).length;
    assert.ok(hits >= 2, 'sendRichMessage & sendRichMessageDraft harus sanitize (ditemukan: ' + hits + ')');
  });

  console.log(`RESULT: ${passed} pass, ${failed} fail`);
  process.exit(failed ? 1 : 0);
})();
