'use strict';

/**
 * kamenime.js — resolver file direct (Kamenime).
 *
 * Alur Unlike gofile/pixeldrain/filedon, tidak ada halaman "share" yang harus
 * di-parse: file .mp4-nya berada di path yang bisa ditebak.
 *
 * Dua bentuk URL yang didukung:
 *   1. https://www.kamenime.com/storage/anime/<Judul>/<Judul>-episode-<N>.mp4
 *      → SUDAH URL final. TIDAK ada request sama sekali (instan).
 *   2. https://www.kamenime.com/anime/<slug>/episode/<N>
 *      → 1 GET ke halaman episode, parse <source src="..."> → URL absolut.
 *
 * PENTING soal encoding: `src` di HTML berisi SPASI TELANJANG
 * (`<source src="/storage/anime/Naruto Shippuden/Naruto Shippuden-episode-1.mp4">`).
 * URL Spaces tidak valid untuk fetch — harus di-encode (encodeURI), kalau tidak
 * request gagal dengan ERR_UNESCAPED_SPACE.
 *
 * PENTING soal guard: `isKamenimeUrl` WAJIB dicek SEBELUM `isGdrivePlayerUrl`
 * di semua dispatcher. Kalau bocor ke jalur gdriveplayer, `download.js:968`
 * memaksa ekstensi `.ts` pada file MP4 → remuxToMp4 dipanggil → file salah
 * tipe (bukan sekadar gagal).
 */

const KAMENIME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const KAMENIME_TIMEOUT_MS = 30000;
const KAMENIME_ORIGIN = 'https://www.kamenime.com';

