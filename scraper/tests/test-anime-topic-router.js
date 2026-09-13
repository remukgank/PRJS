/**
 * test-anime-topic-router.js — sendAnimeMedia: kirim SEKALI ke topic (getOrCreateTopic('anime'))
 * atau fallback ke chat asal; tidak pernah dobel (General + topic).
 *
 * Usage: node scraper/tests/test-anime-topic-router.js
 */

const { buildAnimeSender, ANIME_TOPIC_KEY } = require('../lib/animeTopic');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

function makeCalls() {
  const calls = [];
  const sendVideo = (chatId, filePath, opts, cacheInfo) => { calls.push({ type: 'video', chatId, filePath, opts, cacheInfo }); return { video: { file_id: 'vid-1' } }; };
  const sendAudio = (chatId, filePath, opts, cacheInfo) => { calls.push({ type: 'audio', chatId, filePath, opts, cacheInfo }); return { audio: { file_id: 'aud-1' } }; };
  const sendDocument = (chatId, filePath, opts, cacheInfo) => { calls.push({ type: 'doc', chatId, filePath, opts, cacheInfo }); return { document: { file_id: 'doc-1' } }; };
  return { calls, sendVideo, sendAudio, sendDocument };
}

async function main() {
  console.log('== topic mode: resolveThread -> 888, video mp4 ==');
  {
    const m = makeCalls();
    const send = buildAnimeSender(m, async () => 888);
    const r = await send(-100, '/tmp/x.mp4', { caption: 'cap' }, { urlHash: 'abc' });
    const c = m.calls;
    ok(c.length === 1, 'tepat 1 panggilan kirim (tidak dobel)');
    ok(c[0].type === 'video', 'dispatch video');
    ok(c[0].chatId === -100, 'chatId asal dipertahankan (grup sama)');
    ok(c[0].opts.message_thread_id === 888, 'message_thread_id = getOrCreateTopic(anime)');
    ok(c[0].opts.caption === 'cap' && c[0].opts.supports_streaming === true, 'caption + streaming dibawa');
    ok(c[0].cacheInfo?.urlHash === 'abc', 'cacheInfo diteruskan');
    ok(r.video.file_id === 'vid-1', 'return result video (library file_id)');
  }

  console.log('== fallback: resolveThread -> null (RF tidak aktif) ==');
  {
    const m = makeCalls();
    const send = buildAnimeSender(m, async () => null);
    const r = await send(-100, '/tmp/x.mp4', { caption: 'cap' }, { urlHash: 'x' });
    ok(m.calls.length === 1, 'tepat 1 panggilan kirim');
    ok('message_thread_id' in m.calls[0].opts === false, 'tanpa message_thread_id (ke chat asal)');
    ok(r.video.file_id === 'vid-1', 'tetap return result');
  }

  console.log('== resolveThread lempar error -> fallback chat ==');
  {
    const m = makeCalls();
    const send = buildAnimeSender(m, async () => { throw new Error('kaput'); });
    const r = await send(-100, '/tmp/x.mp4', { caption: 'cap' });
    ok(m.calls.length === 1, 'tetap kirim 1x');
    ok('message_thread_id' in m.calls[0].opts === false, 'fallback tanpa thread');
    ok(r.video.file_id === 'vid-1', 'return result');
  }

  console.log('== dispatch: mp3 -> audio, zip -> document (dengan thread) ==');
  {
    const m = makeCalls();
    const send = buildAnimeSender(m, async () => 42);
    await send(-100, '/tmp/s.mp3', { caption: 'a' });
    await send(-100, '/tmp/s.zip', { caption: 'd' });
    ok(m.calls.length === 2, 'dua panggilan terpisah');
    ok(m.calls[0].type === 'audio' && m.calls[0].opts.message_thread_id === 42, 'audio ke thread topic');
    ok(m.calls[1].type === 'doc' && m.calls[1].opts.message_thread_id === 42, 'document ke thread topic');
  }

  console.log('== resolveThread undefined -> fallback chat ==');
  {
    const m = makeCalls();
    const send = buildAnimeSender(m, undefined);
    await send(-100, '/tmp/x.mp4', { caption: 'c' });
    ok(m.calls.length === 1 && 'message_thread_id' in m.calls[0].opts === false, 'fallback chat tanpa thread');
  }

  ok(ANIME_TOPIC_KEY === 'anime', 'ANIME_TOPIC_KEY = \"anime\"');

  console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('Test crash:', err); process.exit(1); });