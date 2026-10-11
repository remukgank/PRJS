'use strict';
// ═══ Test menu 👤 Akun Vidara — kuota harian per akun (11 Okt 2026) ═══════════
// Server Vidara TIDAK punya endpoint quota (terbukti 404 di API v1 & dashboard)
// → "N/200 hari ini" dihitung dari file unik yang benar-benar masuk Vidara:
//   - counter db `vidara_daily_count:<idx>:<tanggal UTC>` (reset otomatis)
//   - di-inkrement OTOMATIS di saveVidaraUpload — hanya baris BARU (xmax=0),
//     overwrite re-upload tidak menggandakan hitungan.
//   - batas kena → flag `vidara_limit_reset_at:<idx>` → tampil 🔴 + reset WIB.
//
// Jalankan: DATABASE_URL=postgresql://… node .tests/vidara-quota-menu.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'scraper/db'));

let pass = 0, fail = 0;
async function t(name, fn) {
  try { const r = await fn(); console.log(`PASS  ${name}${r ? ' — ' + r : ''}`); pass++; }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); fail++; }
}

const TEST_IDX = 97; // idx akun palsu khusus tes — TIDAK menyentuh akun nyata 0/1

(async () => {
  if (!process.env.DATABASE_URL) { console.log('SKIP: jalankan dengan DATABASE_URL bot'); process.exit(1); }
  await db.pool.query('SELECT 1');

  const keyToday = db.vidaraDailyCountKey(TEST_IDX, db.utcTodayStr ? db.utcTodayStr() : new Date().toISOString().slice(0, 10));

  await t('key counter bentuk benar + tanggal UTC', () => {
    const k = db.vidaraDailyCountKey(1, '2026-10-11');
    assert.strictEqual(k, 'vidara_daily_count:1:2026-10-11', 'bentuk key salah: ' + k);
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(db.vidaraDailyCountKey(0, today).endsWith(':' + today), 'tanggal harus UTC (toISOString)');
    return k;
  });

  await t('counter mulai 0 (key bersih) → add 3× → get = 3', async () => {
    await db.pool.query('DELETE FROM bot_settings WHERE key = $1', [keyToday]);
    assert.strictEqual(await db.getVidaraDailyCount(TEST_IDX), 0, 'harus 0 setelah dihapus');
    await db.addVidaraDailyCount(TEST_IDX);
    await db.addVidaraDailyCount(TEST_IDX);
    await db.addVidaraDailyCount(TEST_IDX);
    assert.strictEqual(await db.getVidaraDailyCount(TEST_IDX), 3, '3× add = 3');
    return 'counter akurat';
  });

  await t('saveVidaraUpload: baris BARU menghitung, overwrite TIDAK', async () => {
    const dk = 'test:quota-menu:' + Date.now();
    await db.saveVidaraUpload(dk, 1, 'fcTEST97', 'vidara.so', 'Judul Tes', TEST_IDX);
    assert.strictEqual(await db.getVidaraDailyCount(TEST_IDX), 4, 'insert baru harus menaikkan counter (3→4)');
    // overwrite (ON CONFLICT DO UPDATE) — xmax != 0 → TIDAK boleh menaikkan
    await db.saveVidaraUpload(dk, 1, 'fcTEST97', 'vidara.so', 'Judul Tes', TEST_IDX);
    assert.strictEqual(await db.getVidaraDailyCount(TEST_IDX), 4, 'overwrite tidak boleh menggandakan hitungan');
    // episode lain (baris baru) → naik lagi
    await db.saveVidaraUpload(dk, 2, 'fcTEST97b', 'vidara.so', 'Judul Tes', TEST_IDX);
    assert.strictEqual(await db.getVidaraDailyCount(TEST_IDX), 5, 'episode baru = +1');
    await db.pool.query('DELETE FROM vidara_uploads WHERE drama_key = $1', [dk]);
    return 'insert-vs-overwrite benar';
  });

  await t('reset harian: tanggal beda = key beda (counter hari ini tidak tersentuh)', async () => {
    const tomorrowKey = db.vidaraDailyCountKey(TEST_IDX, '2099-01-01');
    await db.setSetting(tomorrowKey, '99'); // "counter" di hari lain
    assert.strictEqual(await db.getVidaraDailyCount(TEST_IDX), 5, 'counter hari INI tidak berubah oleh hari lain');
    assert.strictEqual(Number(await db.getSetting(tomorrowKey)), 99, 'hari lain punya key sendiri');
    await db.pool.query('DELETE FROM bot_settings WHERE key = $1', [tomorrowKey]);
    return 'isolasi tanggal ✓';
  });

  // ── Struktural ───────────────────────────────────────────────────────────
  const BOT_SRC = fs.readFileSync(path.join(ROOT, 'scraper/bot.js'), 'utf8');
  const DB_SRC = fs.readFileSync(path.join(ROOT, 'scraper/db.js'), 'utf8');

  await t('bot.js: menu render quota per akun + tombol refresh + style danger', () => {
    assert.ok(BOT_SRC.includes("act === 'vidara_refresh'"), 'handler vidara_refresh hilang');
    assert.ok(BOT_SRC.includes('vidaraAccountMenuView'), 'fungsi render view hilang');
    assert.ok(BOT_SRC.includes('await getVidaraDailyCount(i)'), 'tampilan wajib baca counter per akun');
    assert.ok(BOT_SRC.includes('vidara_limit_reset_at:'), 'wajib baca flag limit per akun');
    assert.ok(/danger \? 'danger'/.test(BOT_SRC) || BOT_SRC.includes("'danger'"), 'tombol akun kena limit harus danger (merah)');
    assert.ok(BOT_SRC.includes('🔄 Refresh kuota'), 'tombol refresh hilang');
    assert.ok(BOT_SRC.includes('vidaraResetWib'), 'waktu reset harus ditampilkan dalam WIB');
    return 'menu lengkap';
  });

  await t('db.js: inkrement counter otomatis di saveVidaraUpload (hanya baris baru)', () => {
    assert.ok(DB_SRC.includes('RETURNING (xmax = 0) AS inserted'), 'deteksi insert-baru (xmax) hilang');
    assert.ok(/if \(r\.rows\[0\]\?\.inserted\) \{\s*\n\s*await addVidaraDailyCount/.test(DB_SRC),
      'addVidaraDailyCount harus dipanggil HANYA saat inserted=true');
    return 'counter otomatis ✓';
  });

  await t('patuh aturan style Bot API: maks 1 primary per keyboard', () => {
    // Menu tidak boleh memakai 'primary' sama sekali (success + danger cukup).
    const iMenu = BOT_SRC.indexOf('vidaraAccountMenuView');
    const iEnd = BOT_SRC.indexOf("act === 'vidara_refresh'", iMenu);
    const menuSrc = BOT_SRC.slice(iMenu, iEnd > 0 ? iEnd : iMenu + 2000);
    assert.ok(!menuSrc.includes("'primary'"), 'menu tidak boleh pakai primary (sudah dipakai success+danger)');
    return 'style aman';
  });

  await db.pool.query('DELETE FROM bot_settings WHERE key = $1', [keyToday]);
  await db.pool.end();
  console.log(`\nHASIL: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
