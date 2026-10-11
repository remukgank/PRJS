// Tes multi-akun Vidara (11 Okt 2026) — fitur: multi-username, password sama,
// menu pilihan akun aktif, TANPA rotasi otomatis.
//
// Jalankan dari root repo:   node .tests/vidara-multi-account.js
//
// Yang diuji:
//  1. Parse env multi (spawn node dengan env palsu — module cache bersih):
//     VIDARA_USERNAME / VIDARA_API dipisah koma → accountCount, usernameFor,
//     apiKeyFor, activeApiKey mengikuti akun aktif, setActiveAccount di-clamp.
//  2. Struktural (baca source, bukan mock):
//     - vidaraCall + uploadFileRef memakai activeApiKey() (bukan konstanta lama)
//     - vidara-dashboard login memakai Vdara.activeUsername() (akun aktif)
//     - vidara-dashboard resetSession ikut clear folderCache (ganti akun)
//     - deleteVideo dukung accountIdx (hapus pakai key akun PEMILIK record)
//     - flag limit harian per-akun (vidara_limit_reset_at:<idx>), bukan global
//     - pemanggil saveVidaraUpload menyertakan akun (handlers/vidara.js ×3, vidoy.js ×1)
//     - db.js: migration kolom account + get/setVidaraActiveAccount (export)
//     - menu admin: tombol 'act:vidara_account' + handler 'vidara_acc:' (bot.js)
//  3. DB roundtrip (asli, opsional — dilewati kalau DB tak terjangkau):
//     saveVidaraUpload(..., account) → getVidaraUpload → account terbaca → hapus.
//     getVidaraActiveAccount/setVidaraActiveAccount roundtrip (restore ke 0).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const R = (p) => path.join(ROOT, p);
let pass = 0;
function t(name, fn) {
  try { const info = fn(); console.log(`✅ ${name}${info ? ' — ' + info : ''}`); pass++; }
  catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; }
}

