'use strict';

// Listing file Vidoy — verifikasi ke sumber agar duplikat tidak terulang.
//
// MASALAH (terbukti di Vidoy, 28 Sep 2026):
//   Naruto Shippuden: 504 file di folder, 500 di DB. Selisih 4 = file yatim.
//   Ep 204, 205, 401, 494, 495 ter-upload 2x dengan link berbeda.
//   Semuanya muncul SETELAH restart. Akarnya: `uploadSingle` hanya percaya
//   DB (`.find(r => r.part === num && r.link)`). Kalau proses mati di antara
//   `uploadFile` dan `saveVidoyUpload`, DB kosong padahal file sudah ada di
//   Vidoy -> episode berikutnya di-upload lagi.
//
//   Upload pertama tidak pernah sampai ke Telegram: di `handlers/vidoy.js`,
//   blok `if (needTg)` berada SETELAH `uploadSingle` dan setelah
//   `saveVidoyUpload`. Jadi record tidak tertulis = proses mati sebelum
//   Telegram = fomo-drama tidak punya pointer sama sekali.
//
// FIX: `listFolderFiles()` / `folderFileIndex()` membaca
//   GET /folder_ajax/<folderId>?p=N&l=100
// yang mengembalikan JSON `contents.videos[]` berisi `title` (nama file persis
// seperti di-upload) dan `id` (filecode -> link /d/<id>).
//
// Terukur 28 Sep 2026: Naruto 500 file = 5 request, 0,72 detik.
// 1 anime, bukan per episode.
//
// YANG TIDAK DIUBAH (penting):
//   - `listVidoyUploads` di db.js tetap `.find(r => part === num && r.link)`
//   - folder tidak di-rename, tidak ada migrasi, tidak ada data yang diubah
//   - listing GAGAL -> fallback ke cek DB (tidak jadi titik gagal baru)
//
// Run: node scraper/tests/test-vidoy-listing.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const V_PATH = path.join(ROOT, 'vidoy-uploader.js');
const S_PATH = path.join(ROOT, 'services', 'vidoyService.js');
const TEST_COOKIE_JAR = path.join(os.tmpdir(), `prjs-vidoy-listing-${process.pid}.cookie`);
const PREVIOUS_COOKIE_JAR = process.env.VIDOY_COOKIE_JAR;
process.env.VIDOY_COOKIE_JAR = TEST_COOKIE_JAR;

let passed = 0;
let failed = 0;
const t = async (name, fn) => {
  try {
    await fn();
    passed++;
  } catch (e) {
    failed++;
    console.log(`FAIL: ${name}\n      ${e && e.message}`);
  }
};

// --- Harness uploader: curl palsu, tanpa request sungguhan ------------
// vidoy-uploader memakai execFile('curl', ...). Kita ganti child_process.execFile
// lewat object module yang sama (Node menyimpan cache pada modul builtin),
// sehingga tidak ada request ke Vidoy selama test.
function fakeCurl(responses) {
  const calls = [];
  const impl = (cmd, args, opts, cb) => {
    calls.push(Array.isArray(args) ? args : [args]);
    const flat = (Array.isArray(args) ? args : [args]).join(' ');
    if (flat.includes('/signin')) fs.writeFileSync(TEST_COOKIE_JAR, 'test-session');
    let body = '';
    let code = 200;
    for (const [pat, val] of responses) {
      if (flat.includes(pat)) {
        body = typeof val === 'string' ? val : (val.body || '');
        code = typeof val === 'string' ? 200 : (val.code == null ? 200 : val.code);
        break;
      }
    }
    process.nextTick(() => cb(null, `${body}\n${code}`, ''));
  };
  impl.__calls = calls;
  impl.__folderCalls = () => calls.filter((a) => a.join(' ').includes('folder_ajax')).length;
  return impl;
}

function loadUploader(curlImpl) {
  const cp = require('child_process');
  const real = cp.execFile;
  for (const k of Object.keys(require.cache)) {
    if (k.includes('vidoy-uploader')) delete require.cache[k];
  }
  cp.execFile = curlImpl;
  let V;
  try {
    V = require(V_PATH);
  } finally {
    cp.execFile = real;
  }
  // Uploader menyimpan cache di level modul; muat ulang tiap test.
  if (V.resetSession) V.resetSession();
  return V;
}

