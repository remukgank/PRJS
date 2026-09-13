// lib/animeTopic.js — router kirim media anime single-send.
// Fokus: kirim SEKALI per file. Saat thread topic tersedia (resolveThread non-null)
// → kirim ke getOrCreateTopic('anime') (auto-create/reuse, tanpa hardcode ID).
// Saat null/gagal → fallback kirim ke chat asal (file tidak hilang). Tidak pernah dobel.
// Dispatch ekstensi (video/audio/doc) terpusat di sini.
const { logger } = require('../logger');

const ANIME_TOPIC_KEY = 'anime';
const VIDEO_EXTS = new Set(['mp4', 'mkv', 'mov', 'avi', 'webm']);
const AUDIO_EXTS = new Set(['mp3', 'aac', 'ogg', 'm4a', 'wav']);

// senders: { sendVideo, sendAudio, sendDocument } dari sender lib.
// resolveThread: async () => threadId | null (null/gagal → kirim ke chat asal).
function buildAnimeSender(senders, resolveThread) {
  const { sendVideo, sendAudio, sendDocument } = senders;
  return async function sendAnimeMedia(chatId, filePath, opts = {}, cacheInfo = null) {
    let threadId = null;
    try {
      threadId = resolveThread ? await resolveThread() : null;
    } catch (err) {
      logger.warn({ err: err.message }, 'Resolve thread anime gagal — fallback ke chat asal');
    }
    const base = threadId ? { ...opts, message_thread_id: threadId } : { ...opts };
    const threadOnly = threadId ? { message_thread_id: threadId } : {};
    const ext = String(filePath || '').split('.').pop().toLowerCase();
    let result;
    if (AUDIO_EXTS.has(ext)) {
      result = await sendAudio(chatId, filePath, { caption: base.caption, ...threadOnly }, cacheInfo);
    } else if (VIDEO_EXTS.has(ext)) {
      result = await sendVideo(chatId, filePath, { ...base, supports_streaming: true }, cacheInfo);
    } else {
      result = await sendDocument(chatId, filePath, { caption: base.caption, ...threadOnly }, cacheInfo);
    }
    if (threadId) logger.info({ threadId }, 'File anime terkirim ke topic grup');
    return result;
  };
}

module.exports = { buildAnimeSender, ANIME_TOPIC_KEY };