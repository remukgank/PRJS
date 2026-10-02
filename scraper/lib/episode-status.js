'use strict';
// Status "sudah ada" per episode untuk picker episode.
//
// Dipisah dari bot.js supaya bisa diuji langsung — bot.js tidak bisa di-require
// dalam test karena langsung mulai polling Telegram.
//
// Sumber GABUNGAN: media_parts (library) + vidoy_uploads (sudah dikirim ke
// Telegram lewat jalur Vidoy). Tanpa ini, episode yang sudah ada di Telegram
// tapi dikirim lewat jalur Vidoy tetap terlihat "belum ada" di menu.
//   lib = ada di library · tg = ada di Telegram (pointer pesan tersimpan)
// vidoyTitle = kunci vidoy_uploads (judul), slug = kunci library (media_parts).
const { listPartsWithFile, listVidoyUploads, listVidaraUploads, findMediaByPattern } = require('../db');
const { kamenimeSourcePattern } = require('../providers/kamenime');
const { withSeasonSuffix } = require('./caption');

/**
 * Gabungkan status per episode.
 *
 * @param {string}      slug            kunci library (opsional, 'anime:<slug>')
 * @param {string}      vidoyTitle      kunci vidoy_uploads utama (judul persis)
 * @param {string[]}    extraVidoyKeys  kandidat kunci lain dari parser episode
 *
 * PENTING: pencocokan vidoy_uploads adalah `media_key = $1` (PERSIS). Picker
 * menurunkan judul dari halaman ANIME sedangkan jalur download dari halaman
 * EPISODE, dan Samehadaku menulis keduanya beda ejaan ("Naruto Shippuden" vs
 * "Naruto Shippuuden"). Tanpa kandidat tambahan, statusMap kosong padahal
 * episode sudah sukses terkirim (insiden 27 Sep 2026) → menu bilang "belum"
 * dan pengguna mengira datanya hilang.
 */
async function episodeStatusMap(slug, vidoyTitle, extraVidoyKeys = []) {
  const map = new Map();
  const set = (part, patch) => {
    const n = Number(part);
    if (!Number.isFinite(n)) return;
    const prev = map.get(n) || { lib: false, tg: false, link: null };
    map.set(n, Object.assign(prev, patch));
  };
  const libKey = String(slug || '').startsWith('anime:') ? String(slug) : 'anime:' + String(slug || '');

  const keys = [];
  const pushKey = (k) => { const s = String(k || '').trim(); if (s && !keys.includes(s)) keys.push(s); };
  pushKey(vidoyTitle);
  for (const k of extraVidoyKeys || []) pushKey(k);

  const jobs = [listPartsWithFile(libKey).catch(() => [])];
  for (const k of keys) jobs.push(listVidoyUploads(k, 'anime').catch(() => []));
  const results = await Promise.all(jobs);

  for (const r of results[0] || []) {
    // file_id = file_id pesan Telegram yang pernah terkirim (disimpan
    // savePartFileId dari `sent.video.file_id`) → bukti "sudah di topic",
    // bukan sekadar baris library. Tanpa ini episode kamenime-vt terhitung
    // "perlu dikirim" selamanya (insiden 129 · 2 Okt 2026).
    set(r.part, { lib: true, ...(r.file_id ? { tg: true } : {}) });
  }
  for (let i = 1; i < results.length; i++) {
    for (const r of results[i] || []) {
      const n = Number(r.part);
      if (!Number.isFinite(n)) continue;
      const prev = map.get(n) || { lib: false, tg: false, link: null, vidara: false };
      map.set(n, {
        lib: prev.lib,
        link: r.link || prev.link || null,
        // gabungan: cukup SATU baris menyimpan pointer → dihitung terkirim
        tg: prev.tg || !!(r.tg_chat_id && r.tg_message_id),
        vidara: prev.vidara || false,
      });
    }
  }
  // Vidara = host cadangan sementara (kuota Vidoy 5 GB/bulan habis di hari
  // pertama). Record Vidara TANPA pointer tidak mengubah `tg` — presence di
  // Vidara bukan bukti pesan terkirim (aturan: kalau ada Vidara, boleh
  // download ke Vidoy). Record DENGAN pointer (`setVidaraTelegramPointer`
  // ditulis actionAnimeEpisode setelah sukses kirim) = bukti terkirim →
  // masuk `tg`. Pointer vidara menutup jalur yang tidak punya library
  // (samehadaku/kuronime target vt). Yang berubah hanya label ringkasan
  // supaya operator tahu file sudah ada di host cadangan.
  // Key WAJIB sama dengan yang ditulis upload (vidoyTitle ber-suffix musim),
  // kalau tidak setiap label "Vidara saja" akan selalu kosong.
  for (const k of keys) {
    const rows = await listVidaraUploads(k).catch(() => []);
    for (const r of rows || []) {
      const n = Number(r.ep);
      if (!Number.isFinite(n)) continue;
      const prev = map.get(n) || { lib: false, tg: false, link: null, vidara: false };
      map.set(n, {
        lib: prev.lib,
        link: prev.link,
        tg: prev.tg || !!(r.tg_chat_id && r.tg_message_id),
        vidara: true,
      });
    }
  }
  return map;
}

