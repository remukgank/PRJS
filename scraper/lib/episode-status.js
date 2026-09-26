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
const { listPartsWithFile, listVidoyUploads } = require('../db');
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

  for (const r of results[0] || []) set(r.part, { lib: true });
  for (let i = 1; i < results.length; i++) {
    for (const r of results[i] || []) {
      const n = Number(r.part);
      if (!Number.isFinite(n)) continue;
      const prev = map.get(n) || { lib: false, tg: false, link: null };
      map.set(n, {
        lib: prev.lib,
        link: r.link || prev.link || null,
        // gabungan: cukup SATU baris menyimpan pointer → dihitung terkirim
        tg: prev.tg || !!(r.tg_chat_id && r.tg_message_id),
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

module.exports = { episodeStatusMap, vidoyKeysFromEpisodes };