const page = (videos, next) => JSON.stringify({
  contents: { videos, totalResults: videos.length },
  page: { current: 1, next: next == null ? null : next },
});

// --- Harness service: stub vidoy-uploader + db + test hooks -----------
function loadService(over) {
  const Module = require('module');
  const realLoad = Module._load;
  const calls = { save: [], upload: 0, ensureMp4: 0, invalidate: 0 };
  const V = Object.assign({
    sanitizeFolderName: (s) => String(s),
    animeFolderPath: (t) => ['ANIME', t],
    dramaFolderPath: (t) => ['DRAMA', t],
    getOrCreateFolderPath: async (segs) => 'fx1',
    buildFolderUrl: (id) => `https://vski.cc/f/${id}`,
    folderFileIndex: async () => ({ byTitle: new Map(), byId: new Map(), total: 0 }),
    fetchPublicLink: async (id) => `https://vski.cc/e/${id}`,
    invalidateFolderFileCache: () => { calls.invalidate++; },
  }, (over && over.V) || {});
  const db = Object.assign({
    listVidoyUploads: async () => (over && over.existing) || [],
    saveVidoyUpload: async (rec) => { calls.save.push(rec); },
  }, (over && over.db) || {});

  for (const k of Object.keys(require.cache)) {
    if (k.includes('vidoyService') || k.includes('vidoy-uploader')) delete require.cache[k];
  }
  Module._load = function (request) {
    if (String(request).includes('vidoy-uploader')) return V;
    if (request === '../db' || String(request).endsWith('/db')) return db;
    if (String(request).includes('vidaraService')) return {};
    return realLoad.apply(this, arguments);
  };
  let S;
  try {
    S = require(S_PATH);
  } finally {
    Module._load = realLoad;
  }
  S.__setTestHooks({
    resolveFolder: async (kind, title) => ({ id: 'fx1', segments: [title], url: 'https://vski.cc/f/fx1' }),
    ensureMp4: async () => { calls.ensureMp4++; return true; },
    uploadFile: async () => {
      calls.upload++;
      return { ok: true, filecode: 'new1', link: 'https://vski.cc/e/new1', dashboardLink: 'd', folderId: 'fx1' };
    },
  });
  return { S, calls, V, db };
}

