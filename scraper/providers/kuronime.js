/**
 * kuronime.js — resolver kuronime.sbs (murni, tanpa dependensi bot).
 *
 * Rantai resolve per episode (hasil trace 2026-09-22):
 *   halaman episode → `var _0xa100d42aa = "<b64>"` → POST animeku.org/api/v9/sources
 *   → field `mirror` (b64 → JSON {ct,iv,s} AES-256-CBC, passphrase di bawah)
 *   → peta `download.{v360p,v480p,v720p,v1080p}` berisi provider (gofile/pixeldrain/dll).
 *
 * CATATAN: passphrase diambil dari string-table pintar.js kuronime (`3&!` + 3
 * potong + `==`). Kalau kuronime rotate kunci/JS, resolve akan throw
 * `Kuronime decrypt gagal` — update KURONIME_PASSPHRASE dari JS terbaru.
 * IP Replit diblokir Cloudflare kuronime → di sana resolve gagal (ECONN/timeout/CF);
 * dari IP residential/Wscatter lolos (terverifikasi 200).
 */

'use strict';

const axios = require('axios');
const crypto = require('crypto');

const KURONIME_HOSTS = ['kuronime.sbs', 'kuronime.moe'];
const ANIMEKU_SOURCES_API = 'https://animeku.org/api/v9/sources';
const KURONIME_PASSPHRASE = '3&!Z0M,VIZ;dZW==';
// Quality terbaik dulu — dipakai pickBest (v1080p tidak selalu ada).
const KURONIME_QUALITY_ORDER = ['v1080p', 'v720p', 'v480p', 'v360p'];
// Hanya host yang didukung leaf handler scraper (handlers/download.js).
const KURONIME_SERVER_PRIORITY = ['gofile', 'pixeldrain'];
const KURONIME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function isKuronimeUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return KURONIME_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch { return false; }
}

function titleFromSlug(slug) {
  return String(slug || '').split('-').filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// /nonton-<slug>-episode-N/ → { title, episode, provider, slug }
function parseKuronimeEpisode(url) {
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    const m = path.match(/\/nonton-(.+?)-episode-(\d+)\/?$/i);
    if (!m) return null;
    const slug = m[1];
    return { title: titleFromSlug(slug), episode: parseInt(m[2], 10), provider: 'kuronime', slug };
  } catch { return null; }
}

// /anime/<slug>/ → { title, provider, slug }
function parseKuronimeAnime(url) {
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    const m = path.match(/\/anime\/([^\/]+)\/?$/i);
    if (!m) return null;
    const slug = m[1];
    return { title: titleFromSlug(slug), provider: 'kuronime', slug };
  } catch { return null; }
}

async function fetchHtml(url, referer) {
  const res = await axios.get(url, {
    headers: {
      'User-Agent': KURONIME_UA,
      'Accept': 'text/html,application/xhtml+xml',
      ...(referer ? { Referer: referer } : {}),
    },
    timeout: 25000,
    maxContentLength: 8 * 1024 * 1024,
    validateStatus: () => true,
  });
  if (res.status >= 400) throw new Error(`Kuronime HTTP ${res.status} utk ${url.slice(0, 80)}`);
  return String(res.data || '');
}

// Daftar episode dari halaman anime → [{ ep, url, title }]
async function listKuronimeEpisodes(animeUrl) {
  const info = parseKuronimeAnime(animeUrl);
  if (!info) throw new Error('URL anime kuronime tidak valid (harap /anime/<slug>/)');
  const html = await fetchHtml(animeUrl);
  const seen = new Map();
  const re = /href="(https?:\/\/[^"]*?\/nonton-(.+?)-episode-(\d+)\/?)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const ep = parseInt(m[3], 10);
    if (!seen.has(ep)) seen.set(ep, m[1]);
  }
  const eps = [...seen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ep, epUrl]) => ({ ep, url: epUrl, title: info.title }));
  if (!eps.length) throw new Error('Tidak ada episode ditemukan di halaman anime kuronime');
  return eps;
}

