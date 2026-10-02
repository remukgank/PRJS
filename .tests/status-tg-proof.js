'use strict';
// Regression test status picker A+B (2 Okt 2026).
//
// Insiden: episode target `vt` (file di Vidara, bukan Vidoy) terkirim ke
// Telegram tapi picker tetap "perlu dikirim" (angka 129) karena sumber
// `tg` hanya membaca `vidoy_uploads.pointer`.
//
//   A = pointer Telegram ditulis ke vidara_uploads (setVidaraTelegramPointer)
//   B = media_parts.file_id = bukti pesan terkirim (bukan sekadar library)
//
// Aturan kunci: record HOST tanpa pointer BUKAN bukti terkirim.
//
// Run: node .tests/status-tg-proof.js

const assert = require('assert');
const fs = require('fs');
const db = require('../scraper/db');
const { episodeStatusMap } = require('../scraper/lib/episode-status');

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); passed++; }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
}

const SLUG = 'anime:uji-status-proof';
const KEY = 'Uji Status Proof';
const CHAT = -100111222333;

(async () => {
  // initDatabase idempotent (CREATE/ALTER IF NOT EXISTS) — memastikan kolom
  // pointer vidara_uploads ada sebelum fixture (bot start juga memanggilnya).
  await db.initDatabase().catch((e) => { console.error('init gagal', e.message); process.exit(1); });

  // fixture bersih
  await db.deleteMedia(SLUG).catch(() => {});
  await db.deleteVidaraUpload(KEY, 5).catch(() => {});
  await db.deleteVidaraUpload(KEY, 6).catch(() => {});

  // ── B: file_id di media_parts = bukti terkirim ──────────────────────────
  await db.upsertMedia(SLUG, KEY, 0, 'https://contoh.test/uji-status-proof', 'uji-status-proof');
  await db.savePartFileId(SLUG, 1, 'FILEID-UJI-PROOF-1', 12345, 'ep1.mp4');

  try {
    await t('B: part dgn file_id → lib=true DAN tg=true', async () => {
      const map = await episodeStatusMap(SLUG, KEY, []);
      const st = map.get(1);
      assert.ok(st, 'part 1 tidak ada di map');
      assert.strictEqual(st.lib, true, 'lib harus true');
      assert.strictEqual(st.tg, true, 'tg harus true (file_id = bukti pesan)');
    });

    await t('part tanpa baris → tidak dianggap ada (belum)', async () => {
      const map = await episodeStatusMap(SLUG, KEY, []);
      assert.ok(!map.has(2), 'part 2 seharusnya belum ada');
    });

    // ── A: record vidara tanpa pointer = host saja, BUKAN terkirim ────────
    await db.saveVidaraUpload(KEY, 5, 'FC-UJI-PROOF-5', 'vidara.to', KEY);
    await db.saveVidaraUpload(KEY, 6, 'FC-UJI-PROOF-6', 'vidara.to', KEY);

    await t('A: record vidara TANPA pointer → vidara=true, tg=false', async () => {
      const map = await episodeStatusMap(SLUG, KEY, []);
      const st = map.get(5);
      assert.ok(st, 'part 5 tidak ada di map');
      assert.strictEqual(st.vidara, true, 'vidara harus true');
      assert.strictEqual(st.tg, false, 'tanpa pointer tg harus false');
      assert.strictEqual(map.get(6).tg, false, 'part 6 tanpa pointer juga false');
    });

    await t('A: setVidaraTelegramPointer → tg=true', async () => {
      await db.setVidaraTelegramPointer(KEY, 5, CHAT, 555001);
      const map = await episodeStatusMap(SLUG, KEY, []);
      const st = map.get(5);
      assert.strictEqual(st.tg, true, 'pointer tersimpan → tg true');
      assert.strictEqual(st.vidara, true, 'vidara tetap true');
      assert.strictEqual(map.get(6).tg, false, 'part 6 tidak ikut berubah');
    });

    await t('A: setVidaraTelegramPointer utk key tanpa record = tidak error', async () => {
      await db.setVidaraTelegramPointer('Judul Yang Tidak Pernah Ada', 1, CHAT, 1);
    });

    await t('penulisan pointer dari actionAnimeEpisode (vidoy.js) ada', () => {
      const src = fs.readFileSync(`${__dirname}/../scraper/handlers/vidoy.js`, 'utf8');
      assert.ok(/db\.setVidaraTelegramPointer\(/.test(src),
        'vidoy.js tidak memanggil db.setVidaraTelegramPointer');
      assert.ok(/if \(msgId\) \{/.test(src),
        'blok msgId harus berdiri sendiri (tidak lagi `msgId && out.vidoy`)');
    });

    await t('listVidaraUploads mengembalikan kolom pointer', async () => {
      const rows = await db.listVidaraUploads(KEY);
      const r5 = rows.find((r) => Number(r.ep) === 5);
      assert.ok(r5, 'record ep5 tidak ada');
      assert.strictEqual(Number(r5.tg_message_id), 555001, 'pointer ep5 salah baca');
      const r6 = rows.find((r) => Number(r.ep) === 6);
      assert.strictEqual(r6.tg_chat_id, null, 'ep6 harus tetap null');
    });
  } finally {
    await db.deleteMedia(SLUG).catch(() => {});
    await db.deleteVidaraUpload(KEY, 5).catch(() => {});
    await db.deleteVidaraUpload(KEY, 6).catch(() => {});
  }

  console.log(`\n${passed} pass, ${failed} fail`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
