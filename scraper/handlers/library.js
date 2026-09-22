// handlers/library.js — E5a: keyboard builders + lib_menu/lib_part callbacks
// ctx: { bot, logger, config, isAdmin, sendVideo, sendPhoto,
//        db: { listAllLibrary, searchDrama, listPartsWithFile, getMediaBySlug, getPartFileId },
//        cache: { cacheSlug, resolveSlug }, getPendingDeletes }
// Tidak ada require('../bot') — cegah cyclical (pola E4).
const { logger } = require('../logger');
const { truncateText } = require('../lib/parser');
const { cacheSlug, resolveSlug } = require('../lib/urlCache');
const { listAllLibrary, searchDrama, listPartsWithFile, getMediaBySlug, getPartFileId } = require('../db');

let _ctx = null;
function initLibrary(ctx) {
  _ctx = ctx;
}
function ensureCtx(caller) {
  if (!_ctx || !_ctx.bot) throw new Error(`handlers/library belum di-init — panggil initLibrary({ bot, ... }) dulu (dari ${caller})`);
}

// Mode hapus per-episode (per chatId; admin only). Map → boolean di-process.
const libDelMode = new Map();

function librarySearchResultKeyboard(dramas) {
  const rows = dramas.map(d => {
    const isAnime = d.slug.startsWith('anime:');
    const unit = isAnime ? 'episode' : 'part';
    const epInfo = d.total_eps > 0 ? `${d.total_eps} ep` : `${d.lib_parts} ${unit}`;
    const tag = isAnime ? '🎌 Anime' : '🎬 Drama';
    const icon = isAnime ? '🎌' : '🎬';
    const label = d.lib_parts > 0
      ? `${icon} ${d.nama} (${epInfo}) · ${tag}`
      : `${icon} ${d.nama} · ${tag}`;
    return [{ text: truncateText(label), callback_data: `lib_menu:${cacheSlug(d.slug)}` }];
  });
  rows.push([{ text: '⬅️ Kembali', callback_data: 'act:lib_search' }]);
  return { inline_keyboard: rows };
}

async function buildLibraryKeyboard(kat = 'all', page = 1, all = null) {
  all = all || await listAllLibrary();
  const isAnime = (slug) => slug.startsWith('anime:');
  const list = kat === 'all'
    ? all
    : all.filter(d => (kat === 'anime') === isAnime(d.slug));
  const perPage = 20;
  const totalPages = Math.max(1, Math.ceil(list.length / perPage));
  const safePage = Math.min(Math.max(1, page || 1), totalPages);
  const start = (safePage - 1) * perPage;
  const slice = list.slice(start, start + perPage);

  const dramaCount = all.filter(d => !isAnime(d.slug)).length;
  const animeCount = all.length - dramaCount;

  const rows = slice.map(d => {
    const anime = isAnime(d.slug);
    const icon = anime ? '🎌' : '🎬';
    const label = `${icon} ${d.nama}`;
    return [{ text: truncateText(label), callback_data: `lib_menu:${cacheSlug(d.slug)}` }];
  });

  const header = `📚 <b>Library</b> — 🎬 ${dramaCount} drama · 🎌 ${animeCount} anime\nHalaman ${safePage}/${totalPages}`;
  return { header, rows };
}