function isKamenimeUrl(url) {
  try {
    const u = new URL(String(url));
    if (!/(^|\.)kamenime\.com$/i.test(u.hostname)) return false;
    // Bentuk final: /storage/...mp4
    if (/\/storage\//i.test(u.pathname) && /\.mp4$/i.test(u.pathname)) return true;
    // Bentuk halaman: /anime/<slug>/episode/<N>
    if (/\/anime\/[^/]+\/episode\/\d+/i.test(u.pathname)) return true;
    return false;
  } catch { return false; }
}

function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

/**
 * src dari HTML mengandung SPASI TELANJANG. JANGAN pakai encodeURI di sini:
 * encodeURI akan mengubah `%20` (sudah ter-encode) jadi `%2520` (double-encode).
 * `new URL()` sudah mem-percent-encode space di path secara otomatis, jadi
 * cukup decode entity lalu serahkan ke URL constructor.
 */
function absolutize(href) {
  const raw = decodeHtmlEntities(String(href).trim());
  return new URL(raw, KAMENIME_ORIGIN).href;
}

function fileNameFromUrl(url) {
  try {
    const p = new URL(url).pathname;
    const seg = decodeURIComponent(p.replace(/\/+$/, '').split('/').pop() || '');
    return seg || 'video.mp4';
  } catch { return 'video.mp4'; }
}

/**
 * Resolve URL kamenime → { fileUrl, fileName, quality, provider }.
 * Bentuk /storage/ dijawab INSTAN tanpa request. Bentuk /episode/N butuh 1 GET.
 */
async function resolveKamenimeFile(url, { timeoutMs = KAMENIME_TIMEOUT_MS } = {}) {
  const input = String(url || '').trim();
  if (!isKamenimeUrl(input)) throw new Error('Kamenime: URL tidak dikenali');

  // Bentuk 1: sudah URL final → tanpa request.
  if (/\/storage\//i.test(input) && /\.mp4$/i.test(input)) {
    const fileUrl = absolutize(input);
    return { fileUrl, fileName: fileNameFromUrl(fileUrl), quality: null, provider: 'kamenime' };
  }

  // Bentuk 2: halaman episode → parse <source src="...">
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let html = '';
  try {
    const res = await fetch(input, {
      redirect: 'follow',
      headers: { 'User-Agent': KAMENIME_UA, Accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal,
    });
    html = await res.text().catch(() => '');
    if (!res.ok && !html) throw new Error(`Kamenime fetch gagal: HTTP ${res.status}`);
  } catch (e) {
    throw new Error(`Kamenime fetch gagal: ${(e && e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : e.message) || e}`);
  } finally {
    clearTimeout(timer);
  }

  // <source src="..."> preferred; fallback ke href video langsung.
  const m = html.match(/<source[^>]+src=["']([^"']+)["']/i)
    || html.match(/<video[^>]+src=["']([^"']+\.mp4)["']/i)
    || html.match(/(https?:\/\/[^"'\s]+\.mp4)/i)
    || html.match(/href=["']([^"']*\/storage\/[^"']+\.mp4)["']/i);
  if (!m || !m[1]) {
    throw new Error('Kamenime: <source src> tidak ditemukan di halaman episode');
  }
  const fileUrl = absolutize(m[1]);
  return { fileUrl, fileName: fileNameFromUrl(fileUrl), quality: null, provider: 'kamenime' };
}

// ─── Listing episode (Livewire) ────────────────────────────────────────────
//
// Halaman /anime/<slug> TIDAK memuat daftar episode (hanya ~37 KB; episode
// dimuat saat tombol "DAFTAR EPISODE" diklik). Verifikasi 27 Sep 2026:
//   - komponen Livewire: `show.anime-show` (v3.14.1)
//   - snapshot memuat `first_episode` / `latest_episode` (key model Video),
//     BUKAN daftar episode
//   - daftar muncul di `components[0].effects.html` setelah call `toggleVideo`
//
// Yang WAJIB benar (sudah diuji satu per satu):
//   1. endpoint `/livewire/update` (v3). `/livewire/message/<name>` = format v2 → 404.
//   2. `Content-Type: application/json` + header `X-Livewire: 1`
//   3. `components[].snapshot` = STRING JSON, bukan objek
//   4. `X-CSRF-TOKEN` = isi <meta name="csrf-token">, cookie XSRF-TOKEN ikut dikirim
//   5. pilih komponen yang `memo.name === 'show.anime-show'` — komponen pertama
//      di halaman adalah `offcanvas-navbar` dan akan 404/berbeda
//
// Kalau gagal → error jujur. Caller harus memberi tahu user mengirim URL
// episode manual. TIDAK ada tebakan nomor episode.

const LIVEWIRE_COMPONENT = 'show.anime-show';
const LISTING_ERROR = 'listing tidak bisa diambil, kirim URL episode manual';

function decodeHtml(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Dari halaman anime → { slug, title, pageUrl }. Judul dari <title> (buang " - Kamenime"). */
function parseKamenimeAnime(url) {
  const input = String(url || '').trim();
  const m = /\/anime\/([^/?#]+)/i.exec(input);
  if (!m) throw new Error(`Kamenime: bukan URL halaman anime — ${LISTING_ERROR}`);
  return { slug: m[1], title: null, pageUrl: new URL(input, KAMENIME_ORIGIN).href };
}

/** Judul dari HTML halaman anime (helper agar bisa dipakai tanpa network). */
function kamenimeTitleFromHtml(html, fallback) {
  const t = /<title>([^<]*)<\/title>/i.exec(String(html || ''));
  if (!t) return fallback;
  const clean = decodeHtml(t[1]).replace(/\s*[-–—|]\s*Kamenime\s*$/i, '').trim();
  return clean || fallback;
}

async function _livewireUpdate({ pageUrl, call, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const pageRes = await fetch(pageUrl, {
      redirect: 'follow',
      headers: { 'User-Agent': KAMENIME_UA, Accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal,
    });
    const html = await pageRes.text();
    if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);

    const csrf = (/<meta\s+name="csrf-token"\s+content="([^"]+)"/i.exec(html) || [])[1];
    if (!csrf) throw new Error('csrf-token tidak ditemukan');
    const setCookies = pageRes.headers.getSetCookie?.() || [];
    const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');

    // Cari PASANGAN wire:id + wire:snapshot pada tag yang sama.
    const re = /wire:id="([^"]+)"/gi;
    let m;
    let snapRaw = null;
    while ((m = re.exec(html))) {
      const tagStart = html.lastIndexOf('<', m.index);
      const tag = html.slice(tagStart, html.indexOf('>', m.index) + 1);
      const sm = /wire:snapshot="([^"]+)"/.exec(tag);
      if (!sm) continue;
      const parsed = JSON.parse(decodeHtml(sm[1]));
      if (parsed?.memo?.name === LIVEWIRE_COMPONENT) {
        snapRaw = decodeHtml(sm[1]);
        break;
      }
    }
    if (!snapRaw) throw new Error(`komponen Livewire "${LIVEWIRE_COMPONENT}" tidak ditemukan`);

    const res = await fetch(`${KAMENIME_ORIGIN}/livewire/update`, {
      method: 'POST',
      redirect: 'follow',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/html, application/xhtml+xml',
        'X-CSRF-TOKEN': csrf,
        'X-Livewire': '1',
        'User-Agent': KAMENIME_UA,
        Referer: pageUrl,
        ...(cookie && { Cookie: cookie }),
      },
      // snapshot WAJIB string, bukan objek (kalau objek → HTTP 500).
      body: JSON.stringify({
        _token: csrf,
        components: [{ snapshot: snapRaw, updates: {}, calls: [call] }],
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Livewire HTTP ${res.status}`);
    // pageHtml ikut dikembalikan: halaman anime sudah di-fetch di atas, jadi
    // judul (<title>) bisa diambil TANPA request tambahan.
    return { json: JSON.parse(text), pageHtml: html };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Daftar episode dari halaman anime (butuh 1 request Livewire).
 * @returns {Promise<Array<{ep:number,url:string,title:string}>>}
 * @throws  Error dengan pesan jujur kalau Livewire gagal — TIDAK menebak nomor.
 */
async function listKamenimeEpisodes(animeUrl, { timeoutMs = KAMENIME_TIMEOUT_MS } = {}) {
  const { slug, pageUrl } = parseKamenimeAnime(animeUrl);
  let json;
  try {
    json = await _livewireUpdate({
      pageUrl, timeoutMs,
      call: { path: '', method: 'toggleVideo', params: [] },
    });
  } catch (e) {
    throw new Error(`Kamenime: ${LISTING_ERROR} (${(e && e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : e.message) || e})`);
  }
  const pageHtml = json && json.pageHtml;
  const effectHtml = json?.json?.components?.[0]?.effects?.html;
  if (!effectHtml) throw new Error(`Kamenime: ${LISTING_ERROR} (Livewire tidak mengembalikan HTML episode)`);

  const out = [];
  const seen = new Set();
  const base = `${new URL(pageUrl).origin}/anime/`;
  const anchorRe = /<a[^>]+href="([^"]*\/episode\/(\d+))"[^>]*>([\s\S]{0,160}?)<\/a>/gi;
  let a;
  while ((a = anchorRe.exec(effectHtml))) {
    const ep = Number(a[2]);
    if (!Number.isInteger(ep) || seen.has(ep)) continue;
    // Nomor selalu diambil dari href, jadi TIDAK ada risiko mengarang episode
    // walau teks anchor bukan nomor ("EPISODE TERLAMA"/"EPISODE TERBARU" juga
    // menunjuk episode sungguhan — hanya — cuma duplikat dari grid, dan `seen`
    // yang menanganinya). Judul pun selalu dinormalkan ke "Episode N" supaya
    // teks navigasi tidak bocor jadi judul.
    const text = decodeHtml(a[3].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    seen.add(ep);
    out.push({
      ep,
      url: new URL(a[1], KAMENIME_ORIGIN).href,
      title: /^episode\s*\d+$/i.test(text) ? text : `Episode ${ep}`,
    });
  }
  if (!out.length) throw new Error(`Kamenime: ${LISTING_ERROR} (0 episode di respons Livewire)`);
  out.sort((x, y) => x.ep - y.ep);
  // Judul asli dari <title> halaman ("Naruto Shippuden - Kamenime" →
  // "Naruto Shippuden"). Dipakai untuk caption & kunci library — slug
  // "naruto-shippuden" tidak bisa dicari di DB (media_key = judul asli).
  const title = kamenimeTitleFromHtml(pageHtml, null) || slug;
  return { slug, title, episodes: out, pageUrl };
}

/** Halaman anime (bukan episode, bukan file) — pintu masuk ke picker. */
function isKamenimeAnimePage(url) {
  try {
    const u = new URL(String(url));
    if (!/(^|\.)kamenime\.com$/i.test(u.hostname)) return false;
    if (/\/storage\//i.test(u.pathname)) return false;
    if (/\/anime\/[^/]+\/episode\/\d+/i.test(u.pathname)) return false;
    return /\/anime\/[^/]+\/?$/i.test(u.pathname);
  } catch { return false; }
}

module.exports = {
  isKamenimeUrl,
  isKamenimeAnimePage,
  resolveKamenimeFile,
  parseKamenimeAnime,
  listKamenimeEpisodes,
  kamenimeTitleFromHtml,
  fileNameFromUrl,
  absolutize,
  KAMENIME_UA,
  KAMENIME_ORIGIN,
};
