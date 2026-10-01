'use strict';

// Regression test: status menu episode (picker) vs kunci vidoy_uploads.
//
// Insiden 27 Sep 2026: ep 1–3 Naruto Shippuuden sukses Vidoy + Telegram
// (pointer tersimpan, link ada) tetapi menu picker menampilkan SEMUANYA
// "belum ada". Penyebabnya selisih EJAAN judul:
//   - picker menurunkan judul dari halaman ANIME  → "Naruto Shippuden"  (1 u)
//   - jalur download dari halaman EPISODE         → "Naruto Shippuuden" (2 u)
//   - media_key di DB                             = versi episode
// Pencocokan vidoy_uploads = `media_key = $1` (PERSIS) → 0 baris → menu kosong.
// Padahal `uploadSingle` memakai kunci versi episode, jadi Vidoy TIDAK
// mengalami duplikat — hanya tampilannya yang salah.
//
// Run: node scraper/tests/test-episode-status.js

require('dotenv').config({ path: `${__dirname}/../../.env` });

const assert = require('assert');
const fs = require('fs');
const db = require('../db');
const { episodeStatusMap, vidoyKeysFromEpisodes } = require('../lib/episode-status');
const { parseSamehadakuEpisode, parseSamehadakuAnime } = require('../providers/samehadaku');

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); passed++; }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
}

// Data uji sendiri — tidak bergantung pada data developer mana pun.
const KEY_EPISODE = 'Uji Kunci Anime Bener';   // versi parser EPISODE (kunci DB)
const KEY_ANIME   = 'Uji Kunci Anime Salah';   // versi halaman ANIME (dipakai picker)
const SLUG        = 'anime:uji-kunci-menu';
const LINK        = 'https://vski.cc/e/ujikuncimenu';