// Grid episode/part 5 tombol per baris (pola fomo-drama). Label angka saja;
// saat delMode aktif tombol jadi "🗑️ N" untuk hapus per-episode (admin).
function libraryPartsGrid(slug, parts, page = 1, opts = {}) {
  const sid = cacheSlug(slug);
  const { isAdminUser = false, delMode = false } = opts;
  const perPage = 20;
  const totalPages = Math.max(1, Math.ceil(parts.length / perPage));
  const safePage = Math.min(Math.max(1, page || 1), totalPages);
  const start = (safePage - 1) * perPage;
  const slice = parts.slice(start, start + perPage);

  const rows = [];
  let rowAcc = [];
  for (const p of slice) {
    const label = delMode ? `🗑️ ${p.part}` : `${p.part}`;
    const cb = delMode ? `lib_del_ep:${sid}:${p.part}` : `lib_part:${sid}:${p.part}`;
    rowAcc.push({ text: label, callback_data: cb });
    if (rowAcc.length === 5) {
      rows.push(rowAcc);
      rowAcc = [];
    }
  }
  if (rowAcc.length) rows.push(rowAcc);

  const nav = [];
  if (safePage > 1) nav.push({ text: '⬅️ Prev', callback_data: `lib_menu:${sid}:p:${safePage - 1}` });
  nav.push({ text: `${safePage}/${totalPages}`, callback_data: 'noop' });
  if (safePage < totalPages) nav.push({ text: 'Next ➡️', callback_data: `lib_menu:${sid}:p:${safePage + 1}` });
  if (nav.length) rows.push(nav);

  if (isAdminUser) {
    rows.push(delMode
      ? [
          { text: '🗑️ Hapus Judul', callback_data: `lib_del_title:${sid}:${safePage}` },
          { text: '✅ Selesai', callback_data: `lib_delmode:${sid}:${safePage}` },
        ]
      : [
          { text: '🗑️ Hapus Ep', callback_data: `lib_delmode:${sid}:${safePage}` },
          { text: '🗑️ Hapus Judul', callback_data: `lib_del_title:${sid}:${safePage}` },
        ]);
  }
  rows.push([{ text: '⬅️ Kembali', callback_data: 'act:lib_list' }]);
  return { inline_keyboard: rows };
}

function buildLibMenuCaption(media, slug, parts) {
  const isAnime = slug.startsWith('anime:');
  const unit = isAnime ? 'episode' : 'part';
  const dramaName = media?.nama || slug.replace(/^[^:]+:/, '');
  const synopsis = media?.synopsis ? media.synopsis.slice(0, 380) + (media.synopsis.length > 380 ? '…' : '') : '';
  const escSyn = synopsis ? synopsis.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
  const provider = slug.split(':')[0].replace('reelfren_', '');
  const katTag = isAnime ? '🎌 Anime' : '🎬 Drama';
  return [
    `<b>${dramaName}</b> — ${katTag}`,
    `📡 Provider: <code>${provider}</code>`,
    '',
    escSyn,
    '',
    `📁 ${parts.length} ${unit} tersedia di library`,
  ].filter(Boolean).join('\n');
}

// Callback lib_menu dipindah dari bot.js — signature berparameter agar testable tanpa Telegram
async function handleLibMenu({ chatId, msgId, query, data }) {
  ensureCtx('handleLibMenu');
  const { bot } = _ctx;
  let slugId, page;
  const pMatch = data.match(/^lib_menu:(.+):p:(\d+)$/);
  if (pMatch) {
    slugId = pMatch[1];
    page = parseInt(pMatch[2]) || 1;
  } else {
    slugId = data.slice(9);
    page = 1;
  }
  const slug = resolveSlug(slugId);
  if (!slug) return bot.answerCallbackQuery(query.id, { text: '⚠️ Session expired — buka ulang', show_alert: true });
  const parts = await listPartsWithFile(slug);
  if (!parts.length) return bot.answerCallbackQuery(query.id, { text: '⚠️ Belum ada part di library' });
  const media = await getMediaBySlug(slug);
  const perPage = 20;
  const totalPages = Math.max(1, Math.ceil(parts.length / perPage));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const delMode = !!libDelMode.get(String(chatId));
  const isAdminUserLib = _ctx.isAdmin(query.from.id);
  const kb = libraryPartsGrid(slug, parts, safePage, { isAdminUser: isAdminUserLib, delMode });
  const caption = buildLibMenuCaption(media, slug, parts);
  if (safePage === 1 && (media?.poster_file_id || media?.poster_url)) {
    try {
      if (media.poster_file_id) {
        await bot.sendPhoto(chatId, media.poster_file_id, { caption, parse_mode: 'HTML', reply_markup: kb });
      } else {
        await bot.sendPhoto(chatId, media.poster_url, { caption, parse_mode: 'HTML', reply_markup: kb });
      }
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await bot.deleteMessage(chatId, msgId).catch(() => {});
      return;
    } catch {}
  }
  return bot.editMessageText(
    caption,
    { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: kb }
  ).catch(() => {});
}