/**
 * Kandidat kunci vidoy_uploads yang diturunkan dari URL episode memakai parser
 * yang SAMA dengan jalur download → ejaan judulnya dijamin cocok.
 * Diambil dari episode pertama/tengah/terakhir untuk menutup variasi judul
 * antar episode (mis. judul musim).
 *
 * @param {Array}    eps          daftar episode [{ ep, url, ... }]
 * @param {Function} parseEpisode parser episode penyedia (mis. parseSamehadakuEpisode)
 * @returns {string[]} daftar kunci kandidat (tanpa duplikat)
 */
function vidoyKeysFromEpisodes(eps, parseEpisode) {
  const keys = [];
  const push = (k) => { const s = String(k || '').trim(); if (s && !keys.includes(s)) keys.push(s); };
  if (typeof parseEpisode !== 'function') return keys;
  const list = Array.isArray(eps) ? eps : [];
  const samples = [list[0], list[Math.floor(list.length / 2)], list[list.length - 1]];
  for (const e of samples) {
    if (!e || !e.url) continue;
    try {
      const info = parseEpisode(e.url);
      if (info && info.title) push(withSeasonSuffix(info.title, info.season, info.part));
    } catch {}
  }
  return keys;
}

/**
 * Cari slug baris `media` untuk satu anime, memakai source_pattern (dari URL)
 * sebagai kunci utama dan slug tebakan sebagai cadangan.
 *
 * Kenapa perlu: slug library Historical diturunkan dari judul yang diketik/ditemukan
 * saat episode pertama disimpan. Ejaan judul bisa berubah (kamenime kirim
 * "Re-Zero" dari nama file, situsnya "Re:Zero"), jadi slug-nya bisa
 * "anime:re-zero-.." atau "anime:rezero-..". Picker yang memakai slug tebakan
 * akan MISS dan menampilkan semua episode sebagai belum ada.
 * source_pattern tidak terpengaruh ejaan.
 *
 * @param {string} animeUrl  URL halaman anime (https://kamenime.com/anime/<slug>)
 * @param {string} fallback  slug tebakan, dipakai kalau DB tidak punya polanya
 * @returns {Promise<string>} slug yang benar-benar ada di DB, atau `fallback`
 */
async function resolveLibrarySlugByPattern(animeUrl, fallback) {
  const fb = String(fallback || '');
  try {
    const pat = kamenimeSourcePattern(animeUrl);
    if (!pat) return fb;
    const row = await findMediaByPattern(pat);
    if (row && row.slug) return row.slug;
  } catch { /* DB tidak bisa dibaca -> pakai tebakan, picker tetap tampil */ }
  return fb;
}

/**
 * Parser episode kamenime, bentuk sama dengan parseSamehadakuEpisode supaya
 * bisa dipakai vidoyKeysFromEpisodes. Menghasilkan KUNCI media_key yang sama
 * dengan yang dipakai batch (judul dari <title> situs), bukan judul dari nama
 * file.
 *
 * Bentuk URL: https://www.kamenime.com/anime/<slug>/episode/<n>
 */
function parseKamenimeEpisode(episodeUrl) {
  const u = String(episodeUrl || '');
  const m = u.match(/\/anime\/([^/]+)\/episode\/(\d+)/i);
  if (!m) return null;
  return {
    slug: m[1],
    episode: Number(m[2]),
    season: null,
    part: null,
    movie: false,
    provider: 'hokireceh',
    // Judul belum diketahui dari URL saja; pemanggil boleh mengisinya.
    title: null,
  };
}

module.exports = { episodeStatusMap, vidoyKeysFromEpisodes,
  resolveLibrarySlugByPattern,
  parseKamenimeEpisode,
};
;
