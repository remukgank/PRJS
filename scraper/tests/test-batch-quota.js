'use strict';

// Fail-fast batch saat kuota Vidoy habis.
//
// MASALAH (log produksi 28 Sep 2026): Vidoy balas 413 quota_exceeded, tapi
// batch 500 episode terus download satu per satu (~250MB each) lalu semuanya
// gagal di register. ~15 episode × 250MB ≈ 4GB terbuang setelah 413 pertama.
//
// FIX: ketiga loop batch (kam_all/sam_all/kur_all) mendeteksi quota di error
// per-episode, break total, kirim pesan jelas dengan tanggal reset, dan lock
// tetap dilepas di finally yang sudah ada.
//
// Run: node scraper/tests/test-batch-quota.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BOT = path.join(__dirname, '..', 'bot.js');
const src = fs.readFileSync(BOT, 'utf8');
// 1 Okt 2026: helper dipindah dari bot.js ke lib/quota.js supaya handlers/vidoy.js
// ikut memakainya (fallback host kedua saat kuota habis). Test WAJIB mengikuti
// perpindahan ini — grab dari bot.js akan selalu gagal Diam-diam karena
// definisinya tidak ada lagi di sana.
const QUOTA = path.join(__dirname, '..', 'lib', 'quota.js');

let passed = 0;
let failed = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });

const REAL_QUOTA = 'Vidoy register gagal: {"status":413,"code":"quota_exceeded","title":"Storage limit reached","quota":{"used":345420706848,"limit":10737418240,"reset_at":"2026-10-01"}}';

t('isQuotaExceededError mendeteksi pesan kuota asli dari log', () => {
  // Dimodul langsung (bukan ekstraksi teks): sejak batas harian Vidara masuk,
  // fungsi ini bergantung pada konstanta VIDARA_DAILY_RE — ekstraksi
  // satu-fungsi gagal dengan "VIDARA_DAILY_RE is not defined" dan tidak
  // menguji apa pun. require() menguji modul yang sama persis yang dipakai
  // bot.js dan handlers/vidoy.js.
  const { isQuotaExceededError: fn } = require(QUOTA);
  assert.strictEqual(fn(REAL_QUOTA), true, 'pesan 413 asli harus terdeteksi');
  assert.strictEqual(fn('Vidoy register gagal: {"status":413}'), false, '413 tanpa kata kuota jangan ikut');
  assert.strictEqual(fn('download HTTP 500'), false);
  assert.strictEqual(fn('gagal resolve link file'), false);
  assert.strictEqual(fn(''), false);
  assert.strictEqual(fn(null), false);
  assert.strictEqual(fn(undefined), false);
  return 'deteksi tepat, tanpa false-positive';
});

t('quotaResetDate mengambil tanggal reset', () => {
  const { quotaResetDate: fn } = require(QUOTA);
  assert.strictEqual(fn(REAL_QUOTA), '2026-10-01');
  assert.strictEqual(fn('tidak ada tanggal'), null);
  assert.strictEqual(fn(null), null);
  return 'reset 2026-10-01 ✓';
});

