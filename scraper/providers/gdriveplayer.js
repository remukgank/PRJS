/**
 * gdriveplayer.js — resolver link GDrivePlayer (gdriveplayer.me / gdriveplayer.to).
 *
 * Alur: link sama cuaca `https://gdriveplayer.to/download.php?link=<token>` → halaman
 * berisi tombol download `<a href="https://download.<host>/dl.php?t=<token>">` yang
 * langsung serve file video (.ts MPEG-TS, h264+aac). Provider ini mengekstrak URL file
 * asli + nama file + kualitas dari halaman download.php, konsisten dengan pola
 * gofile/pixeldrain/filedon (URL → info → download langsung).
 *
 * Wajib Referer samehadaku (sumber link) + UA browser penuh: server download.php
 * menolak UA kosong/fetch default. Timeout eksplisit agar tak menggantung.
 */

const GPLAYER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const GPLAYER_REF = 'https://samehadaku.how/';
const GPLAYER_TIMEOUT_MS = 30000;

function isGdrivePlayerUrl(url) {
  try {
    const host = new URL(url).hostname;
    return /(^|\.)(?:gdriveplayer)\.(?:me|to)$/i.test(host) && /download\.php\?link=/i.test(url);
  } catch { return false; }
}

async function resolveGdrivePlayerFile(url, { timeoutMs = GPLAYER_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': GPLAYER_UA, Referer: GPLAYER_REF, Accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(`GDrivePlayer fetch gagal: ${(e && e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : e.message) || e}`);
  } finally {
    clearTimeout(timer);
  }
  const html = await res.text().catch(() => '');
  const href = html.match(/(?:href|url)[=:]?\s*["']?(https:\/\/download\.[^"')\s]+)/i)?.[1] || null;
  if (!href) throw new Error(`GDrivePlayer: link download tidak ditemukan (http ${res.status})`);
  const fileName = html.match(/<h1[^>]*>\s*([^<]+)\s*<\/h1>/i)?.[1]?.trim()
    || html.match(/<title>\s*Download\s*[—-]\s*([^<]+)\s*<\/title>/i)?.[1]?.trim()
    || null;
  const quality = html.match(/Download\s*(\d{3,4}p)\b/i)?.[1] || null;
  return {
    fileUrl: href,
    fileName,
    quality,
  };
}

module.exports = { isGdrivePlayerUrl, resolveGdrivePlayerFile, GPLAYER_UA, GPLAYER_REF };