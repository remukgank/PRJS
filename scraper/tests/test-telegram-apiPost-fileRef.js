const assert = require('node:assert/strict');
const http = require('node:http');
const {
  initTelegram,
  sendVideo,
  apiPost,
  transientRetryMs,
  toLocalFileRef,
} = require('../lib/telegram');

// ── unit: toLocalFileRef ────────────────────────────────────────────────
assert.equal(toLocalFileRef('/tmp/a.mp4'), 'file:///tmp/a.mp4');
assert.equal(toLocalFileRef('./rel.mp4'), 'file://./rel.mp4');
assert.equal(toLocalFileRef('file:///tmp/a.mp4'), 'file:///tmp/a.mp4');
assert.equal(toLocalFileRef('BAACAgQAAxkBAAId-video-file-id'), 'BAACAgQAAxkBAAId-video-file-id');
assert.equal(toLocalFileRef('https://x.example/p.jpg'), 'https://x.example/p.jpg');
assert.equal(toLocalFileRef('attach://file-1'), 'attach://file-1');
assert.equal(toLocalFileRef(123), 123);
assert.equal(transientRetryMs(new Error('Bad Request: internal Server Error during file upload')), 3000);
console.log('toLocalFileRef unit: 8/8 passed');

// ── stub Local Bot API server ───────────────────────────────────────────
function makeServer(handler) {
  const attempts = { count: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      attempts.count += 1;
      handler({ res, body, method: req.url.split('/').pop(), attempts });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, attempts, port: server.address().port }));
  });
}
function reply(res, json) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(json));
}

async function run() {
  // ── apiPost transient 2x → resolve di attempt ke-3 ──────────────────
  const s1 = await makeServer(({ res, attempts }) => {
    if (attempts.count <= 2) reply(res, { ok: false, description: 'Bad Request: internal Server Error during file upload' });
    else reply(res, { ok: true, result: { video: { file_id: 'f-v' } } });
  });
  initTelegram({ TOKEN: 'TEST', API_BASE: `http://127.0.0.1:${s1.port}`, API_HTTP: http, API_MAX_RETRY: 3, bot: {} });
  const result = await apiPost('sendVideo', { chat_id: 1, video: 'file:///tmp/a.mp4' });
  assert.equal(result.video.file_id, 'f-v');
  assert.equal(s1.attempts.count, 3);
  s1.server.close();

  // ── apiPost transient habis kuota (2) → reject, 3 call ──────────────
  const s2 = await makeServer(({ res }) => {
    reply(res, { ok: false, description: 'Bad Request: internal Server Error during file upload' });
  });
  initTelegram({ TOKEN: 'TEST', API_BASE: `http://127.0.0.1:${s2.port}`, API_HTTP: http, API_MAX_RETRY: 3, bot: {} });
  await assert.rejects(() => apiPost('sendVideo', { chat_id: 1, video: 'file:///tmp/a.mp4' }), /internal Server Error/);
  assert.equal(s2.attempts.count, 3);
  s2.server.close();

  // ── apiPost non-transient → 1 call, langsung reject ─────────────────
  const s3 = await makeServer(({ res }) => {
    reply(res, { ok: false, description: 'Bad Request: file is too big' });
  });
  initTelegram({ TOKEN: 'TEST', API_BASE: `http://127.0.0.1:${s3.port}`, API_HTTP: http, API_MAX_RETRY: 3, bot: {} });
  await assert.rejects(() => apiPost('sendVideo', { chat_id: 1, video: 'file:///tmp/a.mp4' }), /file is too big/);
  assert.equal(s3.attempts.count, 1);
  s3.server.close();

  // ── sendVideo local-leg: path → file:// ref; file_id → raw tanpa prefix
  const seen = [];
  const s4 = await makeServer(({ res, body }) => {
    seen.push(JSON.parse(body));
    reply(res, { ok: true, result: { video: { file_id: 'f-ok' } } });
  });
  initTelegram({ TOKEN: 'TEST', API_BASE: `http://127.0.0.1:${s4.port}`, API_HTTP: http, API_MAX_RETRY: 3, bot: {}, LOCAL_API_PORT: 9099 });
  await sendVideo(1, '/tmp/real.mp4', { caption: 'x' });
  await sendVideo(1, 'BAAC-agQAAxkB-file-id', { caption: 'y' });
  assert.equal(seen[0].video, 'file:///tmp/real.mp4');
  assert.equal(seen[1].video, 'BAAC-agQAAxkB-file-id');
  s4.server.close();

  console.log('apiPost transient + fileRef local-leg: 4/4 passed (path→file://, file_id→raw)');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});