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

module.exports = {
  isKamenimeUrl,
  resolveKamenimeFile,
  fileNameFromUrl,
  absolutize,
  KAMENIME_UA,
  KAMENIME_ORIGIN,
};