// ── 1. Parse env multi + state akun aktif (subprocess, env palsu) ───────────
t('parse env multi + state akun aktif (subprocess)', () => {
  const js = `
    const V = require(${JSON.stringify(R('scraper/vidara-uploader.js'))});
    V.setActiveAccount(1);
    const out = {
      count: V.accountCount(),
      usernames: V.VIDARA_USERNAMES.length,
      keys: V.VIDARA_KEY_LIST.length,
      u0: V.usernameFor(0), u1: V.usernameFor(1), uX: V.usernameFor(9),
      k0isFirst: V.apiKeyFor(0) === V.VIDARA_KEY_LIST[0],
      k1isSecond: V.apiKeyFor(1) === V.VIDARA_KEY_LIST[1],
      activeIs1: V.activeApiKey() === V.VIDARA_KEY_LIST[1],
      activeUser: V.activeUsername(),
      label1: V.accountLabel(1), label9: V.accountLabel(9),
      backCompat: V.VIDARA_KEY === V.VIDARA_KEY_LIST[0],
      passShared: V.VIDARA_PASSWORD === 'pw_satu_untuk_semua',
    };
    V.setActiveAccount(99); out.clampMax = V.getActiveAccount();
    V.setActiveAccount(-3); out.clampMin = V.getActiveAccount();
    V.setActiveAccount(0);
    console.log(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['-e', js], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      VIDARA_USERNAME: 'user_satu,user_dua',
      VIDARA_PASSWORD: 'pw_satu_untuk_semua',
      VIDARA_API: 'key_satu,key_dua',
      VIDARA_DOMAIN: 'vidara.so',
    },
    encoding: 'utf8', timeout: 60000,
  });
  assert.ok(r.status === 0, `subprocess gagal: ${(r.stderr || '').slice(0, 300)}`);
  const o = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.strictEqual(o.count, 2, 'accountCount harus 2');
  assert.strictEqual(o.usernames, 2, 'username list harus 2');
  assert.strictEqual(o.keys, 2, 'key list harus 2');
  assert.strictEqual(o.u0, 'user_satu'); assert.strictEqual(o.u1, 'user_dua');
  assert.strictEqual(o.uX, 'user_satu', 'usernameFor(luar range) fallback ke akun pertama');
  assert.ok(o.k0isFirst && o.k1isSecond, 'apiKeyFor per index salah');
  assert.ok(o.activeIs1, 'activeApiKey setelah setActiveAccount(1) harus key kedua');
  assert.strictEqual(o.activeUser, 'user_dua', 'activeUsername harus username akun 2');
  assert.strictEqual(o.label1, 'user_dua', 'accountLabel(1) = username akun 2');
  assert.strictEqual(o.label9, 'user_satu', 'accountLabel(luar range) fallback username pertama');
  assert.ok(o.backCompat, 'VIDARA_KEY export = key pertama (guard back-compat)');
  assert.ok(o.passShared, 'password tunggal dibaca untuk semua akun');
  assert.strictEqual(o.clampMax, 1, 'setActiveAccount(99) di-clamp ke akun terakhir');
  assert.strictEqual(o.clampMin, 0, 'setActiveAccount(-3) di-clamp ke 0');
  return '2 akun terparse, clamp benar';
});

// ── 2. Struktural ───────────────────────────────────────────────────────────
const src = (p) => fs.readFileSync(R(p), 'utf8');

t('vidaraCall + uploadFileRef memakai activeApiKey() (bukan konstanta lama)', () => {
  const V = src('scraper/vidara-uploader.js');
  assert.ok(V.includes('api_key=${activeApiKey()}'), 'vidaraCall tidak pakai activeApiKey()');
  assert.ok(V.includes('`api_key=${activeApiKey()}`'), 'uploadFileRef curl tidak pakai activeApiKey()');
  assert.ok(!V.includes('api_key=${VIDARA_KEY}&'), 'masih ada pemakaian konstanta VIDARA_KEY lama di URL');
  return 'semua request ikut akun aktif';
});

t('vidara-dashboard login memakai akun aktif + resetSession clear folderCache', () => {
  const D = src('scraper/vidara-dashboard.js');
  assert.ok(D.includes('Vdara.activeUsername()'), 'login tidak memakai activeUsername()');
  assert.ok(D.includes('Vdara.VIDARA_PASSWORD'), 'login tidak memakai password tunggal uploader');
  assert.ok(/function resetSession\(\) \{ session = null; folderCache\.clear\(\); \}/.test(D),
    'resetSession harus clear folderCache (fld_id lama milik akun lain tidak berlaku)');
  return 'login per akun aktif ✓ cache di-reset';
});

t('deleteVideo dukung accountIdx (hapus pakai key akun PEMILIK record)', () => {
  const V = src('scraper/vidara-uploader.js');
  assert.ok(/async function deleteVideo\(filecode, accountIdx = null\)/.test(V), 'deleteVideo tanpa param accountIdx');
  assert.ok(V.includes("opts.apiKey || activeApiKey()"), 'vidaraCall tanpa override apiKey');
  const H = src('scraper/handlers/vidoy.js');
  assert.ok(H.includes('Vdara.deleteVideo(') && H.includes('Number(preVidara.account) || 0)'),
    'pemanggil deleteVideo harus teruskan account pemilik record');
  return 'delete pakai key akun pemilik';
});

t('flag limit harian per-akun (bukan global)', () => {
  const H = src('scraper/handlers/vidoy.js');
  assert.ok(H.includes('vidara_limit_reset_at:${Vdara.getActiveAccount()}'), 'flag limit tidak per-akun');
  assert.ok(H.includes('getSetting(vidaraLimitFlagKey())'), 'pre-check tidak pakai key per-akun');
  assert.ok(H.includes('setSetting(vidaraLimitFlagKey()'), 'set flag tidak pakai key per-akun');
  assert.ok(!H.includes("getSetting('vidara_limit_reset_at')"), 'masih ada getSetting global lama');
  assert.ok(!H.includes("setSetting('vidara_limit_reset_at'"), 'masih ada setSetting global lama');
  return 'flag = vidara_limit_reset_at:<idx>';
});

t('saveVidaraUpload menyertakan akun aktif di semua pemanggil', () => {
  const H = src('scraper/handlers/vidara.js');
  const calls = (H.match(/saveVidaraUpload\(/g) || []).length;
  const withAcc = (H.match(/V\.getActiveAccount\(\)\)\.catch/g) || []).length;
  assert.strictEqual(calls, 3, `handlers/vidara.js: ${calls} panggil saveVidaraUpload (harus 3)`);
  assert.strictEqual(withAcc, 3, `handlers/vidara.js: hanya ${withAcc}/3 panggil menyertakan account`);
  const A = src('scraper/handlers/vidoy.js');
  assert.ok(/saveVidaraUpload\([\s\S]{0,200}?Vdara\.getActiveAccount\(\)\)/.test(A), 'handlers/vidoy.js: panggil save tanpa account');
  return '4 titik menyertakan account';
});

t('db.js: migration kolom account + get/setVidaraActiveAccount', () => {
  const D = src('scraper/db.js');
  assert.ok(D.includes('ALTER TABLE vidara_uploads ADD COLUMN IF NOT EXISTS account INTEGER DEFAULT 0'), 'migration kolom account hilang');
  assert.ok(D.includes('async function getVidaraActiveAccount'), 'getVidaraActiveAccount hilang');
  assert.ok(D.includes('async function setVidaraActiveAccount'), 'setVidaraActiveAccount hilang');
  assert.ok(/getVidaraActiveAccount,\s*\n\s*setVidaraActiveAccount,/.test(D), 'export get/setVidaraActiveAccount hilang');
  assert.ok(/INSERT INTO vidara_uploads \(drama_key, ep, filecode, domain, title, account\)/.test(D), 'INSERT tanpa kolom account');
  // SELECT lengkap (AGENTS §4: SQL SELECT jangan sampai tidak lengkap)
  assert.ok(D.includes('SELECT filecode, domain, title, account FROM vidara_uploads'), 'getVidaraUpload SELECT tanpa account');
  assert.ok(D.includes('SELECT ep, filecode, domain, tg_chat_id, tg_message_id, account FROM vidara_uploads'), 'listVidaraUploads SELECT tanpa account');
  return 'schema + setting ✓';
});

t('menu admin: tombol + handler pilihan akun', () => {
  const A = src('scraper/handlers/admin.js');
  assert.ok(A.includes("act:vidara_account"), 'tombol 👤 Akun Vidara hilang dari panel');
  const B = src('scraper/bot.js');
  assert.ok(B.includes("if (act === 'vidara_account')"), 'handler vidara_account hilang');
  assert.ok(B.includes("act.startsWith('vidara_acc:')"), 'handler vidara_acc:<idx> hilang');
  assert.ok(B.includes('setVidaraActiveAccount(accIdx)'), 'pilihan tidak disimpan ke bot_settings');
  assert.ok(B.includes("require('./vidara-dashboard').resetSession()"), 'ganti akun harus reset session dashboard');
  assert.ok(B.includes('setActiveAccount(_vidaraAcc)'), 'startup tidak load akun aktif dari DB');
  return 'tombol ✓ handler ✓ startup ✓';
});

// ── 3. DB roundtrip (asli — dilewati kalau DB tak terjangkau) ───────────────
(async () => {
  let db = null;
  try {
    db = require(R('scraper/db.js'));
    await db.pool.query('SELECT 1');
  } catch (e) {
    console.log(`⚠️  DB roundtrip DILEWATI (tidak terjangkau): ${String(e.message).slice(0, 80)}`);
    summary();
    return;
  }
  const key = `zz-test-multiacct-${Date.now()}`;
  try {
    await db.saveVidaraUpload(key, 1, 'fctest1', 'vidara.to', 'Judul Test', 1);
    await db.saveVidaraUpload(key, 2, 'fctest2', 'vidara.to', 'Judul Test', 0);
    const r1 = await db.getVidaraUpload(key, 1);
    const r2 = await db.getVidaraUpload(key, 2);
    assert.ok(r1 && Number(r1.account) === 1, `account record ep1 harus 1 (dapat ${r1 && r1.account})`);
    assert.ok(r2 && Number(r2.account) === 0, `account record ep2 harus 0 (dapat ${r2 && r2.account})`);
    const list = await db.listVidaraUploads(key);
    assert.strictEqual(list.length, 2, 'listVidaraUploads harus 2 baris');
    assert.ok(list.every((r) => r.account !== undefined && r.account !== null), 'listVidaraUploads SELECT tanpa account');
    // get/setVidaraActiveAccount roundtrip — RESTORE ke nilai awal!
    const before = await db.getVidaraActiveAccount();
    await db.setVidaraActiveAccount(1);
    assert.strictEqual(await db.getVidaraActiveAccount(), 1, 'set/getVidaraActiveAccount(1) gagal');
    await db.setVidaraActiveAccount(before);
    assert.strictEqual(await db.getVidaraActiveAccount(), before, 'restore akun aktif gagal');
    console.log(`✅ DB roundtrip: account terbaca per record, setting roundtrip ✓ (restore ke ${before})`);
    pass++;
  } catch (e) {
    console.error(`❌ DB roundtrip\n   ${e.message}`);
    process.exitCode = 1;
  } finally {
    for (const ep of [1, 2]) await db.deleteVidaraUpload(key, ep).catch(() => {});
    await db.pool.end().catch(() => {});
    summary();
  }
})();

function summary() {
  console.log(process.exitCode ? `\n❌ ADA GAGAL (${pass} pass)` : `\n✅ SEMUA PASS (${pass} pass)`);
}