// Dekripsi payload mirror format CryptoJSAesJson (ct b64, iv hex, s hex salt,
// kunci = EVP_BytesToKey MD5 dari passphrase) → object { download, embed, ... }.
function decryptKuronimeMirror(b64mirror, passphrase = KURONIME_PASSPHRASE) {
  try {
    const o = JSON.parse(Buffer.from(String(b64mirror), 'base64').toString('utf8'));
    const ct = Buffer.from(o.ct, 'base64');
    const salt = Buffer.from(o.s, 'hex');
    const iv = Buffer.from(o.iv, 'hex');
    let dx = Buffer.alloc(0);
    let keyiv = Buffer.alloc(0);
    while (keyiv.length < 48) {
      dx = crypto.createHash('md5').update(Buffer.concat([dx, Buffer.from(passphrase, 'utf8'), salt])).digest();
      keyiv = Buffer.concat([keyiv, dx]);
    }
    const decipher = crypto.createDecipheriv('aes-256-cbc', keyiv.subarray(0, 32), iv);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(pt.toString('utf8'));
  } catch (err) {
    throw new Error(`Kuronime decrypt gagal (kunci mungkin rotate): ${err.message.slice(0, 100)}`);
  }
}

// Resolve mirror satu episode → { qualities, embed, filelions, blog, episodeUrl }.
// qualities = peta download per quality: { v1080p: { gofile, pixeldrain, ... }, ... }
async function resolveKuronimeMirrors(episodeUrl) {
  const epHtml = await fetchHtml(episodeUrl);
  const idMatch = epHtml.match(/var _0xa100d42aa = "([^"]+)"/);
  if (!idMatch) throw new Error('Payload animeku tidak ditemukan di halaman episode kuronime');
  let json;
  try {
    const res = await axios.post(ANIMEKU_SOURCES_API, { id: idMatch[1] }, {
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://kuronime.sbs',
        Referer: episodeUrl,
        'User-Agent': KURONIME_UA,
      },
      timeout: 25000,
      validateStatus: () => true,
    });
    json = res.data;
  } catch (err) {
    throw new Error(`animeku API gagal: ${err.message.slice(0, 100)}`);
  }
  if (!json || typeof json !== 'object' || !json.mirror) {
    throw new Error(`animeku API tanpa mirror: ${JSON.stringify(json).slice(0, 120)}`);
  }
  const dec = decryptKuronimeMirror(json.mirror);
  if (!dec || typeof dec !== 'object' || !dec.download) {
    throw new Error('Hasil dekripsi mirror kuronime tanpa peta download');
  }
  return { qualities: dec.download, embed: dec.embed || {}, filelions: dec.filelions || null, blog: dec.blog || null, episodeUrl };
}

// Pilih quality terbaik + server prioritas → { quality, server, url } | null.
function pickKuronimeBest(qualities = {}, qualityOrder = KURONIME_QUALITY_ORDER, serverPriority = KURONIME_SERVER_PRIORITY) {
  for (const q of qualityOrder) {
    const servers = qualities[q] || {};
    for (const s of serverPriority) {
      if (servers[s]) return { quality: q, server: s, url: servers[s] };
    }
  }
  return null;
}

// Adapter bentuk { servers, quality } utk pre-scan batch (lib/samPrescan.js).
async function resolveKuronimeBest(episodeUrl) {
  const { qualities } = await resolveKuronimeMirrors(episodeUrl);
  for (const q of KURONIME_QUALITY_ORDER) {
    const servers = qualities[q] || {};
    const supported = {};
    for (const s of KURONIME_SERVER_PRIORITY) if (servers[s]) supported[s] = servers[s];
    if (Object.keys(supported).length) return { servers: supported, quality: q };
  }
  return { servers: {}, quality: '' };
}

module.exports = {
  KURONIME_HOSTS,
  ANIMEKU_SOURCES_API,
  KURONIME_PASSPHRASE,
  KURONIME_QUALITY_ORDER,
  KURONIME_SERVER_PRIORITY,
  isKuronimeUrl,
  parseKuronimeEpisode,
  parseKuronimeAnime,
  titleFromSlug,
  listKuronimeEpisodes,
  decryptKuronimeMirror,
  resolveKuronimeMirrors,
  pickKuronimeBest,
  resolveKuronimeBest,
};