for (const [loop, checks] of [
  ['kam_all', [
    'if (isQuotaExceededError(kmErrMsg)) { kmQuotaHit = kmErrMsg; break; }',
    'if (isQuotaExceededError(kmErr.message)) { kmQuotaHit = kmErr.message; break; }',
  ]],
  ['sam_all', [
    'if (isQuotaExceededError(lastErr)) { quotaHit = lastErr; break; }',
    'if (isQuotaExceededError(err.message)) { quotaHit = err.message; break; }',
  ]],
  ['kur_all', [
    'if (isQuotaExceededError(lastErr)) { quotaHit = lastErr; break; }',
    'if (isQuotaExceededError(err.message)) { quotaHit = err.message; break; }',
  ]],
]) {
  for (const stmt of checks) {
    t(`${loop}: ada "${stmt.slice(0, 52)}…"`, () => {
      assert.ok(src.includes(stmt), `${loop} kehilangan cek: ${stmt}`);
      return 'titik persis ✓';
    });
  }

  t(`${loop}: pesan khusus kuota (bukan rekap biasa)`, () => {
    // 1 Okt 2026: headline tidak lagi hardcode "Vidoy penuh" — limit harian
    // Vidara juga memicu break, dan pesan harus menunjuk host yang benar.
    assert.ok(/Batch dihentikan — \$\{stop\.headline\}/.test(src), 'headline harus dari quotaStopInfo');
    assert.ok(!/Batch dihentikan — Vidoy penuh\./.test(src), 'headline Vidoy masih hardcode (menyesatkan untuk limit Vidara)');
    assert.ok(/Jalankan lagi setelah kuota pulih/.test(src), 'instruksi lanjut tidak ada');
    return 'pesan khusus ✓';
  });

  t(`${loop}: lock tetap dilepas (finally tidak tersentuh break)`, () => {
    // break di dalam try → finally tetap jalan (semantik JS). Pastikan
    // finally pelepas lock masih ada di handler loop ini.
    assert.ok(/finally\s*\{[\s\S]{0,200}?samAllBusy\.delete|finally\s*\{[\s\S]{0,200}?kurAllBusy\.delete/.test(src),
      'finally pelepas lock hilang?');
    return 'finally utuh ✓';
  });
}

t('ketiga loop konsisten (kam + sam + kur semua punya)', () => {
  const n = (src.match(/if \(isQuotaExceededError\(/g) || []).length;
  assert.ok(n >= 4, `hanya ${n} cek kuota (harap ≥4: kam×2, sam×2, kur×2)`);
  return `${n} titik cek kuota`;
});

// ── Batas harian Vidara (200 file/hari) — kasus nyata 1 Okt 2026 ────────────
// Batch vt ep 130–153 tetap mengunduh ~1,7 GB lalu gagal semua karena pola
// "Daily upload limit" tidak dikenali isQuotaExceededError → break tidak
// pernah jalan. Test di bawah mengunci polanya + pesan yang benar.
const VIDARA_DAILY = 'Vidara upload: filecode kosong — {"error":"Daily upload limit reached — '
  + 'this account can upload 200 files per day and has used 200. '
  + 'The limit resets at 00:00 UTC."}';

t('limit harian Vidara terdeteksi, rate-limit sementara TIDAK', () => {
  const { isQuotaExceededError, vidaraDailyLimitError } = require(QUOTA);
  assert.strictEqual(isQuotaExceededError(VIDARA_DAILY), true, 'pesan limit harian asli harus terdeteksi');
  assert.strictEqual(vidaraDailyLimitError(VIDARA_DAILY), true, 'harus dikenali sebagai limit harian');
  // Kasus negatif WAJIB: "limit reached" polos juga menangkap rate-limit 429
  // yang hilang dalam hitungan detik — batch berhenti untuk sesuatu yang
  // segera pulih = pemborosan.
  const negatif = [
    'Rate limit reached, retry in 30s',
    'Too many requests',
    'Vidoy CDN status invalid',
    'gagal mengunduh video',
    '',
  ];
  for (const c of negatif) {
    assert.ok(!isQuotaExceededError(c), `TIDAK boleh dianggap host penuh: ${c}`);
    assert.ok(!vidaraDailyLimitError(c), `TIDAK boleh limit harian Vidara: ${c}`);
  }
  assert.strictEqual(vidaraDailyLimitError(REAL_QUOTA), false, 'kuota bulanan Vidoy bukan limit harian');
  return 'terdeteksi ✓ rate-limit aman ✓';
});

t('quotaStopInfo menunjuk host + tanggal reset yang benar', () => {
  const { quotaStopInfo, quotaResetDate } = require(QUOTA);
  const v = quotaStopInfo(VIDARA_DAILY);
  assert.strictEqual(v.host, 'vidara', 'host salah → pesan akan menyalahkan Vidoy');
  assert.strictEqual(v.headline, 'Limit harian Vidara penuh', 'headline harus menyebut Vidara');
  assert.ok(v.detail.includes('200 file/hari'), `detail harus menjelaskan batas: ${v.detail}`);
  // Tanpa tanggal di pesan ("resets at 00:00 UTC"), reset = 00:00 UTC berikutnya.
  const today = new Date().toISOString().slice(0, 10);
  const besok = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  assert.ok([today, besok].includes(v.reset), `reset ${v.reset} bukan 00:00 UTC berikutnya`);
  assert.strictEqual(quotaResetDate(VIDARA_DAILY), v.reset, 'quotaResetDate harus ikut menangani format harian');

  const y = quotaStopInfo(REAL_QUOTA);
  assert.strictEqual(y.host, 'vidoy');
  assert.strictEqual(y.headline, 'Vidoy penuh');
  assert.strictEqual(y.reset, '2026-10-01', 'reset bulanan tetap dari reset_at');
  return `vidara reset ${v.reset} · vidoy reset ${y.reset}`;
});

t('bot.js memakai quotaStopInfo di ketiga loop, tidak ada headline hardcode', () => {
  const n = (src.match(/quotaStopInfo\(/g) || []).length;
  assert.strictEqual(n, 3, `hanya ${n} pemakaian quotaStopInfo (harus 3: kam/sam/kur)`);
  assert.ok(!/Batch dihentikan — Vidoy penuh\./.test(src), 'headline "Vidoy penuh" masih hardcode');
  assert.ok(!/Kuota Vidoy habis\$\{/.test(src), 'detail "Kuota Vidoy habis" masih hardcode');
  assert.ok(/quotaStopInfo/.test(src), 'quotaStopInfo tidak dipakai');
  return '3 loop ✓';
});

t('handlers/vidoy.js: flag limit — dicatat saat kena, dicek SEBELUM download', () => {
  const V = require('fs').readFileSync(require.resolve('../handlers/vidoy'), 'utf8');
  const iSet = V.indexOf("setSetting('vidara_limit_reset_at'");
  assert.ok(iSet > 0, 'setSetting flag hilang — batch berikutnya akan mengunduh lagi');
  assert.ok(V.indexOf('vidaraDailyLimitError(err.message)') > 0,
    'set flag harus memakai vidaraDailyLimitError (bukan isQuotaExceededError umum)');

  const iCheck = V.indexOf("getSetting('vidara_limit_reset_at')");
  assert.ok(iCheck > 0, 'pre-check flag hilang');
  // Anchor: penanda PALING AWAL unduhan dimulai. Pakai `p.update('⬇️
  // download')`, bukan `ensureMp4` — titik itu muncul belakangan, sehingga
  // flag yang dipindah ke tengah jalur download tetap lolos cek (terbukti saat
  // mutation test tidak menangkap perpindahan itu).
  const iDownload = V.indexOf("p.update('⬇️ download')");
  assert.ok(iDownload > 0, 'anchor unduhan tidak ditemukan');
  assert.ok(iCheck < iDownload,
    'flag dicek SETELAH unduhan — tetap membuang 1 file penuh sebelum gagal');
  // Sekali kena, episode berikutnya harus berhenti tanpa menyentuh unduhan.
  assert.ok(V.slice(iCheck, iCheck + 600).includes('return silent'),
    'pre-check harus mengembalikan error, bukan lanjut upload');
  return 'set saat kena ✓ cek sebelum download ✓';
});

(async () => {
  for (const { name, fn } of queue) {
    try {
      const extra = await fn();
      console.log(`PASS  ${name}`);
      if (extra) console.log(`      ${extra}`);
      passed++;
    } catch (e) {
      failed++;
      console.error(`FAIL  ${name}: ${e.message}`);
    }
  }
  console.log(`\n${passed} pass / ${failed} fail`);
  process.exit(failed ? 1 : 0);
})();
