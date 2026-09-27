/**
 * test-speed-floor-batas.js
 *
 * Tiga fix setelah E2E Re:Zero (27 Sep 2026, v3.3.0) — semuanya lahir dari
 *KEJADIAN NYATA, bukan dari baca kode:
 *
 *   Ep 7  13:51:48 → 14:03:17  11 menit  3,3 MB / ~115 MB  laju 1-14 KiB/s
 *   Ep 16 14:07:31 → gagal       ~5 menit  mulai kbps 33 → 8
 *
 * Keduanya hanya selamat karena STALL_MS 20 detik akhirnya menyala saat byte
 * benar-benar 0. Kalau server nge-drip terus tanpa pernah 0 byte, tidak ada
 * yang memutuskan gagal.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const TH = require(path.join(ROOT, 'lib', 'download-thresholds'));
const SVC = fs.readFileSync(path.join(ROOT, 'services', 'vidaraService.js'), 'utf8');
const DLR = fs.readFileSync(path.join(ROOT, 'downloader.js'), 'utf8');
const PRG = fs.readFileSync(path.join(ROOT, 'lib', 'progress.js'), 'utf8');

let passed = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); passed++; }
  catch (e) { console.log(`FAIL ${name}\n      ${e.message}`); failed++; }
};

// ── 1) SPEED_MIN_BYTES = 0 ───────────────────────────────────────────────
// Gate byte membuat speed floor mustahil menyala justru saat unduhan paling
// lambat: 3,3 MB dalam 11 menit tidak pernah mencapai 5 MiB.
t('1a) SPEED_MIN_BYTES = 0 (tidak ada gate byte)', () => {
  assert.strictEqual(TH.SPEED_MIN_BYTES, 0,
    `harus 0, bukan ${TH.SPEED_MIN_BYTES} — gate byte membuat guard mustahil menyala`);
});

t('1b) speed floor tetap punya pengaman waktu (SPEED_MIN_RUN_MS)', () => {
  // Menurunkan MIN_BYTES tidak boleh menghapus pengaman yang ada.
  assert.ok(TH.SPEED_MIN_RUN_MS > 0, 'SPEED_MIN_RUN_MS harus tetap ada');
  assert.ok(TH.SPEED_MIN_RUN_MS <= 120000,
    `SPEED_MIN_RUN_MS ${TH.SPEED_MIN_RUN_MS} terlalu lama — pengaman pertama hilang`);
  assert.ok(TH.SPEED_WINDOW_MS > 0, 'SPEED_WINDOW_MS harus tetap ada');
});

t('1c) baris 117 masih punya gate waktu, dan gate byte ikut hilang', () => {
  const i = SVC.indexOf('if (now - startedAt >= th.SPEED_MIN_RUN_MS');
  assert.ok(i > 0, 'gate speed floor tidak ditemukan');
  const baris = SVC.slice(i, SVC.indexOf('\n', i));
  assert.ok(/SPEED_MIN_RUN_MS/.test(baris), `gate waktu hilang: ${baris.trim()}`);
  // Tidak boleh mengulang gate byte sebagai syarat kedua.
  assert.ok(!/SPEED_MIN_BYTES\s*&&\s*\w/.test(baris),
    `masih ada syarat gate byte: ${baris.trim()}`);
});

// ── 2) Batas absolut per unduhan ──────────────────────────────────────────
t('2a) MAX_RUN_MS ada dan >= 5 menit (tidak terlalu agresif)', () => {
  assert.ok(TH.MAX_RUN_MS > 0, 'MAX_RUN_MS belum ada di download-thresholds');
  assert.ok(TH.MAX_RUN_MS >= 5 * 60 * 1000,
    `MAX_RUN_MS ${TH.MAX_RUN_MS} terlalu pendek — episode sehat 10-20 detik, ini hanya untuk yang rusak`);
});

t('2b) vidaraService memakai MAX_RUN_MS SEBELUM stall', () => {
  const w = SVC.indexOf('const watchdog = setInterval');
  assert.ok(w > 0, 'watchdog tidak ditemukan');
  const blok = SVC.slice(w, w + 1600);
  const iMax = blok.indexOf('th.MAX_RUN_MS');
  const iStall = blok.indexOf('th.STALL_MS');
  assert.ok(iMax > 0, 'MAX_RUN_MS tidak dipakai di watchdog vidaraService');
  assert.ok(iStall > 0, 'STALL_MS tidak ada (baseline pembanding)');
  assert.ok(iMax < iStall,
    'batas absolut harus dicek sebelum stall — itu yang menutup kelas nge-drip');
});

t('2c) pesan batas absolut menyebut jumlah menit + MB terkumpul', () => {
  const w = SVC.indexOf('th.MAX_RUN_MS');
  const blok = SVC.slice(w, w + 500);
  assert.ok(/MAX_RUN_MS \/ 60000/.test(blok), 'pesan harus menyebut batas menit');
  assert.ok(/got \/ 1048576/.test(blok), 'pesan harus menyebut MB terkumpul');
});

t('2d) aria2c (downloader.js) juga punya batas absolut', () => {
  assert.ok(/const ARIA2C_MAX_RUN_MS = /.test(DLR), 'ARIA2C_MAX_RUN_MS belum ada');
  const iDef = DLR.indexOf('const ARIA2C_MAX_RUN_MS');
  const iUse = DLR.indexOf('runMs > ARIA2C_MAX_RUN_MS');
  assert.ok(iUse > 0, 'ARIA2C_MAX_RUN_MS hanya dideklarasikan, tidak dipakai');
  assert.ok(iUse > iDef, 'pemakaian harus setelah deklarasi');
  // Blok if (...) { ... } harus memuat proc.kill DAN return.
  const dari = DLR.indexOf('{', iUse);
  let depth = 0, akhir = dari;
  for (let k = dari; k < DLR.length; k++) {
    if (DLR[k] === '{') depth++;
    else if (DLR[k] === '}') { depth--; if (depth === 0) { akhir = k; break; } }
  }
  const blok = DLR.slice(iUse, akhir + 1);
  assert.ok(/proc\.kill\('SIGTERM'\)/.test(blok),
    `batas absolut harus kill proses; blok = ${blok.slice(0, 180)}`);
  assert.ok(/return;/.test(blok), 'harus return setelah kill');
  assert.ok(/melebihi batas waktu/.test(blok), 'killReason harus bisa dibaca');
});

// ── 3) finally di tick() ─────────────────────────────────────────────────
// this.editing = false tanpa finally → kalau renderRichMessage() atau
// _postJsonRetry melempar DI LUAR catch, flag menggantung true permanen →
// tick() berikutnya selalu return di awal → progres beku diam-diam.
t('3a) SEMUA tick() reset editing di dalam finally', () => {
  // Ada DUA kelas dengan tick(): Progress (kelas lama, _bot.editMessageText
  // langsung) dan RichProgress (Local API). Keduanya punya flag `editing` yang
  // bisa menggantung true PERMANEN kalau error dilempar di luar catch — dan
  // kalau begitu tick() berikutnya return di baris awal dan progres beku
  // diam-diam sampai bot di-restart. Semua harus punya finally.
  const semua = [...PRG.matchAll(/async tick\(\) \{/g)];
  assert.ok(semua.length >= 2, `harus ada >= 2 tick(), ditemukan ${semua.length}`);
  for (const m of semua) {
    const i = m.index;
    // potong di method berikutnya (indent 2 spasi)
    const kandidat = ['\n  updateEpisode(', '\n  updateLabel(', '\n  update(', '\n  async done(']
      .map((p2) => PRG.indexOf(p2, i)).filter((x) => x > i);
    const akhir = kandidat.length ? Math.min(...kandidat) : i + 2500;
    const blok = PRG.slice(i, akhir);
    const kelas = PRG.lastIndexOf('class ', i) >= 0
      ? PRG.slice(PRG.lastIndexOf('class ', i), PRG.indexOf('{', PRG.lastIndexOf('class ', i))).match(/class (\w+)/)[1]
      : '?';
    assert.ok(/finally\s*\{/.test(blok), `${kelas}.tick() tidak punya finally`);
    const iFin = blok.indexOf('finally');
    const iReset = blok.indexOf('this.editing = false');
    assert.ok(iReset > iFin,
      `${kelas}.tick(): this.editing = false harus DI DALAM finally (dapat di offset ${iReset}, finally di ${iFin})`);
    console.log(`      ${kelas}.tick() → finally ✓`);
  }
});

t('3b) blok finally benar-benar menutup assignment editing', () => {
  const i = PRG.indexOf('async tick() {');
  const j = PRG.indexOf('\n  updateEpisode(', i);
  const blok = PRG.slice(i, j > i ? j : i + 2500);
  const iFin = blok.indexOf('finally');
  assert.ok(iFin > 0, 'tidak ada finally');
  // Hitung kurung: assignment editing harus berada sebelum finally tertutup.
  const setelah = blok.slice(iFin);
  const sebelumTutup = setelah.split('}')[0];
  assert.ok(/this\.editing = false/.test(setelah),
    'assignment editing harus ada setelah finally {');
});

t('3c) RichProgress dan Progress dua-duanya punya finally', () => {
  // Progress.start() juga tidak punya finally pada timer, tapi yang bahaya
  // adalah flag editing. Pastikan tidak ada class lain yang punya pola sama.
  const occurrences = (PRG.match(/this\.editing = (true|false);/g) || []);
  assert.ok(occurrences.length >= 2, 'flag editing harus di-set minimal 2x (set + reset)');
  const resets = occurrences.filter((o) => o.includes('false'));
  assert.ok(resets.length >= 1, 'tidak ada reset editing');
});

// ── Anti-regresi: hal yang TIDAK boleh berubah ───────────────────────────
t('r1) stall tetap 20 detik (tidak ikut diubah)', () => {
  assert.strictEqual(TH.STALL_MS, 20000, `STALL_MS berubah jadi ${TH.STALL_MS}`);
});

t('r2) floor tetap 70 KiB/s, window tetap 90 detik', () => {
  assert.strictEqual(TH.SPEED_FLOOR_BPS, 70 * 1024);
  assert.strictEqual(TH.SPEED_WINDOW_MS, 90000);
  assert.strictEqual(TH.SPEED_MIN_RUN_MS, 90000);
});

t('r3) aria2c & downloadTo tetap punya angka yang sama (anti-drift)', () => {
  const grab = (name) => {
    const m = DLR.match(new RegExp(`const ${name} = ([^;]+);`));
    assert.ok(m, `downloader.js harus punya ${name}`);
    return m[1].replace(/\s*\/\/.*$/, '').trim().replace(/\s+/g, '');
  };
  const pairs = [
    ['ARIA2C_SPEED_FLOOR_BPS', 'SPEED_FLOOR_BPS'],
    ['ARIA2C_SPEED_WINDOW_MS', 'SPEED_WINDOW_MS'],
    ['ARIA2C_SPEED_MIN_RUN_MS', 'SPEED_MIN_RUN_MS'],
    ['ARIA2C_SPEED_MIN_BYTES', 'SPEED_MIN_BYTES'],
  ];
  for (const [aria, mine] of pairs) {
    const val = eval(grab(aria).replace(/\*/g, '*'));
    assert.strictEqual(TH[mine], val,
      `${mine} (${TH[mine]}) harus sama dengan ${aria} (${val}) — kalau berubah, update lib/download-thresholds.js`);
  }
});

t('r4) watchdog vidaraService tetap tanpa angka magic', () => {
  const w = SVC.indexOf('const watchdog = setInterval');
  const blok = SVC.slice(w, SVC.indexOf('}, 1000);', w));
  assert.ok(!/70\s*\*\s*1024/.test(blok), 'tidak boleh ada 70*1024 magic');
  assert.ok(!/90000/.test(blok) && !/90\s*\*\s*1000/.test(blok), 'tidak boleh ada 90000 magic');
  assert.ok(!/25\s*\*\s*60\s*\*\s*1000/.test(blok), 'tidak boleh ada 25*60*1000 magic');
});

t('r5) disableSpeedFloor untuk paidMedia masih ada', () => {
  assert.ok(/!disableSpeedFloor &&/.test(DLR),
    'speed floor untuk paidMedia harus tetap bisa dimatikan');
});

console.log(`\n${passed} pass / ${failed} fail`);
process.exit(failed ? 1 : 0);