(async () => {
  // ── fixture ────────────────────────────────────────────────────────────
  await db.deleteVidoyRecord(KEY_EPISODE, 'anime', 1);
  await db.saveVidoyUpload({
    mediaKey: KEY_EPISODE, kind: 'anime', part: 1,
    title: KEY_EPISODE, link: LINK, dashboard: 'https://vidoy.asia/view/ujikuncimenu',
    provider: 'samehadaku', tgChatId: -1004431872926, tgMessageId: 999001,
  });

  try {
    // ── turunan kunci dari URL episode ───────────────────────────────────
    await t('kandidat kunci berasal dari parser EPISODE (bukan halaman anime)', () => {
      const eps = [{ ep: 1, url: 'https://v2.samehadaku.how/naruto-shippuuden-episode-1/' }];
      const keys = vidoyKeysFromEpisodes(eps, parseSamehadakuEpisode);
      assert.deepStrictEqual(keys, ['Naruto Shippuuden'], `dapat ${JSON.stringify(keys)}`);
    });

    await t('judul halaman anime memang beda ejaan (akar bug)', () => {
      const anime = parseSamehadakuAnime('https://v2.samehadaku.how/anime/naruto-shippuden/');
      const ep = parseSamehadakuEpisode('https://v2.samehadaku.how/naruto-shippuuden-episode-1/');
      assert.notStrictEqual(anime.title, ep.title,
        `judul identik — asumsi bug tidak berlaku lagi (${anime.title})`);
    });

    await t('parser bukan fungsi / eps kosong → [] (tidak melempar)', () => {
      assert.deepStrictEqual(vidoyKeysFromEpisodes([{ ep: 1, url: 'x' }], null), []);
      assert.deepStrictEqual(vidoyKeysFromEpisodes(null, parseSamehadakuEpisode), []);
      assert.deepStrictEqual(vidoyKeysFromEpisodes([], parseSamehadakuEpisode), []);
    });

    await t('sample ambil ep pertama/tengah/akhir, hasil tanpa duplikat', () => {
      const url = 'https://v2.samehadaku.how/naruto-shippuuden-episode-1/';
      const eps = [{ ep: 1, url }, { ep: 2, url }, { ep: 3, url }];
      const keys = vidoyKeysFromEpisodes(eps, parseSamehadakuEpisode);
      assert.strictEqual(keys.length, 1, `duplikat: ${JSON.stringify(keys)}`);
    });

    // ── inti: status menu ────────────────────────────────────────────────
    await t('TANPA kandidat → status kosong (bug terdeteksi)', async () => {
      const map = await episodeStatusMap(SLUG, KEY_ANIME);
      assert.strictEqual(map.size, 0,
        `seharusnya 0 karena ejaan beda; dapat ${JSON.stringify([...map])}`);
    });

    await t('DENGAN kandidat → episode ketemu & ditandai sudah terkirim', async () => {
      const map = await episodeStatusMap(SLUG, KEY_ANIME, [KEY_EPISODE]);
      assert.strictEqual(map.size, 1, `dapat ${map.size} episode`);
      assert.strictEqual(map.get(1).tg, true, 'harus sudah terkirim ke Telegram');
      assert.strictEqual(map.get(1).link, LINK, 'link harus ikut terisi');
      assert.strictEqual(map.get(1).lib, false, 'tidak ada di library');
    });

    await t('kunci duplikat/ kosong diabaikan (tidak query dobel)', async () => {
      const map = await episodeStatusMap(SLUG, KEY_ANIME, [KEY_EPISODE, KEY_EPISODE, '', null, '   ']);
      assert.strictEqual(map.size, 1);
      assert.strictEqual(map.get(1).tg, true);
    });

    await t('tg = OR antar kunci (satu baris punya pointer → dihitung terkirim)', async () => {
      const KEY_KEDUA = 'Uji Kunci Anime Kedua';
      await db.deleteVidoyRecord(KEY_KEDUA, 'anime', 1);
      await db.saveVidoyUpload({
        mediaKey: KEY_KEDUA, kind: 'anime', part: 1,
        title: KEY_KEDUA, link: LINK, tgChatId: null, tgMessageId: null,
      });
      try {
        const map = await episodeStatusMap(SLUG, KEY_ANIME, [KEY_EPISODE, KEY_KEDUA]);
        assert.strictEqual(map.size, 1);
        assert.strictEqual(map.get(1).tg, true,
          'pointer ada di kunci pertama; jangan ditimpa false oleh kunci kedua');
      } finally {
        await db.deleteVidoyRecord(KEY_KEDUA, 'anime', 1);
      }
    });

    // ── anti-duplikat Vidoy ──────────────────────────────────────────────
    await t('jalur download (kunci versi episode) tetap menemukan record → tidak upload ulang', async () => {
      const rows = await db.listVidoyUploads(KEY_EPISODE, 'anime');
      const hit = rows.find(r => Number(r.part) === 1 && r.link);
      assert.ok(hit, 'uploadSingle harus menemukan record ini dan skip');
      assert.strictEqual(hit.link, LINK);
      assert.ok(hit.tg_chat_id && hit.tg_message_id, 'pointer Telegram harus ikut terbaca');
    });

    // ── wiring di bot.js ─────────────────────────────────────────────────
    await t('semua picker memakai vidoyKeysFromEpisodes (kandidat Vidoy)', () => {
      const src = fs.readFileSync(`${__dirname}/../bot.js`, 'utf8');
      assert.ok(/episodeStatusMap\(\s*slug,\s*title,\s*vidoyKeysFromEpisodes\(/.test(src),
        'bot.js tidak memanggil episodeStatusMap dengan kandidat kunci');
      // Dulu assertion-nya `strictEqual(count, 2)` — hanya menghitung. Itu basi
      // begitu commit c14c7a9 menambah picker kamenime (jadi 3), dan akan basi
      // lagi saat picker ke-4 datang. Sekarang daftar parser-nya disebut
      // EKSPLISIT, jadi dua arah tertangkap: picker yang hilang ATAU picker baru
      // yang diam-diam tidak memakai kandidat Vidoy.
      const WAJIB = ['parseSamehadakuEpisode', 'parseKuronimeEpisode', 'parseKamenimeEpisode'];
      const dipakai = [...src.matchAll(/vidoyKeysFromEpisodes\(eps,\s*(parse\w+)/g)].map((m) => m[1]);
      for (const w of WAJIB) {
        assert.ok(dipakai.includes(w), `picker ${w} tidak memakai vidoyKeysFromEpisodes`);
      }
      assert.deepStrictEqual(dipakai.slice().sort(), WAJIB.slice().sort(),
        `daftar picker tidak sesuai:\n  dipakai: ${dipakai.join(', ')}\n  wajib  : ${WAJIB.join(', ')}`);
      console.log(`      → ${dipakai.length} picker memakai kandidat: ${dipakai.join(', ')}`);
      assert.ok(!/async function episodeStatusMap\s*\(/.test(src),
        'episodeStatusMap harus diimport dari lib/episode-status, bukan didefinisikan lagi di bot.js');
    });

    await t('episodeStatusMap tetap membaca tg_chat_id/tg_message_id', () => {
      const src = fs.readFileSync(`${__dirname}/../lib/episode-status.js`, 'utf8');
      assert.ok(src.includes('r.tg_chat_id && r.tg_message_id'),
        'tanpa pointer ini episode dihitung belum terkirim → dikirim ulang (regresi AGENTS §4)');
    });
  } finally {
    await db.deleteVidoyRecord(KEY_EPISODE, 'anime', 1);
    const sisa = await db.listVidoyUploads(KEY_EPISODE, 'anime');
    console.log(`cleanup fixture: ${sisa.length} baris tersisa (harus 0)`);
  }

  console.log(`\n${passed} pass / ${failed} fail`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