(async () => {
  // ===== listFolderFiles =====

  await t('pagination: 3 halaman (100/100/37) = 237 item', async () => {
    const V = loadUploader(fakeCurl([
      ['folder_ajax/fx1?p=1', page(Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, title: `X — Ep ${i}.mp4` })), 2)],
      ['folder_ajax/fx1?p=2', page(Array.from({ length: 100 }, (_, i) => ({ id: `b${i}`, title: `X — Ep ${100 + i}.mp4` })), 3)],
      ['folder_ajax/fx1?p=3', page(Array.from({ length: 37 }, (_, i) => ({ id: `c${i}`, title: `X — Ep ${200 + i}.mp4` })), null)],
    ]));
    const out = await V.listFolderFiles('fx1');
    assert.strictEqual(out.length, 237, `harus 237, dapat ${out.length}`);
    assert.strictEqual(out[0].id, 'a0');
    assert.strictEqual(out[200].id, 'c0');
    assert.strictEqual(out[236].id, 'c36');
  });

  await t('halaman kosong -> 0 item, tidak loop', async () => {
    const V = loadUploader(fakeCurl([['folder_ajax/fx1', page([], 2)]]));
    const out = await V.listFolderFiles('fx1');
    assert.strictEqual(out.length, 0);
  });

  await t('page.next null -> hanya 1 request', async () => {
    const c = fakeCurl([['folder_ajax/fx1', page([{ id: 'z1', title: 'Only.mp4' }], null)]]);
    const V = loadUploader(c);
    const out = await V.listFolderFiles('fx1');
    assert.strictEqual(out.length, 1);
    assert.strictEqual(c.__folderCalls(), 1, `harus 1 request, dapat ${c.__folderCalls()}`);
  });

  await t('server mengulang halaman yang sama -> tidak loop', async () => {
    const c = fakeCurl([['folder_ajax/fx1', page([{ id: 'z1', title: 'Only.mp4' }], 1)]]);
    const V = loadUploader(c);
    const out = await V.listFolderFiles('fx1');
    assert.ok(out.length <= 2, `tidak boleh berulang tanpa batas, dapat ${out.length}`);
    assert.ok(c.__folderCalls() <= 2, `request dibatasi, dapat ${c.__folderCalls()}`);
  });

  await t('HTTP 500 -> throw dengan pesan jelas', async () => {
    const V = loadUploader(fakeCurl([['folder_ajax/fx1', { code: 500, body: 'oops' }]]));
    await assert.rejects(() => V.listFolderFiles('fx1'), /HTTP 500/);
  });

  await t('body bukan JSON -> throw', async () => {
    const V = loadUploader(fakeCurl([['folder_ajax/fx1', '<html>login</html>']]));
    await assert.rejects(() => V.listFolderFiles('fx1'), /bukan JSON/);
  });

  await t('folderId kosong -> 0 item tanpa request', async () => {
    const c = fakeCurl([]);
    const V = loadUploader(c);
    assert.strictEqual((await V.listFolderFiles('')).length, 0);
    assert.strictEqual((await V.listFolderFiles(null)).length, 0);
    assert.strictEqual((await V.listFolderFiles('0')).length, 0);
    assert.strictEqual(c.__folderCalls(), 0, 'tidak boleh request');
  });

  // ===== folderFileIndex =====

  await t('cache: 2x panggil folder sama hanya 1 request', async () => {
    const c = fakeCurl([['folder_ajax/fx1', page([{ id: 'q1', title: 'A — Ep 1.mp4' }], null)]]);
    const V = loadUploader(c);
    const a = await V.folderFileIndex('fx1');
    const b = await V.folderFileIndex('fx1');
    assert.strictEqual(a, b, 'harus objek index yang sama (cache)');
    assert.strictEqual(c.__folderCalls(), 1, `harus 1 request, dapat ${c.__folderCalls()}`);
  });

  await t('invalidateFolderFileCache -> index di-fetch ulang', async () => {
    const c = fakeCurl([['folder_ajax/fx1', page([{ id: 'q1', title: 'A — Ep 1.mp4' }], null)]]);
    const V = loadUploader(c);
    const a = await V.folderFileIndex('fx1');
    V.invalidateFolderFileCache('fx1');
    const b = await V.folderFileIndex('fx1');
    assert.notStrictEqual(a, b, 'index baru harus dibuat');
    assert.strictEqual(c.__folderCalls(), 2, `harus 2 request, dapat ${c.__folderCalls()}`);
  });

  await t('byTitle dan byId terisi dua arah', async () => {
    const V = loadUploader(fakeCurl([['folder_ajax/fx1', page([
      { id: 'fid1', title: 'Naruto — Ep 5.mp4' },
      { id: 'fid2', title: 'Naruto — Ep 6.mp4' },
    ], null)]]));
    const idx = await V.folderFileIndex('fx1');
    assert.strictEqual(idx.total, 2);
    assert.strictEqual(idx.byTitle.get('Naruto — Ep 5.mp4').id, 'fid1');
    assert.strictEqual(idx.byId.get('fid2').title, 'Naruto — Ep 6.mp4');
    assert.ok(!idx.byTitle.has('Naruto — Ep 7.mp4'), 'ep 7 belum ada');
  });

  // ===== uploadSingle =====

  await t('file SUDAH ada di listing -> skipped, uploadFile TIDAK dipanggil', async () => {
    const { S, calls } = loadService({
      V: {
        folderFileIndex: async () => ({
          byTitle: new Map([['Demo — Ep 05.mp4', { id: 'exist1', title: 'Demo — Ep 05.mp4' }]]),
          byId: new Map(), total: 1,
        }),
      },
    });
    const r = await S.uploadSingle({
      kind: 'anime', mediaKey: 'Demo', title: 'Demo', ep: 5,
      outDir: '/tmp/vidoy-listing-test', episodeUrl: 'https://x/y.mp4',
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.skipped, true, 'harus skipped');
    assert.strictEqual(r.fromListing, true, 'harus dari listing');
    assert.strictEqual(r.filecode, 'exist1');
    assert.strictEqual(r.link, 'https://vski.cc/e/exist1');
    assert.strictEqual(calls.upload, 0, `uploadFile harus 0x, dapat ${calls.upload}`);
    assert.strictEqual(calls.ensureMp4, 0, `ensureMp4 harus 0x, dapat ${calls.ensureMp4}`);
  });

  await t('listing-hit: record tetap ditulis ke DB (self-healing)', async () => {
    const { S, calls } = loadService({
      V: {
        folderFileIndex: async () => ({
          byTitle: new Map([['Demo — Ep 05.mp4', { id: 'exist1', title: 'Demo — Ep 05.mp4' }]]),
          byId: new Map(), total: 1,
        }),
      },
    });
    await S.uploadSingle({
      kind: 'anime', mediaKey: 'Demo', title: 'Demo', ep: 5,
      outDir: '/tmp/vidoy-listing-test', episodeUrl: 'https://x/y.mp4',
    });
    assert.strictEqual(calls.save.length, 1, `harus 1 save, dapat ${calls.save.length}`);
    const rec = calls.save[0];
    assert.strictEqual(rec.mediaKey, 'Demo');
    assert.strictEqual(rec.part, 5);
    assert.strictEqual(rec.link, 'https://vski.cc/e/exist1');
  });

  await t('file BELUM ada di listing -> upload normal', async () => {
    const { S, calls } = loadService({
      V: {
        // Pra-upload (tanpa force): file belum ada → lanjut upload (maksud asli test).
        // Pasca-upload (force:true dari verifikasi pendaratan): file sudah mendarat
        // → verifikasi lolos. Tanpa pembedaan ini, stub mengembalikan listing basi
        // dan verifikasi baru selalu gagal — padahal di produksi force refetch.
        folderFileIndex: async (id, opts) => {
          if (opts && opts.force) {
            return { byTitle: new Map(), byId: new Map([['new1', {}]]), total: 1 };
          }
          return {
            byTitle: new Map([['Demo — Ep 04.mp4', { id: 'other', title: 'Demo — Ep 04.mp4' }]]),
            byId: new Map(), total: 1,
          };
        },
      },
    });
    const r = await S.uploadSingle({
      kind: 'anime', mediaKey: 'Demo', title: 'Demo', ep: 5,
      outDir: '/tmp/vidoy-listing-test', episodeUrl: 'https://x/y.mp4',
    });
    assert.strictEqual(r.ok, true);
    assert.ok(!r.skipped, 'tidak boleh skipped');
    assert.strictEqual(calls.upload, 1, `uploadFile harus 1x, dapat ${calls.upload}`);
    assert.strictEqual(calls.invalidate, 1, `cache harus di-invalidate, dapat ${calls.invalidate}`);
  });

  await t('listing GAGAL -> fallback ke cek DB, upload tetap jalan', async () => {
    const { S, calls } = loadService({
      V: {
        folderFileIndex: async () => { throw new Error('HTTP 500'); },
      },
    });
    const r = await S.uploadSingle({
      kind: 'anime', mediaKey: 'Demo', title: 'Demo', ep: 5,
      outDir: '/tmp/vidoy-listing-test', episodeUrl: 'https://x/y.mp4',
    });
    assert.strictEqual(r.ok, true, 'tidak boleh gagal total');
    assert.strictEqual(calls.upload, 1, `uploadFile harus tetap jalan, dapat ${calls.upload}`);
  });

  await t('resume dari DB tetap berlaku (link ada -> skip tanpa listing)', async () => {
    let listingPanggil = 0;
    const { S, calls } = loadService({
      existing: [{ part: 5, link: 'https://vski.cc/e/dblink', dashboard: 'd' }],
      V: {
        folderFileIndex: async () => { listingPanggil++; return { byTitle: new Map(), byId: new Map(), total: 0 }; },
      },
    });
    const r = await S.uploadSingle({
      kind: 'anime', mediaKey: 'Demo', title: 'Demo', ep: 5,
      outDir: '/tmp/vidoy-listing-test', episodeUrl: 'https://x/y.mp4',
    });
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(calls.upload, 0, 'tidak boleh upload');
    assert.strictEqual(listingPanggil, 0, 'DB sudah punya link -> listing tidak perlu');
  });

  await t('pad 2 digit WAJIB sama dengan nama file yang sudah ada di Vidoy', async () => {
    // Terverifikasi di Vidoy 28 Sep 2026: nama file asli "Naruto Shippuden — Ep 01.mp4"
    // (pad 2 digit) untuk ep 1-99, lalu "Ep 100.mp4" untuk ep 100+. Kalau nama yang
    // dicari tidak sama persis, listing TIDAK AKAN PERNAH menemukan file yatim —
    // dan tidak boleh longgar (mis. ep 5 cocok dengan "Ep 05" tapi bukan "Ep 5").
    const { S, calls } = loadService({
      V: {
        folderFileIndex: async () => ({
          byTitle: new Map([
            ['Demo — Ep 05.mp4', { id: 'pad5', title: 'Demo — Ep 05.mp4' }],
            ['Demo — Ep 100.mp4', { id: 'pad100', title: 'Demo — Ep 100.mp4' }],
          ]),
          byId: new Map(), total: 2,
        }),
      },
    });
    const r5 = await S.uploadSingle({
      kind: 'anime', mediaKey: 'Demo', title: 'Demo', ep: 5,
      outDir: '/tmp/vidoy-listing-test', episodeUrl: 'https://x/y.mp4',
    });
    assert.strictEqual(r5.filecode, 'pad5', 'ep 5 harus cocok dengan "Ep 05.mp4"');
    assert.strictEqual(calls.upload, 0, 'ep 5 tidak boleh upload ulang');
    const r100 = await S.uploadSingle({
      kind: 'anime', mediaKey: 'Demo', title: 'Demo', ep: 100,
      outDir: '/tmp/vidoy-listing-test', episodeUrl: 'https://x/y.mp4',
    });
    assert.strictEqual(r100.filecode, 'pad100', 'ep 100 harus cocok dengan "Ep 100.mp4"');
    assert.strictEqual(calls.upload, 0, 'ep 100 tidak boleh upload ulang');
  });

  // ===== Kode: hal yang tidak boleh hilang =====

  await t('kode: listVidoyUploads tetap Selecting tg_chat_id/tg_message_id', () => {
    const db = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
    const m = db.match(/listVidoyUploads[\s\S]{0,900}?FROM vidoy_uploads/);
    assert.ok(m, 'listVidoyUploads harus ada');
    for (const col of ['tg_chat_id', 'tg_message_id', 'part', 'link']) {
      assert.ok(m[0].includes(col), `kolom ${col} harus ikut di SELECT`);
    }
  });

  await t('kode: resume di uploadSingle tetap pakai && r.link', () => {
    const s = fs.readFileSync(S_PATH, 'utf8');
    const m = s.match(/async function uploadSingle[\s\S]{0,1500}/);
    assert.ok(m, 'uploadSingle harus ada');
    assert.ok(/\.find\(r\) => Number\(r\.part\) === num && r\.link\)/.test(m[0])
      || /=== num && r\.link/.test(m[0]),
      'resume harus tetap .find(... === num && r.link) — record tanpa link tidak boleh di-skip');
  });

  await t('kode: tidak ada regex hilang dari listFolderFiles', () => {
    const v = fs.readFileSync(V_PATH, 'utf8');
    const m = v.match(/async function listFolderFiles[\s\S]{0,2200}?\n\}/);
    assert.ok(m, 'listFolderFiles harus ada');
    assert.ok(m[0].includes('folder_ajax'), 'harus memanggil folder_ajax');
    assert.ok(m[0].includes('p=${page}'), 'harus mengirim nomor halaman');
  });

  await t('kode: fallback ke DB saat listing gagal wajib ada', () => {
    const s = fs.readFileSync(S_PATH, 'utf8');
    const i = s.indexOf('async function uploadSingle');
    const j = s.indexOf('\n}\n', i);
    const m = [s.slice(i, j > i ? j + 2 : i + 4000)];
    assert.ok(m, 'uploadSingle harus ada');
    assert.ok(m[0].includes('folderFileIndex'), 'harus memanggil folderFileIndex');
    assert.ok(/catch[\s\S]{0,500}listing folder gagal/.test(m[0]), 'harus ada catch yang warned lalu lanjut');
  });

  // Ringkasan dicetak di AKHIR file, bukan di tengah.
  fs.rmSync(TEST_COOKIE_JAR, { force: true });
  if (PREVIOUS_COOKIE_JAR === undefined) delete process.env.VIDOY_COOKIE_JAR;
  else process.env.VIDOY_COOKIE_JAR = PREVIOUS_COOKIE_JAR;
  console.log(`RESULT: ${passed} pass, ${failed} fail`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log('FATAL', e && e.stack);
  process.exit(1);
});
