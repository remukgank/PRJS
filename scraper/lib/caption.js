'use strict';

// Helper caption media. Dipakai bersama oleh handlers/vidoy.js (upload Vidoy)
// dan handlers/download.js (kirim dari library/flow Telegram) supaya label link
// & suffix season TIDAK pernah berbeda di dua flow.

// Label memakai domain ASLI link (bukan domain hardcode) supaya yang tampil
// sama persis dengan URL tujuan dan ikut berubah saat domain diganti.
function shortLinkLabel(link) {
  const raw = String(link || '').trim();
  if (!raw) return raw;
  const m = raw.match(/^https?:\/\/([^/\s]+)(\/(?:e|d)\/[A-Za-z0-9_-]+)/);
  if (m) return `${m[1]}${m[2]}`;
  const loose = raw.match(/([^/\s]+\.(?:cc|com|tv|asia|net|org|co|xyz|top|site|vip|link|me|io|app|dev|cloud|online|live|world|pro|fun|shop))[\/](e|d)[\/]([A-Za-z0-9_-]+)/i);
  return loose ? `${loose[1]}/${loose[2]}/${loose[3]}` : raw;
}

// Baris caption "➧ Link :- <a ...>" (HTML) atau teks polos.
function vidoyLinkLine(link, { html = true } = {}) {
  const label = shortLinkLabel(link);
  if (!label) return '';
  return html ? `➧ Link :- <a href="${escapeHtmlAttr(link)}">${escapeHtmlAttr(label)}</a>` : `➧ Link :- ${label}`;
}

function escapeHtmlAttr(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Judul Vidoy: judul + suffix season/part pendek (S4 / P2) supaya Season 3 &
// Season 4 tidak saling menimpa. IDEMPOTEN.
function withSeasonSuffix(title, season, part) {
  let out = String(title || '').trim();
  const s = Number(season) || 0;
  const p = Number(part) || 0;
  if (s && !new RegExp(`\\sS${s}(?:$|\\s)`).test(out)) out += ` S${s}`;
  if (p && !new RegExp(`\\sP${p}(?:$|\\s)`).test(out)) out += ` P${p}`;
  return out;
}

module.exports = { shortLinkLabel, vidoyLinkLine, withSeasonSuffix, escapeHtmlAttr };