// Toggle mode hapus per-episode (admin) — re-render grid di halaman yang sama.
async function handleLibDelMode({ chatId, msgId, query, data }) {
  ensureCtx('handleLibDelMode');
  const { bot } = _ctx;
  const m = data.match(/^lib_delmode:(.+):(\d+)$/);
  if (!m) return;
  const slug = resolveSlug(m[1]);
  const page = parseInt(m[2]) || 1;
  if (!_ctx.isAdmin(query.from.id)) {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ Hanya admin' }).catch(() => {});
  }
  if (!slug) return bot.answerCallbackQuery(query.id, { text: '⚠️ Session expired' }).catch(() => {});
  const chatKey = String(chatId);
  if (libDelMode.has(chatKey)) libDelMode.delete(chatKey);
  else libDelMode.set(chatKey, true);
  return handleLibMenu({ chatId, msgId, query, data: `lib_menu:${m[1]}:p:${page}` });
}

// Hapus satu episode dari grid (admin) — konfirmasi lalu reuse dell_confirm.
async function handleLibDelEp({ chatId, query, data }) {
  ensureCtx('handleLibDelEp');
  const { bot } = _ctx;
  const m = data.match(/^lib_del_ep:(.+):(\d+)$/);
  if (!m) return;
  const slug = resolveSlug(m[1]);
  const part = Number(m[2]);
  if (!_ctx.isAdmin(query.from.id)) {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ Hanya admin' }).catch(() => {});
  }
  if (!slug || !part) {
    libDelMode.delete(String(chatId));
    return bot.answerCallbackQuery(query.id, { text: '⚠️ Session expired' }).catch(() => {});
  }
  const media = await getMediaBySlug(slug);
  const name = media?.nama || slug.replace(/^[^:]+:/, '');
  const pendings = _ctx.getPendingDeletes ? _ctx.getPendingDeletes() : null;
  if (pendings) {
    pendings.set(String(chatId), { slug, part, name });
    return bot.sendMessage(chatId, `⚠️ <b>Konfirmasi hapus episode:</b>\n\n<b>${name}</b> — Ep/Part <b>${part}</b>\n\nYakin?`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🗑️ Ya, Hapus', callback_data: 'dell_confirm' }, { text: '❌ Batal', callback_data: 'dell_cancel' }],
        ],
      },
    });
  }
  return bot.answerCallbackQuery(query.id, { text: '⚠️ Pendings belum siap' }).catch(() => {});
}

// Hapus seluruh judul dari grid (admin) — konfirmasi lalu reuse dell_confirm.
async function handleLibDelTitle({ chatId, query, data }) {
  ensureCtx('handleLibDelTitle');
  const { bot } = _ctx;
  const m = data.match(/^lib_del_title:(.+):(\d+)$/);
  if (!m) return;
  const slug = resolveSlug(m[1]);
  if (!_ctx.isAdmin(query.from.id)) {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ Hanya admin' }).catch(() => {});
  }
  if (!slug) return bot.answerCallbackQuery(query.id, { text: '⚠️ Session expired' }).catch(() => {});
  const media = await getMediaBySlug(slug);
  const name = media?.nama || slug.replace(/^[^:]+:/, '');
  const pendings = _ctx.getPendingDeletes ? _ctx.getPendingDeletes() : null;
  if (pendings) {
    pendings.set(String(chatId), { slug, part: null, name });
    return bot.sendMessage(chatId, `⚠️ <b>Konfirmasi hapus judul:</b>\n\n<b>${name}</b>\n\nSemua episode akan dihapus. Yakin?`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🗑️ Ya, Hapus', callback_data: 'dell_confirm' }, { text: '❌ Batal', callback_data: 'dell_cancel' }],
        ],
      },
    });
  }
  return bot.answerCallbackQuery(query.id, { text: '⚠️ Pendings belum siap' }).catch(() => {});
}

module.exports = {
  initLibrary,
  librarySearchResultKeyboard,
  buildLibraryKeyboard,
  libraryPartsGrid,
  buildLibMenuCaption,
  handleLibMenu,
  handleLibDelMode,
  handleLibDelEp,
  handleLibDelTitle,
  _libDelMode: libDelMode,
};