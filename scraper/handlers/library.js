// handlers/library.js — E5a: keyboard builders + lib_menu/lib_part callbacks
// ctx: { bot, logger, config, isAdmin, sendVideo, sendPhoto,
//        db: { listAllLibrary, searchDrama, listPartsWithFile, getMediaBySlug, getPartFileId },
//        cache: { cacheSlug, resolveSlug } }
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

function libraryPartsKeyboard(slug, parts, isAdminUser = false) {
  const sid = cacheSlug(slug);
  const rows = parts.slice(0, 20).map(p => {
    return [{ text: `▶️ Part ${p.part}`, callback_data: `lib_part:${sid}:${p.part}` }];
  });
  if (parts.length > 20) rows.push([{ text: `Next ➡️`, callback_data: `lib_menu:${sid}:p:2` }]);
  rows.push([{ text: '⬅️ Kembali', callback_data: 'act:lib_list' }]);
  return { inline_keyboard: rows };
}

function libraryPartsPageKeyboard(slug, parts, page, isAdminUser = false) {
  const sid = cacheSlug(slug);
  const perPage = 20;
  const totalPages = Math.max(1, Math.ceil(parts.length / perPage));
  const slice = parts.slice((page - 1) * perPage, page * perPage);
  const rows = slice.map(p => {
    return [{ text: `▶️ Part ${p.part}`, callback_data: `lib_part:${sid}:${p.part}` }];
  });
  const nav = [];
  if (page > 1) nav.push({ text: '⬅️ Prev', callback_data: `lib_menu:${sid}:p:${page - 1}` });
  nav.push({ text: `${page}/${totalPages}`, callback_data: 'noop' });
  if (page < totalPages) nav.push({ text: 'Next ➡️', callback_data: `lib_menu:${sid}:p:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '⬅️ Kembali', callback_data: 'act:lib_list' }]);
  return { inline_keyboard: rows };
}

// Callback lib_menu dipindah dari bot.js — signature berparameter agar testable tanpa Telegram
async function handleLibMenu({ chatId, msgId, query, data }) {
  ensureCtx('handleLibMenu');
  const { bot, isAdmin } = _ctx;
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
  const dramaName = media?.nama || slug.replace(/^[^:]+:/, '');
  const isAnime = slug.startsWith('anime:');
  const unit = isAnime ? 'episode' : 'part';
  const perPage = 20;
  const totalPages = Math.ceil(parts.length / perPage);
  const isAdminUserLib = isAdmin(query.from.id);
  const kb = page > 1 ? libraryPartsPageKeyboard(slug, parts, page, isAdminUserLib) : libraryPartsKeyboard(slug, parts, isAdminUserLib);
  const synopsis = media?.synopsis ? media.synopsis.slice(0, 380) + (media.synopsis.length > 380 ? '…' : '') : '';
  const escSyn = synopsis ? synopsis.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
  const provider = slug.split(':')[0].replace('reelfren_', '');
  const katTag = isAnime ? '🎌 Anime' : '🎬 Drama';
  const caption = [`<b>${dramaName}</b> — ${katTag}`, `📡 Provider: <code>${provider}</code>`, '', escSyn, '', `📁 ${parts.length} ${unit} tersedia di library`].filter(Boolean).join('\n');
  if (page === 1 && (media?.poster_file_id || media?.poster_url)) {
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

module.exports = {
  initLibrary,
  librarySearchResultKeyboard,
  buildLibraryKeyboard,
  libraryPartsKeyboard,
  libraryPartsPageKeyboard,
  handleLibMenu,
};
