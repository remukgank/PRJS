const assert = require('node:assert/strict');
const {
  initTelegram,
  sendVideo,
  sendAudio,
  sendDocument,
  floodRetryMs,
  transientRetryMs,
} = require('../lib/telegram');

function transientErr() {
  return new Error('Bad Request: internal Server Error during file upload');
}
function tooBigErr() {
  return new Error('Bad Request: file is too big');
}
function floodErr(retryAfter = 2) {
  const err = new Error('Too Many Requests');
  err.response = { body: { parameters: { retry_after: retryAfter } } };
  return err;
}

function freshBot(methods) {
  const calls = { video: 0, audio: 0, document: 0 };
  const bot = {
    sendVideo: async function () { calls.video += 1; return methods.video(calls.video); },
    sendAudio: async function () { calls.audio += 1; return methods.audio(calls.audio); },
    sendDocument: async function () { calls.document += 1; return methods.document(calls.document); },
  };
  initTelegram({ API_MAX_RETRY: 2, bot });
  return { bot, calls };
}

async function run() {
  // ── unit: matcher ────────────────────────────────────────────────
  assert.equal(transientRetryMs(transientErr()), 3000);
  assert.equal(transientRetryMs(tooBigErr()), 0);
  assert.equal(transientRetryMs(new Error('network failure')), 0);
  assert.equal(transientRetryMs('bad request: internal server error during file upload'), 3000);
  assert.equal(floodRetryMs(transientErr()), 0);
  assert.equal(floodRetryMs(floodErr(2)), 2000);

  // ── sendVideo: transient recover setelah attempt 1 ───────────────
  {
    const { calls } = freshBot({
      video: (n) => (n === 1 ? (() => { throw transientErr(); })() : { video: { file_id: 'f-v1' } }),
    });
    const res = await sendVideo(1, 'a.mp4', { caption: 'x' });
    assert.equal(res.video.file_id, 'f-v1');
    assert.equal(calls.video, 2);
  }

  // ── sendVideo: transient terus-menerus → max 2 retry lalu reject ─
  {
    const { calls } = freshBot({
      video: () => (() => { throw transientErr(); })(),
    });
    await assert.rejects(() => sendVideo(1, 'a.mp4', { caption: 'x' }), /internal Server Error/);
    assert.equal(calls.video, 3);
  }

  // ── sendVideo: non-transient → 1 call, langsung reject ───────────
  {
    const { calls } = freshBot({
      video: () => (() => { throw tooBigErr(); })(),
    });
    await assert.rejects(() => sendVideo(1, 'a.mp4', { caption: 'x' }), /file is too big/);
    assert.equal(calls.video, 1);
  }

  // ── sendVideo: flood lama tetap apiPost-style (retry 2× = 3 call) ─
  {
    const { calls } = freshBot({
      video: (n) => (n <= 2 ? (() => { throw floodErr(); })() : { video: { file_id: 'f-v2' } }),
    });
    const res = await sendVideo(1, 'a.mp4', { caption: 'x' });
    assert.equal(res.video.file_id, 'f-v2');
    assert.equal(calls.video, 3);
  }

  // ── sendAudio: pakai helper yang sama (transient recover) ────────
  {
    const { calls } = freshBot({
      audio: (n) => (n === 1 ? (() => { throw transientErr(); })() : { audio: { file_id: 'f-a' } }),
    });
    const res = await sendAudio(1, 'a.mp3', { caption: 'x' });
    assert.equal(res.audio.file_id, 'f-a');
    assert.equal(calls.audio, 2);
  }

  // ── sendAudio: transient terus-menerus → max 2 retry lalu reject ─
  {
    const { calls } = freshBot({
      audio: () => (() => { throw transientErr(); })(),
    });
    await assert.rejects(() => sendAudio(1, 'a.mp3', { caption: 'x' }), /internal Server Error/);
    assert.equal(calls.audio, 3);
  }

  // ── sendDocument: pakai helper yang sama (transient recover) ─────
  {
    const { calls } = freshBot({
      document: (n) => (n === 1 ? (() => { throw transientErr(); })() : { document: { file_id: 'f-d' } }),
    });
    const res = await sendDocument(1, 'a.zip', { caption: 'x' });
    assert.equal(res.document.file_id, 'f-d');
    assert.equal(calls.document, 2);
  }

  console.log('telegram transient retry mock: 9/9 passed');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});