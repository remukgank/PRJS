// lib/urlCache.js — E4c: slug/url cache untuk callback_data 64 bytes
// Satu instance (Node module cache) dipakai lintas writer (router di
// handlers/download.js, message handler di bot.js) dan reader
// (callback sam_*/lib_menu di bot.js).

const slugCache = new Map(); // shortId -> fullSlug
let slugCacheCounter = 0;
function cacheSlug(slug) {
  // cleanup entries > 30 menit
  if (slugCache.size > 500) {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [k, v] of slugCache) { if (v.ts < cutoff) slugCache.delete(k); }
  }
  const id = String(++slugCacheCounter);
  slugCache.set(id, { slug, ts: Date.now() });
  return id;
}
function resolveSlug(id) {
  const entry = slugCache.get(String(id));
  return entry ? entry.slug : null;
}
// ─── URL cache untuk gofile/pixeldrain (callback_data 64 bytes, URL bisa >100) ──────────
const urlCache = new Map(); // shortId -> url
let urlCacheCounter = 0;
function cacheUrl(url) {
  if (urlCache.size > 500) {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [k, v] of urlCache) { if (v.ts < cutoff) urlCache.delete(k); }
  }
  const id = String(++urlCacheCounter);
  urlCache.set(id, { url, ts: Date.now() });
  return id;
}
function resolveUrl(id) {
  const entry = urlCache.get(String(id));
  return entry ? entry.url : null;
}

module.exports = { cacheSlug, resolveSlug, cacheUrl, resolveUrl };
