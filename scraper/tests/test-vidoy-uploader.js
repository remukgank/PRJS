'use strict';

// Unit test: Vidoy uploader (port teruji live) + menu upload Drama/Anime.
// Fokus: sanitasi nama folder (rules terverifikasi live), path folder multi-level,
// util URL galeri, bentuk & validitas 2 menu upload.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const V = require('../vidoy-uploader');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); passed++; }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
}

// ─── Sanitasi nama folder (rules dari uji live 25 Sep 2026) ────────────────
// Live: '<','>' GAGAL dibuat (add-folder tetap 303); emoji jadi '???'; ': ? * " | \ & +' aman;
// panjang 160 aman; CJK aman; spasi di ujung di-trim server.
t('buang < dan > (gagal create kalau ada — live)', () => {
  const out = V.sanitizeFolderName('A <b> Judul >');
  assert.ok(!/[<>]/.test(out), 'harus tanpa < >');
});
t('buang emoji (live: tersimpan ????????)', () => {
  const out = V.sanitizeFolderName('Film Uji \u{1F3AC}\u{1F37F}');
  assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(out), 'harus tanpa emoji');
  assert.ok(out.includes('Film Uji'));
});
t('jaga karakter yang aman (live: : ? * " | \\ & + tersimpan)', () => {
  const out = V.sanitizeFolderName('A: B? C* D" E| F\\ G& H+');
  for (const ch of [':', '?', '*', '"', '|', '&', '+']) {
    assert.ok(out.includes(ch), `harus menjaga "${ch}" → ${out}`);
  }
});
t('slash & backslash jadi tanda hubung (tak boleh jadi path traversal)', () => {
  const out = V.sanitizeFolderName('A/B\\C');
  assert.ok(!out.includes('/') && !out.includes('\\'), 'tak boleh ada separator → ' + out);
});
t('buang karakter kontrol', () => {
  assert.ok(!/[\x00-\x1f]/.test(V.sanitizeFolderName('a\u0001b\u0007c')));
});
t('trim spasi & titik di ujung', () => {
  assert.strictEqual(V.sanitizeFolderName('  ...Judul...  '), 'Judul');
});
t('cap panjang + suffix hash (anti-tabrakan judul mirip)', () => {
  const out = V.sanitizeFolderName('x'.repeat(400));
  assert.ok(out.length <= 120, 'panjang <= 120, dapat ' + out.length);
  assert.ok(out.includes('~'), 'ada suffix hash');
  const a = V.sanitizeFolderName('Judul '.repeat(60) + 'A');
  const b = V.sanitizeFolderName('Judul '.repeat(60) + 'B');
  assert.notStrictEqual(a, b, 'judul mirip → nama folder berbeda');
});
t('nama kosong/pmb → default', () => {
  assert.strictEqual(V.sanitizeFolderName(''), 'Tanpa Judul');
  assert.strictEqual(V.sanitizeFolderName('   '), 'Tanpa Judul');
  assert.strictEqual(V.sanitizeFolderName('...'), 'Tanpa Judul');
});
t('CJK tetap utuh (live: aman)', () => {
  assert.ok(V.sanitizeFolderName('标题 テスト').includes('标题'));
});

// ─── Path folder (live: 3 level berhasil) ──────────────────────────────────
t('dramaFolderPath & animeFolderPath: 4 level', () => {
  assert.deepStrictEqual(V.dramaFolderPath('My Drama'), ['VVIP AKSES', 'DATABASE', 'DRAMA', 'My Drama']);
  assert.deepStrictEqual(V.animeFolderPath('One Piece'), ['VVIP AKSES', 'DATABASE', 'ANIME', 'One Piece']);
});
t('segmentsToPath menyambung & menyanitasi tiap segmen', () => {
  assert.strictEqual(V.segmentsToPath(['DATABASE', 'A/B', 'C']), 'DATABASE/A-B/C');
});
t('path Judul containing < > tetap aman untuk tiap level', () => {
  const segs = V.dramaFolderPath('Pusaka <Tak> Tertandingi').map((s) => V.sanitizeFolderName(s));
  for (const s of segs) assert.ok(!/[<>]/.test(s), s);
});

// ─── Util URL galeri (live) ────────────────────────────────────────────────
t('buildFolderUrl default host + guard id kosong', () => {
  assert.strictEqual(V.buildFolderUrl('abc'), 'https://vidkud.com/f/abc');
  assert.strictEqual(V.buildFolderUrl('abc', 'streamrizz.com'), 'https://streamrizz.com/f/abc');
  assert.strictEqual(V.buildFolderUrl(''), '');
  assert.strictEqual(V.buildFolderUrl('0'), '');
});
t('extractFolderId', () => {
  assert.strictEqual(V.extractFolderId('https://vidkud.com/f/abc-123_X'), 'abc-123_X');
  assert.strictEqual(V.extractFolderId('https://vidkud.com/e/999'), '');
});
t('nextFolderHost rotasi + wrap-around', () => {
  assert.strictEqual(V.nextFolderHost('https://vidkud.com/f/1'), 'https://streamrizz.com/f/1');
  assert.strictEqual(V.nextFolderHost('https://streamrizz.com/f/1'), 'https://vdko.cc/f/1');
  assert.strictEqual(V.nextFolderHost('https://vdko.cc/f/1'), 'https://vidkud.com/f/1');
  assert.strictEqual(V.nextFolderHost('https://vidkud.com/e/1'), '');
});

// ─── Anti-drift: upload wajib punya verifikasi re-list & tangani 302 ──────
t('anti-drift: create folder diverifikasi via re-list (add-foder 303 tak trustworthy)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'vidoy-uploader.js'), 'utf8');
  assert.ok(src.includes('async function createFolderVerified'), 'helper createFolderVerified wajib ada');
  assert.ok(src.includes('tak muncul di tree'), 'error message verifikasi wajib ada');
  assert.ok(src.includes('[302, 301, 303, 401, 403]'), 'session handling wajib 302/301/303/401/403');
  assert.ok(!/const pairs = Object\.keys/.test(src), 'dead code `pairs` tak boleh ada');
  assert.ok(!/logger\.(info|warn|error)\('\[Vidoy\]/.test(src), 'logger harus gaya pino (obj, msg)');
});

// ─── Menu upload Drama & Anime ─────────────────────────────────────────────
function loadMenuFns() {
  const botSrc = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
  const grab = (name) => {
    const start = botSrc.indexOf(`function ${name}`);
    if (start < 0) throw new Error(`fungsi ${name} tak ditemukan di bot.js`);
    const end = botSrc.indexOf('\n}', start);
    return botSrc.slice(start, end + 2);
  };
  const code = [
    grab('targetBtn'),
    grab('animeTargetKeyboard'),
    grab('mainActionKeyboard'),
    grab('dramaLegacyKeyboard'),
  ].join('\n');
  const BTN = require(path.join(__dirname, '..', 'lib', 'btn.js'));
  return new Function('require', 'BTN', `${code}; return { animeTargetKeyboard, mainActionKeyboard, dramaLegacyKeyboard };`);
}
const makeRequire = (vidoyOk, vidaraOk) => (p) => {
  if (p.includes('vidoy-uploader')) return { isConfigured: () => vidoyOk };
  if (p.includes('vidara-uploader')) return { VIDARA_KEY: vidaraOk ? 'key' : '' };
  return require(p);
};

t('menu drama: 9 baris, 5 opsi gabung-10 + sub-menu', () => {
  const { mainActionKeyboard } = loadMenuFns()(makeRequire(true, true), require(path.join(__dirname, '..', 'lib', 'btn.js')));
  const kb = mainActionKeyboard('drama');
  assert.strictEqual(kb.inline_keyboard.length, 9);
  const texts = kb.inline_keyboard.flat().map((b) => b.text);
  for (const must of ['🗜 Telegram — gabung 10', '🗜 Vidara — gabung 10', '🗜 Vidara+TG — gabung 10', '🗜 Vidoy — gabung 10', '🗜 Vidoy+TG — gabung 10', '⚙️ Opsi per episode']) {
    assert.ok(texts.includes(must), `harus ada: ${must}`);
  }
  const datas = kb.inline_keyboard.flat().map((b) => b.callback_data).filter(Boolean);
  for (const a of ['act:merge10', 'act:v_merge10', 'act:vt_merge10', 'act:vy_merge10', 'act:vyt_merge10', 'act:drama_legacy']) {
    assert.ok(datas.includes(a), `callback harus ada: ${a}`);
  }
});
t('menu anime: 3 target (Telegram / Vidoy+TG / Vidoy) — tanpa Vidara', () => {
  const { mainActionKeyboard } = loadMenuFns()(makeRequire(true, true), require(path.join(__dirname, '..', 'lib', 'btn.js')));
  const kb = mainActionKeyboard('anime');
  const datas = kb.inline_keyboard.flat().map((b) => b.callback_data).filter(Boolean);
  for (const a of ['act:a_tg', 'act:a_vyt', 'act:a_vv']) assert.ok(datas.includes(a), a);
  assert.ok(!datas.includes('act:a_vt'), 'Vidara tidak ditawarkan lagi');
});
t('sub-menu per-episode drama: 3 opsi + kembali', () => {
  const { dramaLegacyKeyboard } = loadMenuFns()(makeRequire(true, true), require(path.join(__dirname, '..', 'lib', 'btn.js')));
  const kb = dramaLegacyKeyboard();
  const datas = kb.inline_keyboard.flat().map((b) => b.callback_data).filter(Boolean);
  for (const a of ['act:per_ep', 'act:v_per_ep', 'act:vt_per_ep', 'act:back_menu']) assert.ok(datas.includes(a), a);
});
t('kredensial kosong → tombol target disabled ({}), bukan hilang', () => {
  const { animeTargetKeyboard, dramaLegacyKeyboard } = loadMenuFns()(makeRequire(false, false), require(path.join(__dirname, '..', 'lib', 'btn.js')));
  const btns = animeTargetKeyboard('a', 'b', 'c', 'd').flat();
  assert.ok(btns[0].callback_data === 'a', 'Tombol Telegram tetap aktif');
  for (let i = 1; i < btns.length; i++) {
    assert.ok(btns[i].disabled && !btns[i].callback_data, `Tombol non-TG ke-${i} harus disabled`);
  }
  const legacy = dramaLegacyKeyboard().inline_keyboard.flat();
  assert.ok(legacy[1].disabled && legacy[2].disabled, 'opsi Vidara mati');
  assert.ok(legacy[0].callback_data === 'act:per_ep', 'Telegram tetap aktif');
});
t('semua callback_data <= 64 byte (dokumen resmi: 1-64 bytes)', () => {
  const { animeTargetKeyboard, mainActionKeyboard, dramaLegacyKeyboard } = loadMenuFns()(makeRequire(true, true), require(path.join(__dirname, '..', 'lib', 'btn.js')));
  const all = [
    ...mainActionKeyboard('drama').inline_keyboard.flat(),
    ...mainActionKeyboard('anime').inline_keyboard.flat(),
    ...dramaLegacyKeyboard().inline_keyboard.flat(),
    ...animeTargetKeyboard('sam_go:gofile:abc123', 'sam_go:vt:gofile:abc123', 'sam_go:vyt:gofile:abc123', 'sam_go:vv:gofile:abc123').flat(),
  ];
  for (const b of all) {
    if (!b.callback_data) continue;
    assert.ok(Buffer.byteLength(b.callback_data, 'utf8') <= 64, `terlalu panjang: ${b.callback_data}`);
  }
});
t('gaya tombol: nilai style valid, tepat 1 primary, navigasi polos', () => {
  const BTN = require(path.join(__dirname, '..', 'lib', 'btn.js'));
  const { mainActionKeyboard, animeTargetKeyboard, dramaLegacyKeyboard } = loadMenuFns()(makeRequire(true, true), BTN);
  const styles = ['danger', 'success', 'primary'];
  const kbs = [
    ['drama', mainActionKeyboard('drama')],
    ['anime', mainActionKeyboard('anime')],
    ['legacy', dramaLegacyKeyboard()],
    ['animeTarget', { inline_keyboard: animeTargetKeyboard('t', 'v', 'y', 'w') }],
  ];
  for (const [label, kb] of kbs) {
    const all = kb.inline_keyboard.flat();
    for (const b of all) {
      if (b.style) assert.ok(styles.includes(b.style), label + ': style tak valid ' + b.style);
    }
    assert.strictEqual(BTN.countStyle(kb, 'primary'), 1, label + ': harus tepat 1 primary');
  }
  // primary drama & anime = target Vidoy+TG (rekomendasi terbaik)
  const d = mainActionKeyboard('drama').inline_keyboard.flat();
  assert.strictEqual(d.find((x) => x.style === 'primary').text, '🗜 Vidoy+TG — gabung 10');
  const a = mainActionKeyboard('anime').inline_keyboard.flat();
  assert.strictEqual(a.find((x) => x.style === 'primary').text, '📥 Vidoy + Telegram');
  // navigasi tidak boleh berwarna
  for (const txt of ['🏠 Menu Utama', '💬 Live Chat', '🔢 Pilih episode', '⚙️ Opsi per episode']) {
    for (const b of d) if (b.text === txt) assert.strictEqual(b.style, undefined, txt + ' tidak boleh berwarna');
  }
});

t('normalizeSegments: menerima ARRAY & string (regresi String().map — bug live)', () => {
  assert.deepStrictEqual(
    V.normalizeSegments(V.dramaFolderPath('Terobsesi Padanya Siang dan Malam')),
    ['VVIP AKSES', 'DATABASE', 'DRAMA', 'Terobsesi Padanya Siang dan Malam']
  );
  assert.deepStrictEqual(
    V.normalizeSegments('VVIP AKSES/DATABASE/ANIME/One Piece'),
    ['VVIP AKSES', 'DATABASE', 'ANIME', 'One Piece']
  );
  assert.deepStrictEqual(V.normalizeSegments(['A/B <C> 🎬']), ['A-B C'], 'per segmen disanitasi');
  assert.deepStrictEqual(V.normalizeSegments(null), []);
  assert.deepStrictEqual(V.normalizeSegments(''), []);
});

t('anti-drift: getOrCreateFolderPath WAJIB pakai normalizeSegments (bukan String().map)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'vidoy-uploader.js'), 'utf8');
  const body = src.slice(src.indexOf('async function getOrCreateFolderPath'), src.indexOf('async function upload'));
  assert.ok(body.includes('normalizeSegments(segments)'), 'getOrCreateFolderPath harus pakai normalizeSegments');
  assert.ok(!/String\(segments/.test(body), 'dilarang String(segments).map di body itu');
});

t('deleteItem: guard id kosong & jenis tak dikenal', () => {
  return Promise.all([
    V.deleteItem('folder', '').then((r) => assert.strictEqual(r.ok, false)),
    V.deleteItem('bogus', 'x').then((r) => assert.strictEqual(r.ok, false)),
  ]);
});
t('anti-drift: deleteItem pakai type+files (diform terverifikasi di /videos)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'vidoy-uploader.js'), 'utf8');
  assert.ok(src.includes('type=${kind}'), 'wajib kirim field type');
  assert.ok(src.includes('files=${id}'), 'wajib kirim field files');
  assert.ok(src.includes('`${VIDOY_BASE}/delete`'), 'endpoint /delete');
});

// ─── Skip/resume ( Vidoy: batch yang sudah ter-upload tak diulang ) ────────
const vidoyService = require('../services/vidoyService');
const vidoyU = require('../vidoy-uploader');

t('planBatchWork: batch yang punya record DB → skip', () => {
  const chunks = vidoyService.chunkEpisodes(Array.from({ length: 25 }, (_, i) => ({ ep: i + 1 })), 10);
  const plan = vidoyService.planBatchWork(chunks, [{ part: 1, link: 'https://vski.cc/e/aaa' }], {}, 10);
  assert.strictEqual(plan.length, 3);
  assert.strictEqual(plan[0].skip, true, 'part 1 harus skip');
  assert.strictEqual(plan[0].known.link, 'https://vski.cc/e/aaa');
  assert.strictEqual(plan[1].skip, false, 'part 2 baru');
  assert.strictEqual(plan[1].label, '11-20');
  assert.strictEqual(plan[2].label, '21-25');
});
t('planBatchWork: record tanpa link TIDAK di-skip (aman)', () => {
  const chunks = vidoyService.chunkEpisodes(Array.from({ length: 10 }, (_, i) => ({ ep: i + 1 })), 10);
  const plan = vidoyService.planBatchWork(chunks, [{ part: 1, link: null }], {}, 10);
  assert.strictEqual(plan[0].skip, false);
});
t('planBatchWork: fallback track.json (lolos dari DB kosong)', () => {
  const chunks = vidoyService.chunkEpisodes(Array.from({ length: 10 }, (_, i) => ({ ep: i + 1 })), 10);
  const plan = vidoyService.planBatchWork(chunks, [], { vidoyBatches: { '01-10': 'https://vski.cc/e/ttt' } }, 10);
  assert.strictEqual(plan[0].skip, true, 'harus skip dari track');
  assert.strictEqual(plan[0].known.link, 'https://vski.cc/e/ttt');
});
t('track file: tulis & baca ulang konsisten', () => {
  const f = path.join(require('os').tmpdir(), `vidoy-track-test-${Date.now()}.json`);
  vidoyService.saveTrack(f, { vidoyBatches: { '01-10': 'https://vski.cc/e/x' } });
  const back = vidoyService.loadTrack(f);
  assert.strictEqual(back.vidoyBatches['01-10'], 'https://vski.cc/e/x');
  assert.strictEqual(vidoyService.trackFileFor('/tmp/drama/work'), '/tmp/drama/track.json');
  fs.unlinkSync(f);
});

// ─── Urutan operasi Vidoy+TG (pola Vidara: per batch, hapus setelah terkirim) ──
t('uploadBatches: urutan download→concat→upload→afterUpload→hapus file merge', async () => {
  const fsx = require('fs');
  const osx = require('os');
  const pathx = require('path');
  const workDir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'vidoy-order-'));
  const order = [];
  const eps = Array.from({ length: 10 }, (_, i) => ({ ep: i + 1 }));
  const res = await vidoyService.uploadBatches({
    kind: 'drama', mediaKey: 'unit-test', title: 'Unit Drama', episodes: eps,
    resolveVideoUrl: async () => 'https://x/v.mp4',
    batchSize: 10, workers: 1, workDir,
    deps: {
      downloadChunk: async (chunk) => { order.push('download'); return chunk.map(() => '/tmp/fake.mp4'); },
      ffmpegConcat: async (inp, out) => { order.push('concat'); fsx.writeFileSync(out, 'x'); },
    },
    afterUpload: async () => { order.push('telegram'); },
  });
  const merged = pathx.join(workDir, `${vidoyU.sanitizeFolderName('Unit Drama')} — Ep 01-10.mp4`);
  assert.strictEqual(res.done, 1, 'satu batch sukses');
  assert.ok(order.indexOf('download') < order.indexOf('concat'), 'download sebelum concat');
  assert.ok(order.indexOf('concat') < order.indexOf('telegram'), 'concat sebelum telegram');
  assert.ok(!fsx.existsSync(merged), 'file merge harus dihapus setelah terkirim (hemat disk)');
  fsx.rmSync(workDir, { recursive: true, force: true });
});

// ─── File ditahan sampai VIDOY + TELEGRAM sama-sama sukses ────────────────
function fakeDeps(order) {
  const fsx = require('fs');
  return {
    downloadChunk: async (chunk) => { order.push('download'); return chunk.map(() => '/tmp/fake.mp4'); },
    ffmpegConcat: async (inp, out) => { order.push('concat'); fsx.writeFileSync(out, 'x'); },
  };
}
function runBatches(workDir, extra) {
  return vidoyService.uploadBatches(Object.assign({
    kind: 'drama', mediaKey: 'unit-tg', title: 'Unit TG', episodes: Array.from({ length: 10 }, (_, i) => ({ ep: i + 1 })),
    resolveVideoUrl: async () => 'https://x/v.mp4', batchSize: 10, workers: 1, workDir,
  }, extra));
}

t('TG sukses → file merge DIHAPUS', async () => {
  const fsx = require('fs'); const osx = require('os'); const pathx = require('path');
  const wd = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'vidoy-tg-ok-'));
  const order = [];
  const res = await runBatches(wd, { deps: fakeDeps(order), afterUpload: async () => { order.push('tg'); return true; } });
  const merged = pathx.join(wd, `${vidoyU.sanitizeFolderName('Unit TG')} — Ep 01-10.mp4`);
  assert.strictEqual(res.done, 1);
  assert.ok(!fsx.existsSync(merged), 'file harus terhapus setelah dua-duanya sukses');
  assert.deepStrictEqual(order, ['download', 'concat', 'tg']);
  fsx.rmSync(wd, { recursive: true, force: true });
});

t('TG GAGAL → file merge DITAHAN & ditandai telegramPending', async () => {
  const fsx = require('fs'); const osx = require('os'); const pathx = require('path');
  const wd = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'vidoy-tg-fail-'));
  const res = await runBatches(wd, { deps: fakeDeps([]), afterUpload: async () => false });
  const merged = pathx.join(wd, `${vidoyU.sanitizeFolderName('Unit TG')} — Ep 01-10.mp4`);
  assert.strictEqual(res.done, 1, 'Vidoy tetap sukses');
  assert.ok(fsx.existsSync(merged), 'file harus DITAHAN saat TG gagal');
  assert.ok(res.items[0].telegramPending, 'item ditandai telegramPending');
  fsx.rmSync(wd, { recursive: true, force: true });
});

t('retry: batch tersimpan + file ada → kirim TG tanpa unduh, lalu hapus', async () => {
  const fsx = require('fs'); const osx = require('os'); const pathx = require('path');
  const wd = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'vidoy-tg-retry-'));
  const merged = pathx.join(wd, `${vidoyU.sanitizeFolderName('Unit TG')} — Ep 01-10.mp4`);
  fsx.writeFileSync(merged, 'x');
  // bypass Vidoy: seed track + DB lookup via track (mediaKey tak ada di DB)
  fsx.writeFileSync(pathx.join(wd, '..', 'track.json'), JSON.stringify({
    vidoyBatches: { '01-10': { link: 'https://vski.cc/e/pre', mergedPath: merged, tgSent: false } },
  }));
  const order = [];
  const res = await runBatches(wd, { deps: fakeDeps(order), afterUpload: async () => { order.push('tg'); return true; } });
  assert.ok(!order.includes('download'), 'TIDAK boleh unduh ulang');
  assert.ok(order.includes('tg'), 'harus kirim ke channel');
  assert.ok(!fsx.existsSync(merged), 'file dihapus setelah terkirim');
  assert.ok(res.items[0].tgResent, 'item ditandai tgResent');
  assert.strictEqual(res.skipped, 1, 'tetap dihitung skip (tak ada upload ulang)');
  fsx.rmSync(wd, { recursive: true, force: true });
  try { fs.unlinkSync(pathx.join(osx.tmpdir(), pathx.basename(pathx.dirname(wd)), 'track.json')); } catch {}
});

t('track entry string lama tetap kompatibel (backward-compatible)', () => {
  const n = vidoyService.normalizeTrackEntry('https://vski.cc/e/legacy');
  assert.strictEqual(n.link, 'https://vski.cc/e/legacy');
  assert.strictEqual(n.tgSent, null, 'tgSent tak diketahui untuk entri lama');
});

// ─── Caption ber-link + panel refresh link ──────────────────────────────────
const vidoyHandlers = require('../handlers/vidoy');

t('caption drama: format "1 (Ep 1–10)" + Judul/Provider/Link (anchor)', () => {
  const cap = vidoyHandlers.buildCaption({ title: 'Terobsesi Padanya Siang dan Malam', provider: 'dramawave', part: 1, epStart: 1, epEnd: 10, link: 'https://vski.cc/e/ru9a4av12kd9' });
  assert.ok(cap.includes('➧ Judul :- <b>Terobsesi Padanya Siang dan Malam</b>'), cap);
  assert.ok(cap.includes('➧ Part/Episode :- 1 (Ep 1–10)'), cap);
  assert.ok(cap.includes('➧ Provider :- dramawave'), cap);
  assert.ok(!cap.includes('Server :-'), 'baris Server dihapus sesuai spek: ' + cap);
  assert.ok(!cap.includes('Tipe :-'), 'baris Tipe dihapus sesuai spek: ' + cap);
  assert.ok(cap.includes('<a href="https://vski.cc/e/ru9a4av12kd9">vski.cc/e/ru9a4av12kd9</a>'), 'link jadi anchor ringkas: ' + cap);
  assert.ok(!cap.includes('/f/'), 'folder tak ikut di caption (permintaan: link saja)');
});
t('caption anime: episode tunggal → "Episode :- 8" (format spek user)', () => {
  const cap = vidoyHandlers.buildCaption({ title: 'One Piece', provider: 'samehadaku', part: 8, epStart: 8, epEnd: 8, link: 'https://vski.cc/e/abc' });
  assert.ok(cap.includes('\u27a7 Episode :- 8'), 'label episode tunggal salah: ' + cap);
  assert.ok(!cap.includes('Part/Episode'), 'episode tunggal tidak pakai label Part/Episode: ' + cap);
  assert.ok(!cap.includes('undefined'), cap);
});

t('caption drama: rentang tetap "Part/Episode :- 1 (Ep 1–10)"', () => {
  const cap = vidoyHandlers.buildCaption({ title: 'X', provider: 'dramawave', part: 1, epStart: 1, epEnd: 10, link: 'https://vski.cc/e/abc' });
  assert.ok(cap.includes('\u27a7 Part/Episode :- 1 (Ep 1\u201310)'), 'label drama salah: ' + cap);
  const cap2 = vidoyHandlers.buildCaption({ title: 'X', provider: 'dramawave', part: 7, epStart: 61, epEnd: 68, link: 'https://vski.cc/e/abc' });
  assert.ok(cap2.includes('\u27a7 Part/Episode :- 7 (Ep 61\u201368)'), 'label part 7 salah: ' + cap2);
});
t('caption: karakter HTML berbahaya di-neutralkan (anti 400 / anti injeksi)', () => {
  const cap = vidoyHandlers.buildCaption({ title: 'Tom & Jerry <script>alert(1)</script>', provider: 'x&y', part: 1, epStart: 1, epEnd: 1, link: 'https://vski.cc/e/a?x=1&y=2' });
  assert.ok(!/Tom & Jerry/.test(cap), 'ampersand harus ter-escape: ' + cap);
  assert.ok(!cap.includes('<script>'), 'tag berbahaya tidak boleh lolos: ' + cap);
  assert.ok(cap.includes('&lt;script&gt;'), 'tag berbahaya jadi teks: ' + cap);
  assert.ok(cap.includes('&amp;y='), 'query link ter-escape: ' + cap);
});
t('caption: tanpa link tetap valid (tak ada baris Link)', () => {
  const cap = vidoyHandlers.buildCaption({ title: 'X', provider: 'p', epStart: 1, epEnd: 2 });
  assert.ok(!cap.includes('➧ Link'), 'tak ada baris Link saat link kosong');
});
t('shortLinkLabel: label WAJIB sama dengan domain URL (tidak boleh domain hardcode)', () => {
  for (const url of ['https://vski.cc/e/abc', 'https://vidkud.com/e/abc', 'https://abc.tv/d/xyz', 'https://foo.net/e/z1-2_3']) {
    const label = vidoyHandlers.shortLinkLabel(url);
    if (label.includes('vidoy.asia')) throw new Error('masih pakai domain hardcode: ' + url + ' → ' + label);
    const host = new URL(url).host;
    if (!label.startsWith(host + '/')) throw new Error('label tidak ikut domain asli: ' + url + ' → ' + label);
  }
  const cap = vidoyHandlers.buildCaption({ title: 'X', provider: 'p', part: 1, epStart: 1, epEnd: 10, link: 'https://vski.cc/e/abc' });
  if (!cap.includes('>vski.cc/e/abc</a>')) throw new Error('label caption tidak ikut domain: ' + cap);
});

t('shortLinkLabel: ringkas tapi tetap klik-buka penuh', () => {
  assert.strictEqual(vidoyHandlers.shortLinkLabel('https://vski.cc/e/ru9a4av12kd9'), 'vski.cc/e/ru9a4av12kd9');
  assert.strictEqual(vidoyHandlers.shortLinkLabel('https://abc.tv/d/xyz'), 'abc.tv/d/xyz');
  assert.strictEqual(vidoyHandlers.shortLinkLabel('bukan-url'), 'bukan-url');
});

t('anti-drift: admin panel punya tombol Vidoy Links & refreshVidoyLink ada', () => {
  const fsx = require('fs');
  const botSrc = fsx.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
  const adminSrc = fsx.readFileSync(path.join(__dirname, '..', 'handlers', 'admin.js'), 'utf8');
  // Sumber kebenaran tunggal: keyboard admin panel hanya di handlers/admin.js
  assert.ok(adminSrc.includes("act:vidoy_links'"), 'tombol panel harus ada di handlers/admin.js');
  assert.ok(!/^function adminPanelKeyboard\(/m.test(botSrc), 'duplikat adminPanelKeyboard di bot.js harus dihapus');
  assert.ok(botSrc.includes('_adminHandlers.adminPanelKeyboard('), 'bot.js harus memakai keyboard dari handler');
  assert.ok(botSrc.includes("act === 'vidoy_link_all'"), 'routing refresh semua');
  assert.ok(botSrc.includes("act.startsWith('vidoy_link_one:')"), 'routing refresh satu');
  assert.ok(adminSrc.includes('async function handleVidoyLinks'), 'handler panel');
  assert.ok(adminSrc.includes('async function refreshVidoyLink'), 'handler refresh link');
  assert.ok(adminSrc.includes('editMessageText'), 'refresh harus edit caption pesan lama');
  assert.ok(adminSrc.includes('Vidoy.fetchPublicLink'), 'ambil link terbaru dari dashboard');
});
t('anti-drift: db punya kolom pointer pesan & update link', () => {
  const dbSrc = require('fs').readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  for (const col of ['tg_chat_id', 'tg_message_id', 'link_checked_at', 'link_alive']) {
    assert.ok(dbSrc.includes(`ADD COLUMN IF NOT EXISTS ${col}`), 'kolom ' + col + ' wajib dimigrasikan');
  }
  assert.ok(dbSrc.includes('async function updateVidoyLink'), 'updateVidoyLink');
  assert.ok(dbSrc.includes('async function setVidoyTelegramPointer'), 'setVidoyTelegramPointer');
});

t('batch ter-skip tanpa file lokal → unduh ulang HANYA untuk Telegram (tak upload ulang ke host)', async () => {
  const fsx = require('fs'); const osx = require('os'); const pathx = require('path');
  const wd = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'vidoy-skip-redl-'));
  const order = [];
  let uploads = 0;
  // seed: Vidoy sudah punya batch ini (DB kosong, tapi track string lama = entri legacy)
  fsx.writeFileSync(pathx.join(wd, '..', 'track.json'), JSON.stringify({ vidoyBatches: { '01-10': 'https://vski.cc/e/legacy' } }));
  const res = await runBatches(wd, {
    deps: fakeDeps(order),
    afterUpload: async () => { order.push('tg'); return true; },
  });
  assert.strictEqual(res.skipped, 1, 'tak ada upload baru');
  assert.ok(order.includes('download'), 'harus unduh ulang untuk kirim Telegram');
  assert.ok(order.includes('tg'), 'harus kirim ke Telegram');
  assert.ok(!order.includes('upload'), 'TIDAK boleh upload ulang ke host');
  assert.ok(res.items[0].tgResent, 'ditandai tgResent');
  assert.ok(res.items[0].redownloaded, 'ditandai redownloaded');
  const track = JSON.parse(fsx.readFileSync(pathx.join(wd, '..', 'track.json'), 'utf8'));
  assert.strictEqual(track.vidoyBatches['01-10'].tgSent, true, 'tgSent=true → run berikutnyatak unduh lagi');
  assert.strictEqual(track.vidoyBatches['01-10'].mergedPath, null, 'path dibersihkan');
  fsx.rmSync(wd, { recursive: true, force: true });
  try { fs.unlinkSync(pathx.join(osx.tmpdir(), pathx.basename(pathx.dirname(wd)), 'track.json')); } catch {}
});

t('alur VIDOYY SAJA: batch ter-skip tak pernah unduh ulang', async () => {
  const fsx = require('fs'); const osx = require('os'); const pathx = require('path');
  const wd = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'vidoy-skip-only-'));
  const order = [];
  fsx.writeFileSync(pathx.join(wd, '..', 'track.json'), JSON.stringify({ vidoyBatches: { '01-10': { link: 'https://vski.cc/e/only', tgSent: false } } }));
  const res = await runBatches(wd, { deps: fakeDeps(order) });
  assert.strictEqual(res.skipped, 1);
  assert.ok(!order.includes('download'), 'tanpa afterUpload → tak ada unduhan sama sekali');
  fsx.rmSync(wd, { recursive: true, force: true });
  try { fs.unlinkSync(pathx.join(osx.tmpdir(), pathx.basename(pathx.dirname(wd)), 'track.json')); } catch {}
});

console.log(`RESULT: ${passed} pass, ${failed} fail`);

// ── KRITIS: resolveDirectUrl harus baca field yang BENAR untuk SEMUA provider ──
// Kelas bug: provider mengembalikan { fileUrl } tapi dispatcher baca .url → null.
// Sudah terjadi 3x (gofile, pixeldrain, gdriveplayer). Test ini mengunci SEMUA.
t('resolveDirectUrl: field URL dibaca benar untuk SEMUA provider', () => {
  const D = require('fs').readFileSync(require.resolve('../handlers/download'), 'utf8');
  const i = D.indexOf('async function resolveDirectUrl');
  const body = D.slice(i, D.indexOf('\n}', i));
  // gofile → provider kembalikan { url, name, size }
  if (!/isGofileUrl\(url\)[\s\S]*?file\.url \|\| file\.link/.test(body)) throw new Error('gofile: harus baca file.url');
  // pixeldrain → provider kembalikan { directUrl }
  if (!/isPixeldrainUrl\(url\)[\s\S]*?info\.directUrl \|\| info\.url/.test(body)) throw new Error('pixeldrain: harus baca info.directUrl');
  // filedon → provider kembalikan { url }
  if (!/isFiledonUrl\(url\)[\s\S]*?f\?\.url/.test(body)) throw new Error('filedon: harus baca f.url');
  // gdriveplayer → provider kembalikan { fileUrl, fileName }
  if (!/isGdrivePlayerUrl\(url\)[\s\S]*?f\.fileUrl \|\| f\.url/.test(body)) throw new Error('gdriveplayer: harus baca f.fileUrl');
  // gdrive → provider kembalikan { url }
  if (!/isGdriveUrl\(url\)[\s\S]*?f\?\.url/.test(body)) throw new Error('gdrive: harus baca f.url');
  // mega → tidak ada URL langsung, harus return null (bukan baca f.url yang undefined)
  const mega = body.slice(body.indexOf('isMegaUrl(url)'), body.indexOf('}', body.indexOf('isMegaUrl(url)')));
  if (/f\?\.url/.test(mega)) throw new Error('mega: tidak boleh membaca f.url (tidak ada URL langsung)');
});

t('anti-drift: return shape provider cocok dengan yang dibaca dispatcher', () => {
  const fs = require('fs');
  const rd = (f) => fs.readFileSync(require.resolve(f), 'utf8');
  const checks = [
    ['../providers/gofile', /files\.push\(\{[\s\S]{0,140}?\}\)/, /\burl:/, 'gofile harus kembalikan key "url"'],
    ['../providers/pixeldrain', /return \{[^}]*directUrl:/, /\bdirectUrl:/, 'pixeldrain harus kembalikan "directUrl"'],
    ['../providers/filedon', /return \{ url: /, /return \{ url: /, 'filedon harus kembalikan { url }'],
    ['../providers/gdriveplayer', /return \{[^}]*fileUrl:/, /\bfileUrl:/, 'gdriveplayer harus kembalikan "fileUrl"'],
    ['../providers/gdrive', /return \{ url/, /return \{ url/, 'gdrive harus kembalikan { url }'],
  ];
  for (const [f, retRe, fieldRe, msg] of checks) {
    const src = rd(f);
    const ret = (src.match(retRe) || []).join(' ');
    if (!ret || !fieldRe.test(ret)) throw new Error(msg + ' — ditemukan: ' + ret.slice(0, 60));
  }
  // mega: TIDAK boleh mengembalikan { url } (karena butuh streaming)
  const mega = rd('../providers/mega');
  if (/return \{[^}]*url:/.test(mega)) throw new Error('mega tidak boleh mengembalikan { url } — butuh streaming');
});


// ── REGRESSION: alur provider langsung punya pilihan target (konsisten) ──────
t('provider langsung: setelah judul, tampilkan pilihan target (bukan langsung TG)', () => {
  const B = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  if (!/async function resolveProviderTitle/.test(B)) throw new Error('resolveProviderTitle tidak ada');
  const i = B.indexOf("if (data.startsWith('dl_title_use:')");
  const body = B.slice(i, B.indexOf("if (data.startsWith('dl_go:')", i));
  if (!/animeTargetKeyboard\(`dl_go:tg:\$\{urlId\}`, `dl_go:vyt:\$\{urlId\}`, `dl_go:vv:\$\{urlId\}`\)/.test(body)) {
    throw new Error('provider langsung tidak menampilkan pilihan target');
  }
  if (/handleGofileUrl\(chatId, url, detectedTitle/.test(body)) {
    throw new Error('provider langsung masih langsung ke Telegram tanpa tanya target');
  }
});

t('provider langsung: handler dl_go menangani tg & Vidoy', () => {
  const B = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  const i = B.indexOf("if (data.startsWith('dl_go:'))");
  if (i < 0) throw new Error('handler dl_go tidak ada');
  const body = B.slice(i, B.indexOf('\n  }\n', i));
  if (!/target === 'tg'/.test(body)) throw new Error('tidak ada cabang target tg');
  if (!/actionAnimeEpisode/.test(body)) throw new Error('tidak ada cabang Vidoy');
  if (!/resolveDirectUrl/.test(body)) throw new Error('cabang Vidoy tidak resolve direct URL');
  if (/vt/.test(body)) throw new Error('target vt (Vidara) tidak boleh ada');
});

t('target vv = Vidoy saja (bukan Vidara+Vidoy)', () => {
  const V = require('fs').readFileSync(require.resolve('../handlers/vidoy'), 'utf8');
  const i = V.indexOf('const needVidoy');
  const body = V.slice(i, V.indexOf('\n', i + 200));
  if (!/needVidoy = target === 'vyt' \|\| target === 'vv'/.test(body)) throw new Error('vv harus tetap butuh Vidoy');
  if (!/needVidara = false/.test(body)) throw new Error('Vidara tidak boleh dipakai lagi');
  if (!/needTg = target === 'tg' \|\| target === 'vyt'/.test(body)) throw new Error('vv tidak butuh Telegram');
});


// ── REGRESSION: tampilan setelah single-episode konsisten di semua target ────
t('setelah download single-episode, semua target tampilkan episode picker', () => {
  const B = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  if (!/async function showEpisodePickerAfterDownload/.test(B)) {
    throw new Error('helper showEpisodePickerAfterDownload tidak ada');
  }
  const calls = (B.match(/await showEpisodePickerAfterDownload\(/g) || []).length;
  if (calls !== 2) {
    throw new Error('harus dipanggil di 2 jalur (tg & vidoy), ditemukan: ' + calls);
  }
  // helper wajib memakai picker yang sama dengan sam_back
  const i = B.indexOf('async function showEpisodePickerAfterDownload');
  const body = B.slice(i, B.indexOf('\n  }', i));
  if (!/buildSamehadakuEpisodePicker\(res\.episodes, animeUrl\)/.test(body)) {
    throw new Error('harus memakai buildSamehadakuEpisodePicker yang sama dengan sam_back');
  }
  if (!/editMessageText\(caption/.test(body)) {
    throw new Error('harus edit pesan yang sama, bukan kirim pesan baru');
  }
  // di dalam handler sam_go TIDAK BOLEH ada pesan polos sebagai satu-satunya tampilan
  const sg = B.indexOf("if (data.startsWith('sam_go:'))");
  const sgBody = B.slice(sg, B.indexOf("\n  // ─── Kuronime", sg));
  if (/sendMessage\(chatId, `⬅️ Kembali ke list episode\?`/.test(sgBody)) {
    throw new Error('jalur Samehadaku masih memakai pesan polos, harusnya episode picker');
  }
  if (!/await showEpisodePickerAfterDownload\(chatId, msgId, animeUrlBack\)/.test(sgBody)) {
    throw new Error('jalur Samehadaku tidak menampilkan episode picker');
  }
});


// ── REGRESSION: validasi unduhan berlaku di SEMUA jalur, termasuk Telegram ────
t('validasi juga aktif di downloadWithAria2c (jalur Telegram)', () => {
  const D = require('fs').readFileSync(require.resolve('../downloader'), 'utf8');
  if (!/assertLooksLikeVideo\(outPath\)/.test(D)) {
    throw new Error('downloadWithAria2c tidak memvalidasi hasil unduh — celah yang sama seperti vidaraService');
  }
  const i = D.indexOf('assertLooksLikeVideo(outPath)');
  const sizeCheck = D.indexOf("sizeBytes < 1024", i - 600);
  if (i < 0 || sizeCheck < 0 || i < sizeCheck) {
    throw new Error('validasi harus dijalankan setelah download selesai');
  }
  if (!/require\('\.\/services\/vidaraService'\)/.test(D)) {
    throw new Error('assertLooksLikeVideo tidak diimpor dari vidaraService');
  }
});

t('satu sumber validasi untuk semua jalur', () => {
  // Semua titik unduh wajib memakai validator yang sama — kalau ada duplikat
  // logika validasi, jalur yang tidak ter-update akan diam-diam tertinggal.
  const files = ['downloader', 'services/vidaraService', 'handlers/download'];
  const n = files.map((f) => (require('fs').readFileSync(require.resolve('../' + f), 'utf8').match(/assertLooksLikeVideo/g) || []).length);
  if (n[0] < 1) throw new Error('downloader.js tidak memanggil validator');
  if (n[1] < 2) throw new Error('vidaraService.js harus mendefinisikan DAN memanggil validator');
  if (n[2] !== 0) throw new Error('handlers/download.js tidak boleh punya logika validasi sendiri');
});


// ── REGRESSION: file hasil unduh WAJIB divalidasi sebelum upload ─────────────
t('validasi unduhan: HTML / JSON / indeterminate-kecil ditolak, MP4 sah lolos', () => {
  const fs = require('fs');
  const os = require('os');
  const { assertLooksLikeVideo } = require('../services/vidaraService');
  const tmp = (buf) => os.tmpdir() + '/_mv_' + Math.random().toString(36).slice(2) + '.bin';
  const mk = (buf) => { const p = tmp(); fs.writeFileSync(p, buf); return p; };
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(2000)]);
  const MKV = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2000)]);
  const HTML = Buffer.from('<!doctype html>\n<html><head><title>Gofile needs JavaScript to run</title></head><body>' + 'x'.repeat(3200) + '</body></html>');
  const TAKEDOWN = Buffer.from(JSON.stringify({ success: false, value: 'unavailable_for_legal_reasons', message: 'takedown report' }));

  // harus LOLOS: signature container otoritatif, ukuran sekecil apa pun
  for (const [label, buf] of [['MP4 kecil', MP4], ['MKV/Matroska', MKV]]) {
    const p = mk(buf);
    try { assertLooksLikeVideo(p); }
    catch (e) { throw new Error(label + ' seharusnya lolos, tapi ditolak: ' + e.message); }
    finally { try { fs.unlinkSync(p); } catch {} }
  }
  // harus TERTOLAK
  const harusGagal = [
    ['HTML 3 KB', HTML, /bukan video/i],
    ['JSON takedown', TAKEDOWN, /ditolak provider/i],
    ['kecil tanpa signature', Buffer.alloc(2048, 0x41), /tidak dikenali dan terlalu kecil/i],
  ];
  for (const [label, buf, pola] of harusGagal) {
    const p = mk(buf);
    let err = null;
    try { assertLooksLikeVideo(p); } catch (e) { err = e; }
    finally { try { fs.unlinkSync(p); } catch {} }
    if (!err) throw new Error(label + ' seharusnya ditolak, tapi LOLOS → file palsu akan ikut terupload');
    if (!pola.test(err.message)) throw new Error(label + ' pesan error tidak jelas: ' + err.message.slice(0, 70));
  }
});

t('validasi unduhan dipanggil di ensureMp4 (bukan cuma tersedia)', () => {
  const V = require('fs').readFileSync(require.resolve('../services/vidaraService'), 'utf8');
  const i = V.indexOf('async function ensureMp4');
  const body = V.slice(i, V.indexOf('\n}\n', i + 10));
  if (!/assertLooksLikeVideo\(destPath\)/.test(body)) {
    throw new Error('ensureMp4 tidak memvalidasi hasil unduh → bug HTML 3 KB bisa terulang');
  }
  // validasi harus DI SETELAH download, SEBELUM return
  const dl = body.indexOf('await downloadTo(url, destPath)');
  const va = body.indexOf('assertLooksLikeVideo(destPath)');
  if (va < dl) throw new Error('validasi harus dijalankan setelah download');
});

t('gofile: kedua jalur (Telegram & Vidoy) kirim header auth yang sama', () => {
  // Jalur Telegram sudah bekerja lebih dulu — Vidoy WAJIB menirunya.
  const D = require('fs').readFileSync(require.resolve('../handlers/download'), 'utf8');
  const V = require('fs').readFileSync(require.resolve('../services/vidaraService'), 'utf8');
  if (!/Authorization':\s*`Bearer \$\{gofileToken\}`/.test(D)) throw new Error('jalur Telegram kehilangan header auth gofile');
  if (!/Authorization = `Bearer \$\{gofileTok\}`/.test(V)) throw new Error('jalur Vidoy tidak meniru header auth gofile');
  if (!/gofileToken/.test(D) || !/gofileTok/.test(V)) throw new Error('sumber token harus GOFILE_TOKEN di kedua jalur');
});


// ── REGRESSION: jalur Vidoy harus bisa unduh file gofile (header auth) ───────
t('vidaraService.downloadTo mengirim header auth gofile', () => {
  const V = require('fs').readFileSync(require.resolve('../services/vidaraService'), 'utf8');
  const i = V.indexOf('async function downloadTo');
  if (i < 0) throw new Error('downloadTo tidak ada');
  const body = V.slice(i, V.indexOf('\n}', i));
  if (!/GOFILE_TOKEN/.test(body)) throw new Error('header auth gofile tidak ikut');
  if (!/Authorization/.test(body) || !/Bearer/.test(body)) throw new Error('Authorization: Bearer tidak dikirim');
  if (!/gofile\\\.io/.test(body)) throw new Error('deteksi host gofile tidak ada');
});

t('konsistensi: jalur Telegram dan jalur Vidoy sama-sama pakai Authorization gofile', () => {
  const D = require('fs').readFileSync(require.resolve('../handlers/download'), 'utf8');
  const n = (D.match(/Authorization':\s*`Bearer \$\{gofileToken\}`/g) || []).length;
  if (n < 1) throw new Error('jalur Telegram (handlers/download.js extraHeaders) tidak mengirim Authorization gofile');
  const V = require('fs').readFileSync(require.resolve('../services/vidaraService'), 'utf8');
  if (!/Authorization = `Bearer \$\{gofileTok\}`/.test(V)) {
    throw new Error('jalur Vidoy (vidaraService.downloadTo) tidak mengirim Authorization gofile');
  }
});

t('anti-regresi: gofile HARUS pakai header auth, tanpa itu dapat HTML 3 KB', () => {
  // Fakta empiris (26 Sep 2026): tanpa Authorization → 3358 byte
  // "Gofile needs JavaScript to run"; dengan Authorization → MP4 asli.
  const V = require('fs').readFileSync(require.resolve('../services/vidaraService'), 'utf8');
  if (!/headers\.Referer\s*=\s*'https:\/\/gofile\.io\//.test(V)) {
    throw new Error('Referer gofile ikut hilang — store host bisa menolak');
  }
});


// ── REGRESSION: resolveDirectUrl harus baca field yang BENAR-BENAR dikembalikan provider ──
t('gofile: dispatcher baca file.url (bukan file.link)', () => {
  const D = require('fs').readFileSync(require.resolve('../handlers/download'), 'utf8');
  const i = D.indexOf('async function resolveDirectUrl');
  const body = D.slice(i, D.indexOf('\n}', i));
  const seg = body.slice(body.indexOf('isGofileUrl(url)'), body.indexOf('isPixeldrainUrl(url)'));
  if (!/file\.url \|\| file\.link/.test(seg)) {
    throw new Error('harus menerima file.url DAN file.link — resolveGofileFiles() mengembalikan { url, name, size }');
  }
  //-file.link boleh muncul HANYA sebagai fallback setelah file.url, bukan sebagai sumber utama
  if (/if \(!file\?\.link\) return null/.test(seg)) throw new Error('masih menolak file tanpa file.link');
  if (/return \{ url: file\.link/.test(seg)) throw new Error('url diambil dari file.link → gofile selalu gagal');
});

t('pixeldrain: dispatcher baca info.directUrl (bukan info.url)', () => {
  const D = require('fs').readFileSync(require.resolve('../handlers/download'), 'utf8');
  const i = D.indexOf('async function resolveDirectUrl');
  const body = D.slice(i, D.indexOf('\n}', i));
  const seg = body.slice(body.indexOf('isPixeldrainUrl(url)'), body.indexOf('isFiledonUrl(url)'));
  if (!/info\.directUrl \|\| info\.url/.test(seg)) {
    throw new Error('harus menerima info.directUrl DAN info.url — getPixeldrainInfo() mengembalikan { directUrl }');
  }
  if (/return info\?\.url \?/.test(seg)) throw new Error('masih membaca info.url → pixeldrain selalu gagal');
});

t('anti-drift: nama field yang dibaca dispatcher = field yang ditulis provider', () => {
  // gofile: fungsi push file harus memakai key "url"
  const G = require('fs').readFileSync(require.resolve('../providers/gofile'), 'utf8');
  const gofilePush = (G.match(/files\.push\(\{[\s\S]{0,140}?\}\)/g) || []).join(' ');
  if (!/\burl:/.test(gofilePush)) {
    throw new Error('resolveGofileFiles() tidak lagi mengembalikan key "url" — dispatcher harus ikut diperbarui: ' + gofilePush.slice(0, 80));
  }
  // pixeldrain: return block harus punya directUrl
  const P = require('fs').readFileSync(require.resolve('../providers/pixeldrain'), 'utf8');
  const i = P.indexOf('async function getPixeldrainInfo');
  const ret = P.slice(i, P.indexOf('\n  }', i));
  if (!/\bdirectUrl:/.test(ret)) {
    throw new Error('getPixeldrainInfo() tidak lagi mengembalikan "directUrl" — dispatcher harus ikut diperbarui');
  }
  // filedon tetap url (dipakai dispatcher)
  const F = require('fs').readFileSync(require.resolve('../providers/filedon'), 'utf8');
  if (!/return \{ url: /.test(F)) throw new Error('filedon bentuk return berubah — cek dispatcher filedon');
});


// ── REGRESSION: link + pointer vidoy di choke point sendAnimeMedia ──────────
t('link: withVidoyLink memakai keyPart (formula sama dgn vidoy.js:207)', () => {
  const D = require('fs').readFileSync(require.resolve('../handlers/download'), 'utf8');
  const i = D.indexOf('async function withVidoyLink');
  const body = D.slice(i, D.indexOf('\n}', i));
  if (!/withSeasonSuffix\(title, season, keyPart\)/.test(body)) {
    throw new Error('key harus pakai keyPart — kalau tidak, media_key untuk anime ber-season/part tidak akan cocok');
  }
  if (/withSeasonSuffix\(title, season, null\)/.test(body)) throw new Error('jangan kunci tanpa part');
});

t('tidak ada panggilan withVidoyLink di luar fungsi (regresi cleanTitle/batchPart)', () => {
  const D = require('fs').readFileSync(require.resolve('../handlers/download'), 'utf8');
  const calls = (D.match(/await withVidoyLink\(/g) || []).length;
  if (calls !== 1) throw new Error('withVidoyLink harus dipanggil tepat 1x (di choke point), ditemukan ' + calls);
  for (const bad of ['cleanTitle || customTitle, goPart', 'cleanTitle || customTitle, batchPart']) {
    if (D.includes(bad)) throw new Error('"' + bad + '" = variabel di luar scope → ReferenceError');
  }
});

t('choke point: initDownload membungkus sendAnimeMedia (1x, idempoten)', () => {
  const D = require('fs').readFileSync(require.resolve('../handlers/download'), 'utf8');
  const i = D.indexOf('function initDownload');
  const body = D.slice(i, D.indexOf('\n}', i));
  if (!/ctx\.sendAnimeMedia = async function trackedSendAnimeMedia/.test(body)) throw new Error('sendAnimeMedia tidak dibungkus');
  if (!/__animeTracked/.test(body)) throw new Error('wrap harus idempoten (initDownload dipanggil >1x)');
});

t('choke point: caption dapat link DAN pointer vidoy_uploads ditulis', () => {
  const D = require('fs').readFileSync(require.resolve('../handlers/download'), 'utf8');
  const i = D.indexOf('trackedSendAnimeMedia');
  const body = D.slice(i, D.indexOf('ctx.__animeTracked = true;', i));
  if (!/caption = await withVidoyLink\(/.test(body)) throw new Error('caption tidak mendapat link');
  if (!/setVidoyTelegramPointer\(key, 'anime', episode, cid, msgId\)/.test(body)) throw new Error('pointer tidak ditulis');
  if (!/\{ \.\.\.\(opts \|\| \{\}\), caption \}/.test(body)) throw new Error('caption hasil withVidoyLink tidak dikirim ke Telegram');
  const db = require('fs').readFileSync(require.resolve('../db'), 'utf8');
  if (!/UPDATE vidoy_uploads SET tg_chat_id = \$4, tg_message_id = \$5/.test(db)) throw new Error('setVidoyTelegramPointer harus UPDATE, bukan INSERT');
});

t('konteks episode di-set dan di-reset (tidak bocor ke episode berikutnya)', () => {
  const D = require('fs').readFileSync(require.resolve('../handlers/download'), 'utf8');
  const i = D.indexOf('async function downloadSamehadakuFile');
  const body = D.slice(i, D.indexOf('\nasync function ', i + 10));
  if (!/_curEpCtx = sameInfo \|\| null;/.test(body)) throw new Error('konteks episode tidak di-set');
  const f = body.lastIndexOf('} finally {');
  if (f < 0 || !/_curEpCtx = null;/.test(body.slice(f))) throw new Error('konteks episode tidak di-reset di finally');
});


// ── REGRESSION: !dell = hapus library + pesan Telegram, JANGAN link Vidoy ────
t('A: deleteMedia ikut menghapus media_parts (bukan hanya media)', () => {
  const src = require('fs').readFileSync(require.resolve('../db'), 'utf8');
  const i = src.indexOf('async function deleteMedia');
  const body = src.slice(i, src.indexOf('\n}', i));
  if (!/DELETE FROM media_parts WHERE media_slug = \$1/.test(body)) {
    throw new Error('media_parts tidak dihapus → episode tetap ditandai "sudah ada"');
  }
  if (!/DELETE FROM media WHERE slug = \$1/.test(body)) throw new Error('media tidak dihapus');
});

t('B: pointer Telegram vidoy dikosongkan, LINK TETAP ADA', () => {
  const src = require('fs').readFileSync(require.resolve('../db'), 'utf8');
  const i = src.indexOf('async function clearVidoyTelegramPointers');
  if (i < 0) throw new Error('clearVidoyTelegramPointers tidak ada');
  const body = src.slice(i, src.indexOf('\n}', i));
  if (!/SET tg_chat_id = NULL, tg_message_id = NULL/.test(body)) throw new Error('pointer tidak dikosongkan');
  if (/SET[^;]*link = NULL/.test(body)) throw new Error('JANGAN kosongkan link (ATURAN KERAS: link Vidoy tidak hilang)');
  if (!/UPDATE vidoy_uploads SET tg_chat_id = NULL/.test(body)) throw new Error('harus UPDATE (pointer), bukan menghapus record');
  if (/DELETE FROM vidoy_uploads/.test(body)) throw new Error('tidak boleh DELETE dari vidoy_uploads');
});

t('C: !dell menghapus pesan Telegram (library + vidoy) dan melaporkannya', () => {
  const B = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  if (!/async function deleteTelegramMessagesRaw/.test(B)) throw new Error('helper hapus pesan tidak ada');
  if (!/bot\.deleteMessage\(/.test(B)) throw new Error('tidak memanggil deleteMessage');
  if (!/deleted\+\+/.test(B)) throw new Error('tidak menghitung yang terhapus');
  const d = B.slice(B.indexOf('if (pending.part === null)'), B.indexOf('const ok = await deletePart'));
  for (const need of ['listPartTelegramPointers', 'listVidoyTelegramPointers', 'clearVidoyTelegramPointers', 'deleteMedia']) {
    if (!d.includes(need)) throw new Error('jalur !dell judul tidak memanggil ' + need);
  }
  if (!/Pesan Telegram dihapus:/.test(d)) throw new Error('tidak melapor jumlah pesan terhapus');
  if (!/Link Vidoy tetap disimpan/.test(d)) throw new Error('tidak melapor link Vidoy yang dipertahankan');
});

t('C: pointer pesan library disimpan saat library mengirim part', () => {
  const B = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  const n = (B.match(/setPartTelegramPointer\(/g) || []).length;
  if (n < 2) throw new Error('penyimpanan pointer harus di 2 situs kirim library: ' + n);
  if (!/setPartTelegramPointer,/.test(B)) throw new Error('tidak di-import dari ./db');
  const db = require('fs').readFileSync(require.resolve('../db'), 'utf8');
  if (!/UPDATE media_parts SET tg_chat_id = \$3, tg_message_id = \$4/.test(db)) {
    throw new Error('setPartTelegramPointer tidak menulis ke media_parts');
  }
});


// ── REGRESSION: flow Telegram-only ikut membawa link Vidoy ─────────────────
t('KONSISTENSI: flow Telegram (download.js) menambah baris Link dari Vidoy', () => {
  const D = require('fs').readFileSync(require.resolve('../handlers/download'), 'utf8');
  if (!/async function withVidoyLink/.test(D)) throw new Error('withVidoyLink tidak ada');
  if (!/getVidoyLink\(key, 'anime'/.test(D)) throw new Error('harus membaca link dari vidoy_uploads');
  // TIDAK boleh memanggil upload (tidak boleh ada uploadSingle di jalur ini)
  const fn = D.slice(D.indexOf('async function withVidoyLink'), D.indexOf('\n}', D.indexOf('async function withVidoyLink')));
  if (/uploadSingle|uploadFile|upload\(/.test(fn)) throw new Error('withVidoyLink tidak boleh upload');
  // Dipasang di SATU choke point (initDownload → sendAnimeMedia), bukan di tiap
  // leaf handler. Versi lama menyisipkan 2 baris di handleGofileUrl memakai
  // variabel di luar scope (cleanTitle/batchPart) → ReferenceError + link tidak
  // pernah muncul di jalur batch.
  const uses = (D.match(/await withVidoyLink\(/g) || []).length;
  if (uses !== 1) throw new Error('harus tepat 1x di choke point, ditemukan: ' + uses);
  if (!/function initDownload/.test(D)) throw new Error('choke point hilang');
  if (!/\u{1F4A7} Link :-/.test(D) && !/includes\('\\u2797 Link :-'\)/.test(D)) {
    throw new Error('harus mencegah baris Link dobel');
  }
});

t('db: getVidoyLink mengembalikan link episode yang ada', () => {
  const src = require('fs').readFileSync(require.resolve('../db'), 'utf8');
  if (!/async function getVidoyLink/.test(src)) throw new Error('getVidoyLink tidak ada di db');
  if (!/link IS NOT NULL/.test(src)) throw new Error('getVidoyLink harus memfilter link IS NOT NULL');
  if (!/kind = \$2 AND part = \$3/.test(src)) throw new Error('filter harus ikut kind + part');
  const exp = require('../db');
  if (typeof exp.getVidoyLink !== 'function') throw new Error('tidak diekspor');
});

t('lib/caption: satu sumber label link & suffix season untuk kedua flow', () => {
  const C = require('../lib/caption');
  if (C.shortLinkLabel('https://vski.cc/e/abc') !== 'vski.cc/e/abc') throw new Error('label salah');
  if (/vidoy\.asia/.test(C.vidoyLinkLine('https://vski.cc/e/abc'))) throw new Error('domain hardcode');
  if (C.vidoyLinkLine('') !== '') throw new Error('link kosong harus kosong');
  if (!/^➧ Link :- /.test(C.vidoyLinkLine('https://x.cc/e/a'))) throw new Error('baris Link salah');
  if (C.withSeasonSuffix('X', 2, 2) !== C.withSeasonSuffix(C.withSeasonSuffix('X', 2, 2), 2, 2)) {
    throw new Error('withSeasonSuffix tidak idempoten');
  }
  // handlers/vidoy.js tidak lagi punya definisi sendiri (hindari duplikasi)
  const V = require('fs').readFileSync(require.resolve('../handlers/vidoy'), 'utf8');
  if (/function shortLinkLabel\(/.test(V)) throw new Error('shortLinkLabel duplikat di vidoy.js');
  if (/function withSeasonSuffix\(/.test(V)) throw new Error('withSeasonSuffix duplikat di vidoy.js');
});


// ── REGRESSION: warna tombol episode = status (bukan 2 simbol) ─────────────
t('episodeButton: warna sesuai status, hanya satu per tombol', () => {
  const BOT = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  const grab = (name) => { const i = BOT.indexOf('function ' + name); let d = 0, j = BOT.indexOf('{', i);
    for (let k = j; k < BOT.length; k++) { if (BOT[k] === '{') d++; else if (BOT[k] === '}') { d--; if (!d) return BOT.slice(i, k + 1); } } };
  const f = new Function(grab('episodeButton') + '\nreturn episodeButton;')();
  // library + Telegram → biru (sudah terkirim), bukan hijau
  const lib = f({ lib: true, tg: true, link: 'l' }, 5, false);
  assert.strictEqual(lib.style, 'primary', 'sudah terkirim harus biru');

  // library SAJA → merah (perlu kirim), tidak hijau
  const libOnly = f({ lib: true, tg: false, link: null }, 15, false);
  assert.strictEqual(libOnly.style, 'danger', 'hanya library harus merah (belum ada pesannya)');
  const tg = f({ lib: false, tg: true, link: 'l' }, 6, false);
  assert.strictEqual(tg.style, 'primary', 'Telegram harus biru');
  const vo = f({ lib: false, tg: false, link: 'l' }, 7, false);
  assert.strictEqual(vo.style, 'danger', 'Vidoy saja harus merah');
  const none = f(null, 8, false);
  assert.strictEqual(none.style, null, 'belum ada tanpa warna');
  assert.ok(none.text.startsWith('Ep '), 'label polos: ' + none.text);
  const fb = f(null, 9, true);
  assert.strictEqual(fb.style, 'success', 'fallback done harus hijau');
  for (const o of [lib, tg, vo, none, fb]) {
    assert.ok(['primary', 'success', 'danger', null].includes(o.style), 'style tak valid: ' + o.style);
  }
  // satu simbol saja per tombol: tidak boleh ada dua emoji sekaligus
  const emojiCount = (t) => (t.match(/[\u2705\u{1F4E8}\u{1F5C4}]/gu) || []).length;
  for (const o of [lib, tg, vo, none, fb]) {
    if (emojiCount(o.text) > 1) throw new Error('lebih dari satu simbol: ' + o.text);
  }
});

t('statusBreakdown: menghitung library / Telegram / Vidoy / belum', () => {
  const BOT = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  const i = BOT.indexOf('function statusBreakdown');
  let d = 0, j = BOT.indexOf('{', i);
  for (let k = j; k < BOT.length; k++) { if (BOT[k] === '{') d++; else if (BOT[k] === '}') { d--; if (!d) { j = k; break; } } }
  const f = new Function(BOT.slice(i, j + 1) + '\nreturn statusBreakdown;')();
  const m = new Map([
    [1, { lib: true, tg: true, link: 'l' }],
    [2, { lib: false, tg: true, link: 'l' }],
    [3, { lib: false, tg: false, link: 'l' }],
    [4, { lib: true, tg: false, link: null }],
  ]);
  const out = f(m, 10);
  if (!/📨 2 di Telegram/.test(out)) throw new Error('telegram: ' + out);
  if (!/🗄 2 perlu dikirim/.test(out)) throw new Error('perlu dikirim: ' + out);
  if (!/⬜ 6 belum ada/.test(out)) throw new Error('belum ada: ' + out);
  if (/di Vidoy|di library/.test(out)) throw new Error('kategori lama tidak boleh muncul: ' + out);
});

t('kedua picker memakai episodeButton + style, dan label "sudah ada"', () => {
  const BOT = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  const n = (BOT.match(/episodeButton\(statusMap\.get\(/g) || []).length;
  if (n < 2) throw new Error('kedua picker harus memakai episodeButton: ' + n);
  if ((BOT.match(/statusBreakdown\(statusMap, total\)/g) || []).length < 2) {
    throw new Error('kedua caption picker harus memakai statusBreakdown');
  }
  if (!/b\.style \? \{ style: b\.style \} : \{\}/.test(BOT)) throw new Error('style tidak dipasang ke tombol');
  const SK = require('fs').readFileSync(require.resolve('../lib/samKeyboard'), 'utf8');
  if (SK.includes('Semua episode sudah di library')) throw new Error('label misleading: done = library ∪ Telegram');
  if (!SK.includes('Semua episode sudah ada')) throw new Error('label harus "sudah ada"');
});


// ── REGRESSION: deteksi "sudah ada" di picker = library ∪ Telegram ─────────
t('KRITIS: episodeStatusMap menggabungkan library + Telegram', () => {
  const BOT = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  const i = BOT.indexOf('async function episodeStatusMap');
  if (i < 0) throw new Error('episodeStatusMap tidak ada');
  let d = 0, j = BOT.indexOf('{', i);
  for (let k = j; k < BOT.length; k++) { if (BOT[k] === '{') d++; else if (BOT[k] === '}') { d--; if (!d) { j = k; break; } } }
  const code = BOT.slice(i, j + 1);
  const f = new Function('listPartsWithFile', 'listVidoyUploads', code + '\nreturn episodeStatusMap;')(
    async () => ([{ part: 1 }, { part: 2 }]),
    async () => ([
      { part: 2, link: 'l2', tg_chat_id: -100, tg_message_id: 5 },
      { part: 3, link: 'l3', tg_chat_id: -100, tg_message_id: 6 },
      { part: 4, link: 'l4', tg_chat_id: null, tg_message_id: null },
    ]),
  );
  return f('anime:x', 'X').then((m) => {
    assert.strictEqual(m.get(1).lib, true, 'Ep1 harus lib');
    assert.strictEqual(m.get(1).tg, false);
    assert.strictEqual(m.get(2).lib, true, 'Ep2 ada di library DAN telegram');
    assert.strictEqual(m.get(2).tg, true);
    assert.strictEqual(m.get(3).lib, false);
    assert.strictEqual(m.get(3).tg, true, 'Ep3 hanya Telegram');
    assert.strictEqual(m.get(4).tg, false, 'Ep4 pointer kosong → belum terkirim');
    assert.strictEqual(m.get(4).link, 'l4', 'link tetap diambil walau pointer kosong');
    assert.strictEqual(m.has(5), false);
  });
});

t('KRITIS: picker memakai status gabungan (bukan hanya library)', () => {
  const BOT = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  const calls = (BOT.match(/await episodeStatusMap\(/g) || []).length;
  if (calls < 2) throw new Error('kedua picker (samehadaku & kuronime) harus memakai episodeStatusMap: ' + calls);
  const doneRule = (BOT.match(/if \(st\.tg\) done\.add\(ep\)/g) || []).length;
  if (doneRule < 2) throw new Error('kedua picker: done hanya dari pointer Telegram: ' + doneRule);
  if (/if \(st\.lib \|\| st\.tg\) done\.add\(ep\)/.test(BOT)) throw new Error('masih ada aturan done = lib ∪ tg');
  // label 📨 kini dibuat di dalam episodeButton (dipakai kedua picker)
  if (!/\\ud83d\\udce8 \$\{ep\}/.test(BOT)) throw new Error('label Telegram harus dibuat di episodeButton');
  if ((BOT.match(/episodeButton\(/g) || []).length < 3) throw new Error('episodeButton dipakai di kedua picker + definisi');
  // picker lama (hanya listPartsWithFile) tidak boleh lagi jadi sumber tunggal
  const oldStyle = (BOT.match(/const rows = await listPartsWithFile\(slug\);\s*\n\s*for \(const r of rows \|\| \[\]\) done\.add/g) || []).length;
  if (oldStyle > 0) throw new Error('masih ada picker yang hanya membaca library');
});


// ── REGRESSION: season TIDAK boleh merusak slug library ─────────────────────
t('KRITIS: parser TIDAK menaruh season/part di judul (slug library utuh)', () => {
  const P = require('../providers/samehadaku');
  const { sanitizeSlug } = require('../lib/parser');
  const slugOf = (u) => {
    const i = P.parseSamehadakuAnime(u);
    if (!i) return null;
    return 'anime:' + sanitizeSlug(`${i.title}${i.season ? ' S' + i.season : ''}${i.part ? ' P' + i.part : ''}`);
  };
  const cases = [
    ['naruto-kecil', 'anime:naruto-kecil'],
    ['tensei-shitara-slime-datta-ken-s3', 'anime:tensei-shitara-slime-datta-ken-s3'],
    ['tensei-shitara-slime-datta-ken-season-4', 'anime:tensei-shitara-slime-datta-ken-s4'],
    ['tensei-shitara-slime-datta-ken-season-2-part-2', 'anime:tensei-shitara-slime-datta-ken-s2-p2'],
  ];
  for (const [slug, want] of cases) {
    const got = slugOf('https://v2.samehadaku.how/anime/' + slug + '/');
    if (got !== want) throw new Error(`slug berubah untuk ${slug}:\n     dapat  ${got}\n     harus ${want}`);
  }
  // season tetap terbaca di field terpisah
  const info = P.parseSamehadakuEpisode('https://v2.samehadaku.how/anime/x-season-4-episode-1/');
  if (info.title !== 'X') throw new Error('judul harus polos, dapat: ' + info.title);
  if (info.season !== 4) throw new Error('season harus terpisah, dapat: ' + info.season);
});

t('KRITIS: withSeasonSuffix idempoten (tidak jadi "S4 S4")', () => {
  const w = vidoyHandlers.withSeasonSuffix;
  const a = w('Tensei Shitara Slime Datta Ken', 4, null);
  if (a !== 'Tensei Shitara Slime Datta Ken S4') throw new Error('suffix season salah: ' + a);
  if (w(a, 4, null) !== a) throw new Error('tidak idempoten: ' + w(a, 4, null));
  if (w('Tensei Shitara Slime Datta Ken S2 P2', 2, 2) !== 'Tensei Shitara Slime Datta Ken S2 P2') {
    throw new Error('sufiks yang sudah ada digandakan');
  }
  if (w('Naruto Kecil', null, null) !== 'Naruto Kecil') throw new Error('tanpa season harus tetap polos');
  if (w('X', 2, 2) !== 'X S2 P2') throw new Error('season+part salah');
  if (w('X S3', 3, null) !== 'X S3') throw new Error('season sama harus idempoten');
});

t('KRITIS: actionAnimeEpisode memakai vidoyTitle (season ikut) untuk folder & mediaKey', () => {
  const src = require('fs').readFileSync(require.resolve('../handlers/vidoy'), 'utf8');
  const i = src.indexOf('async function actionAnimeEpisode');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  if (!/withSeasonSuffix\(title, sameInfo && sameInfo\.season/.test(body)) {
    throw new Error('vidoyTitle tidak disusun dari season');
  }
  if (!/mediaKey: String\(vidoyTitle\)/.test(body)) throw new Error('mediaKey harus vidoyTitle');
  if (/mediaKey: String\(title\)/.test(body)) throw new Error('masih pakai title polos untuk mediaKey');
  if (!/sanitizeFolderName\(vidoyTitle/.test(body)) throw new Error('nama file harus pakai vidoyTitle');
});


t('KRITIS: listVidoyUploads WAJIB mengambil tg_chat_id & tg_message_id', () => {
  const src = require('fs').readFileSync(require.resolve('../db'), 'utf8');
  const i = src.indexOf('async function listVidoyUploads');
  if (i < 0) throw new Error('listVidoyUploads tidak ada');
  const body = src.slice(i, src.indexOf('\n}', i));
  for (const col of ['tg_chat_id', 'tg_message_id']) {
    if (!body.includes(col)) {
      throw new Error(`listVidoyUploads tidak mengambil ${col} → animeDoneMap hasTg selalu false → episode terkirim ulang (duplikat Telegram)`);
    }
  }
  const m = body.match(/SELECT[\s\S]*?FROM vidoy_uploads/);
  if (m && !/tg_chat_id[\s\S]*tg_message_id/.test(m[0]) && !/tg_message_id[\s\S]*tg_chat_id/.test(m[0])) {
    throw new Error('kedua kolom pointer harus ada di SELECT');
  }
});

t('KRITIS: animeDoneMap bergantung pada kolom pointer dari DB (bukan menebak)', () => {
  const BOT = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  const i = BOT.indexOf('async function animeDoneMap');
  const body = BOT.slice(i, BOT.indexOf('\n}', i));
  if (!/hasTg:\s*!!\(r\.tg_chat_id && r\.tg_message_id\)/.test(body)) {
    throw new Error('hasTg harus dihitung dari r.tg_chat_id && r.tg_message_id');
  }
  if (!/listVidoyUploads\(String\(mediaKey\), 'anime'\)/.test(body)) throw new Error('harus lewat listVidoyUploads');
});


// ── REGRESSION: identifier yang dipakai WAJIB terdefinisi (objek & fungsi) ──
t('KRITIS: tidak ada identifier tak-terdefinisi di jalur batch anime', () => {
  const BOT = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  const declared = new Set([...BOT.matchAll(/function ([A-Za-z0-9_]+)/g)].map((m) => m[1]));
  const consts = new Set([...BOT.matchAll(/(?:const|let|var) ([A-Za-z0-9_]+)\s*=/g)].map((m) => m[1]));
  const destructured = new Set([...BOT.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)]
    .flatMap((m) => m[1].split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean)));
  const params = new Set([...BOT.matchAll(/\(([^)]*)\)\s*(?:=>|\{)/g)]
    .flatMap((m) => m[1].split(',').map((x) => x.trim().replace(/[{}[\].]/g, '').split('=')[0].trim()).filter(Boolean)));
  const imports = new Set([...BOT.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=\s*require/g)]
    .flatMap((m) => m[1].split(',').map((x) => x.trim().split(':')[0].trim())));
  const defaultImports = new Set([...BOT.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*require/g)].map((m) => m[1]));
  const known = new Set([...declared, ...consts, ...destructured, ...params, ...imports, ...defaultImports]);
  const start = BOT.indexOf('const doneMap = await animeDoneMap');
  const end = BOT.indexOf('logger.info({ chatId, title, target, ok, fail, skip, skippedDone }', start);
  const body = BOT.slice(start, end > start ? end : start + 6000)
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  // identifier yang dipanggil sebagai fungsi ATAU dipanggil sebagai objek
  const called = new Set([...body.matchAll(/(^|[^.\w$])([a-zA-Z_$][\w$]{1,})\s*\(/g)].map((m) => m[2]));
  const METHODS = new Set(['slice', 'push', 'join', 'map', 'filter', 'forEach', 'keys', 'values', 'entries',
    'toFixed', 'includes', 'split', 'trim', 'replace', 'match', 'test', 'then', 'catch', 'finally', 'log', 'warn', 'info',
    'sendMessage', 'editMessageText', 'start', 'updateEpisode', 'update', 'done', 'fail', 'resolve', 'reject',
    'stringify', 'floor', 'get', 'set', 'has', 'padStart', 'flat', 'find', 'some', 'every', 'call', 'apply',
    'for', 'if', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'await', 'of', 'in', 'do', 'else',
    'Number', 'String', 'Boolean', 'Object', 'Array', 'JSON', 'Math', 'Date', 'Promise', 'Set', 'Map', 'RegExp',
    'decodeURIComponent', 'encodeURIComponent', 'parseInt', 'parseFloat', 'isNaN', 'Error',
    // kata kunci dari teks pesan Indonesia yang mengandung "("
    'dilewati', 'didukung', 'layak', 'terdaftar', 'async']);
  const missingFns = [...called].filter((n) => !known.has(n) && !METHODS.has(n));
  if (missingFns.length) throw new Error('fungsi tak terdefinisi: ' + missingFns.join(', '));
  // Alias modul yang dipakai sebagai `X.yyy` di jalur ini WAJIB terdefinisi.
  // Scan hanya nama alias yang umum dipakai di repo ini agar tidak kena teks biasa.
  const MODULE_ALIASES = ['db', '_db', '_vidoyHandlers', '_downloadHandlers', '_adminHandlers', '_libraryHandlers',
    'Vidoy', 'Vdara', 'V', 'B', 'BTN', 'db2', 'logger', 'RichProgress', 'Progress'];
  const usedAliases = MODULE_ALIASES.filter((a) => new RegExp('(^|[^.\\w$])' + a + '\\.').test(body));
  const badAliases = usedAliases.filter((a) => !known.has(a));
  if (badAliases.length) {
    throw new Error('objek tak terdefinisi → ReferenceError: ' + badAliases.join(', '));
  }
});

t('KRITIS: db tidak dipakai sebagai objek di bot.js (import-nya destructuring)', () => {
  const BOT = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  const hits = [...BOT.matchAll(/(^|[^.\w$])db\.[A-Za-z_]/g)].map((m) => m[0]);
  if (hits.length) throw new Error('bot.js memakai `db.` padahal import-nya destructuring → ReferenceError: ' + hits[0].trim());
  // listVidoyUploads harus di-import karena dipakai animeDoneMap
  if (!/listVidoyUploads[^\n]*\}\s*=\s*require\('\.\/db'\)/.test(BOT)) {
    throw new Error('listVidoyUploads tidak di-import dari ./db');
  }
  if (!/await listVidoyUploads\(String\(mediaKey\), 'anime'\)/.test(BOT)) {
    throw new Error('animeDoneMap harus memanggil listVidoyUploads yang di-import');
  }
});


// ── REGRESSION: anime harus masuk topic Anime, bukan General ──
t('KRITIS: kirim anime lewat sendAnimeMedia (topic Anime, bukan General)', () => {
  const src = require('fs').readFileSync(require.resolve('../handlers/vidoy'), 'utf8');
  const i = src.indexOf('async function actionAnimeEpisode');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  if (!/sendAnimeMedia/.test(body)) throw new Error('tidak memakai sendAnimeMedia → video masuk General');
  if (!/typeof _ctx\.sendAnimeMedia === 'function'\s*\?/.test(body)) throw new Error('tidak ada fallback ke sendVideo');
  // fallback tetap harus mengaktifkan streaming
  const fb = body.slice(body.indexOf(': await _ctx.sendVideo'));
  if (!/supports_streaming: true/.test(body)) throw new Error('supports_streaming hilang');
});

t('KRITIS: initVidoy menyuntikkan sendAnimeMedia', () => {
  const BOT = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  if (!/get sendAnimeMedia\(\) \{ return sendAnimeMedia; \}/.test(BOT)) {
    throw new Error('sendAnimeMedia tidak di-inject ke initVidoy');
  }
  // harusharus menuju:  sender yang memakai resolveAnimeThread (topic anime)
  if (!/buildAnimeSender\(\{ sendVideo, sendAudio, sendDocument \}, resolveAnimeThread\)/.test(BOT)) {
    throw new Error('buildAnimeSender tidak memakai resolveAnimeThread');
  }
});

t('animeTopic: sender memaksa supports_streaming & menambah message_thread_id', () => {
  const src = require('fs').readFileSync(require.resolve('../lib/animeTopic'), 'utf8');
  if (!/message_thread_id: threadId/.test(src)) throw new Error('tidak ada message_thread_id');
  if (!/supports_streaming: true/.test(src)) throw new Error('tidak memaksa supports_streaming');
  if (!/File anime terkirim ke topic grup/.test(src)) throw new Error('log topic hilang');
});


// ── REGRESSION: batch anime skip episode yang sudah lengkap + mode lengkapi ──
t('KRITIS: episode sudah lengkap (Vidoy + Telegram) DILEWATI, tidak diunduh ulang', () => {
  const BOT = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  // harus ada pemanggilan animeDoneMap di kedua runner
  const calls = (BOT.match(/await animeDoneMap\(/g) || []).length;
  if (calls < 2) throw new Error('animeDoneMap harus dipakai di 2 runner, ditemukan: ' + calls);
  if (!/function animeDoneMap/.test(BOT)) throw new Error('animeDoneMap tidak ada');
  // kondisi skip: link + hasTg
  const cond = (BOT.match(/if \(st && st\.link && st\.hasTg\)/g) || []).length;
  if (cond < 2) throw new Error('kondisi skip "sudah lengkap" harus di 2 runner: ' + cond);
  if (!/⏭️ sudah lengkap/.test(BOT)) throw new Error('tanda status "sudah lengkap" tidak ada');
  if (!/let ok = 0, fail = 0, skippedDone = 0;/.test(BOT)) throw new Error('skippedDone tidak dihitung');
});

t('KRITIS: animeDoneMap menandai link+pointer sebagai "sudah ada"', () => {
  const BOT = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  const i = BOT.indexOf('async function animeDoneMap');
  const code = BOT.slice(i, BOT.indexOf('\n}', i) + 2);
  const f = new Function('db', code + '\nreturn animeDoneMap;')({
    listVidoyUploads: async () => ([
      { part: 1, link: 'https://x/e/a', tg_chat_id: -100, tg_message_id: 5 },
      { part: 2, link: 'https://x/e/b', tg_chat_id: null, tg_message_id: null },
      { part: 3, link: null, tg_chat_id: -100, tg_message_id: 7 },
      { part: 4, link: 'https://x/e/d', tg_chat_id: -100, tg_message_id: null },
    ]),
  });
  return f('Naruto Kecil').then((map) => {
    assert.strictEqual(map.get(1).link, 'https://x/e/a');
    assert.strictEqual(map.get(1).hasTg, true, 'Ep 1 link+pointer → sudah lengkap');
    assert.strictEqual(map.get(2).hasTg, false, 'Ep 2 link tanpa pointer → perlu dikirim');
    assert.strictEqual(map.get(3).hasTg, true);
    assert.strictEqual(map.get(3).link, null, 'Ep 3 tanpa link → bukan duplikat');
    assert.strictEqual(map.get(4).hasTg, false, 'pointer separuh (chat ada, msg null) → belum lengkap');
    assert.strictEqual(map.size, 4);
  });
});

t('KRITIS: mode "Lengkapi yang hilang" hanya menyaring episode tanpa pesan Telegram', () => {
  const BOT = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  for (const pref of ['sam', 'kur']) {
    if (!BOT.includes(`${pref}_fix:`)) throw new Error(`${pref}_fix tidak ada`);
    if (!BOT.includes(`BTN.btn('⟳ Lengkapi yang hilang', \`${pref}_fix:\${bid}\``)) {
      throw new Error(`tombol "Lengkapi yang hilang" untuk ${pref} tidak ada`);
    }
    // target dikunci ke Telegram supaya tidak ada upload baru ke Vidoy
    const def = BOT.indexOf(`const isFix = data.startsWith('${pref}_fix:');`);
    if (def < 0) throw new Error(`isFix untuk ${pref}_fix tidak ada`);
    const seg = BOT.slice(def, def + 260);
    if (!/target: 'tg'/.test(seg)) throw new Error(`${pref}_fix harus memakai target 'tg' (tanpa upload Vidoy baru)`);
    if (!seg.includes("data.slice('" + pref + "_fix:'.length)")) {
      throw new Error(`${pref}_fix tidak memotong urlId dengan benar`);
    }
  }
  // saringan mode lengkapi
  if ((BOT.match(/st && st\.link && !st\.hasTg/g) || []).length < 2) {
    throw new Error('penyaringan mode lengkapi harus ada di 2 runner');
  }
  if (!/Tidak ada episode yang perlu dilengkapi/.test(BOT)) throw new Error('pesan "tidak ada yang perlu dilengkapi" tidak ada');
});

t('KRITIS: uploadSingle tetap mencegah duplikat Vidoy (aturan: dilarang keras)', () => {
  const src = require('fs').readFileSync(require.resolve('../services/vidoyService'), 'utf8');
  const i = src.indexOf('async function uploadSingle');
  const body = src.slice(i, i + 900);
  if (!/listVidoyUploads/.test(body)) throw new Error('uploadSingle tidak lagi mengecek record yang ada');
  if (!/skipped: true/.test(body)) throw new Error('uploadSingle tidak lagi menandai skipped');
  if (!/const existing = \(await db\.listVidoyUploads/.test(body)) throw new Error('pengecekan existing hilang');
});


// ── REGRESSION: fungsi yang dipanggil harus terdefinisi (bug ReferenceError) ──
t('KRITIS: tidak ada panggilan fungsi tak-terdefinisi di jalur batch anime', () => {
  const BOT = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  const declared = new Set([...BOT.matchAll(/function ([A-Za-z0-9_]+)/g)].map((m) => m[1]));
  const consts = new Set([...BOT.matchAll(/(?:const|let|var) ([A-Za-z0-9_]+)\s*=/g)].map((m) => m[1]));
  const destructured = new Set([...BOT.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)]
    .flatMap((m) => m[1].split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean)));
  const imported = new Set([...BOT.matchAll(/const \{([^}]*)\} = require/g)]
    .flatMap((m) => m[1].split(',').map((x) => x.trim().split(':')[0].trim())));
  const known = new Set([...declared, ...consts, ...destructured, ...imported]);
  const METHODS = new Set(['slice', 'push', 'join', 'map', 'filter', 'forEach', 'keys', 'values', 'entries',
    'toFixed', 'includes', 'split', 'trim', 'replace', 'match', 'test', 'then', 'catch', 'finally',
    'log', 'error', 'warn', 'info', 'sendMessage', 'editMessageText', 'start', 'updateEpisode', 'update',
    'done', 'fail', 'resolve', 'reject', 'stringify', 'parse', 'floor', 'ceil', 'round', 'min', 'max',
    'get', 'set', 'has', 'padStart', 'flat', 'flatMap', 'at', 'find', 'some', 'every', 'reduce', 'call', 'apply']);
  const start = BOT.indexOf('const rows2 = viable.map');
  const end = BOT.indexOf("logger.info({ chatId, title, target, ok, fail, skip }", start);
  const body = BOT.slice(start, end > start ? end : start + 3000)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // buang komentar blok
    .replace(/\/\/[^\n]*/g, ' ');                  // buang komentar baris
  // hanya bare call: nama yang TIDAK didahului titik
  const bare = [...body.matchAll(/(^|[^.\w$])([a-z][A-Za-z0-9_]{2,})\s*\(/g)].map((m) => m[2]);
  for (const kw of ['for', 'if', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'await', 'of', 'in', 'do', 'else']) {
    METHODS.add(kw);
  }
  const missing = [...new Set(bare)].filter((n) => !known.has(n) && !METHODS.has(n));
  if (missing.length) throw new Error('fungsi tak terdefinisi di jalur batch: ' + missing.join(', '));
  if (!/function batchTargetLabel/.test(BOT)) throw new Error('batchTargetLabel hilang');
  if (/(^|[^.\w])targetLabel\(/.test(BOT)) throw new Error('masih memanggil targetLabel yang tidak di-import');
});

t('KRITIS: batchTargetLabel memetakan 3 target dengan benar (tanpa Vidara)', () => {
  const BOT = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  const i = BOT.indexOf('function batchTargetLabel');
  const f = new Function(BOT.slice(i, BOT.indexOf('\n}', i) + 2) + '\nreturn batchTargetLabel;')();
  assert.strictEqual(f('tg'), 'Telegram');
  assert.strictEqual(f('vyt'), 'Vidoy + Telegram');
  assert.strictEqual(f('vv'), 'Vidoy');
  assert.ok(f(''), 'target kosong tidak boleh crash');
});


// ── REGRESSION: parser callback "Download Semua" (bug off-by-one slice) ──
t('KRITIS: parseBatchPick memecah callback dengan benar', () => {
  const BOT = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  const i = BOT.indexOf('function parseBatchPick');
  const code = BOT.slice(i, BOT.indexOf('\n}', i) + 2);
  const f = new Function(code + '\nreturn parseBatchPick;')();
  const cases = [
    ['sam_all:2', 'sam', { target: '', urlId: '2' }],
    ['sam_allgo:tg:2', 'sam', { target: 'tg', urlId: '2' }],
    ['sam_allgo:vt:2', 'sam', { target: 'vt', urlId: '2' }],
    ['sam_allgo:vyt:2', 'sam', { target: 'vyt', urlId: '2' }],
    ['sam_allgo:vv:2', 'sam', { target: 'vv', urlId: '2' }],
    ['kur_all:9', 'kur', { target: '', urlId: '9' }],
    ['kur_allgo:vyt:9', 'kur', { target: 'vyt', urlId: '9' }],
    ['sam_allgo:vyt:abc123', 'sam', { target: 'vyt', urlId: 'abc123' }],
  ];
  for (const [data, prefix, want] of cases) {
    const got = f(data, prefix);
    assert.strictEqual(got.target, want.target, `target salah untuk ${data}: ${got.target} (harus ${want.target})`);
    assert.strictEqual(got.urlId, want.urlId, `urlId salah untuk ${data}: ${got.urlId} (harus ${want.urlId})`);
    if (want.urlId !== '' && got.urlId === '') throw new Error('urlId kosong → link kadaluarsa palsu: ' + data);
  }
});

t('KRITIS: handler batch TIDAK lagi pakai slice index tetap', () => {
  const BOT = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  for (const branch of ['sam', 'kur']) {
    const start = BOT.indexOf(`data.startsWith('${branch}_all:'`);
    if (start < 0) throw new Error('branch ' + branch + ' tidak ditemukan');
    const body = BOT.slice(start, start + 900);
    if (/data\.slice\(\d+\)/.test(body)) throw new Error(branch + ': masih pakai slice index tetap → ' + body.match(/data\.slice\(\d+\)/)[0]);
    if (!body.includes(`parseBatchPick(data, '${branch}')`)) throw new Error(branch + ': tidak memakai parseBatchPick');
  }
});


// ── REGRESSION: linkAlive harus benar-benar cek player, bukan cuma HTTP 200 ──
t('KRITIS: linkAlive bukan lagi sekadar cek status HTTP', () => {
  const admin = require('fs').readFileSync(require.resolve('../handlers/admin'), 'utf8');
  if (!/function pageHasPlayer/.test(admin)) throw new Error('pageHasPlayer tidak ada');
  if (!/function interstitialTarget/.test(admin)) throw new Error('interstitialTarget tidak ada');
    // sudah tidak boleh pakai pola lama "%{http_code}" tanpa body
  const fn = admin.slice(admin.indexOf('function linkAlive'), admin.indexOf('async function refreshVidoyLink'));
  if (fn.includes("'-o', '/dev/null'")) throw new Error('masih pakai curl -o /dev/null (hanya cek status)');
  if (!/pageHasPlayer\(/.test(fn)) throw new Error('linkAlive tidak memeriksa player');
  if (!/interstitialTarget\(/.test(fn)) throw new Error('linkAlive tidak mengikuti redirect interstitial');
});

t('pageHasPlayer: hanya halaman ber-player yang dianggap hidup', () => {
  const admin = require('fs').readFileSync(require.resolve('../handlers/admin'), 'utf8');
  const pick = (n) => { let i = admin.indexOf('function ' + n); let d = 0, j = admin.indexOf('{', i); for (let k = j; k < admin.length; k++) { if (admin[k] === '{') d++; else if (admin[k] === '}') { d--; if (!d) return admin.slice(i, k + 1); } } };
  const start = admin.indexOf('const DEAD_MARKERS');
  const consts = admin.slice(start, admin.indexOf('];', start) + 2);
  const f = new Function(consts + '\n' + pick('pageHasPlayer') + '\nreturn { pageHasPlayer, DEAD_MARKERS };')();
  const real = '<title>Terobsesi — Ep 01-10.mp4</title><div class=player data-src="https://cdn.x/file.mp4">';
  const m3u8 = '<video src="https://cdn.x/hls.m3u8"></video>';
  const notFound = '<title>404 Page Not Found - Videq</title>';
  const interstitial = '<noscript><meta http-equiv="refresh" content="1;url=https://vidmonstr.com/e/abc"></noscript><script>location.replace("https://vidmonstr.com/e/abc")</script>';
  if (!f.pageHasPlayer(real)) throw new Error('halaman nyata dianggap mati');
  if (!f.pageHasPlayer(m3u8)) throw new Error('halaman m3u8 dianggap mati');
  if (f.pageHasPlayer(notFound)) throw new Error('halaman 404 dianggap hidup');
  if (f.pageHasPlayer(interstitial)) throw new Error('interstitial dianggap hidup');
  for (const dead of ['404 Page Not Found', 'video deleted', 'file expired', 'tidak ditemukan']) {
    if (!f.DEAD_MARKERS.some((r) => r.test(dead))) throw new Error('tanda mati tidak dikenali: ' + dead);
  }
});

t('interstitialTarget: ambil tujuan dari meta refresh & location.replace', () => {
  const admin = require('fs').readFileSync(require.resolve('../handlers/admin'), 'utf8');
  const pick = (n) => { const i = admin.indexOf('function ' + n); let d = 0, j = admin.indexOf('{', i); for (let k = j; k < admin.length; k++) { if (admin[k] === '{') d++; else if (admin[k] === '}') { d--; if (!d) return admin.slice(i, k + 1); } } };
  const f = new Function(pick('interstitialTarget') + '\nreturn interstitialTarget;')();
  const meta = '<meta http-equiv="refresh" content="1;url=https://vidmonstr.com/e/abc">';
  const js = '<script>setTimeout(function(){location.replace("https://vidmonstr.com/e/xyz")},500)</script>';
  if (f(meta) !== 'https://vidmonstr.com/e/abc') throw new Error('meta refresh gagal: ' + f(meta));
  if (f(js) !== 'https://vidmonstr.com/e/xyz') throw new Error('location.replace gagal: ' + f(js));
  if (f('<p>halaman biasa</p>') !== '') throw new Error('harus kosong saat tidak ada redirect');
});

t('vidoy.asia HANYA sebagai base URL upload, bukan web publik', () => {
  const files = ['../vidoy-uploader', '../handlers/vidoy', '../handlers/admin', '../services/vidoyService', '../db', '../bot'];
  for (const f of files) {
    const s = require('fs').readFileSync(require.resolve(f), 'utf8');
    const hits = [...s.matchAll(/.{0,40}vidoy\.asia.{0,40}/gi)].map((m) => m[0]);
    for (const h of hits) {
      // occurrence di komentar penjelasan juga boleh
      if (/^\s*(\/\/|\*)/.test(h.trim()) || h.includes('dulu dipatok') || h.includes('masih pakai domain')) continue;
      if (!/VIDOY_BASE|process\.env\.VIDOY_BASE/.test(h)) {
        throw new Error(f + ': vidoy.asia dipakai di luar base URL upload → ' + h.trim());
      }
    }
  }
  const up = require('fs').readFileSync(require.resolve('../vidoy-uploader'), 'utf8');
  if (!/VIDOY_BASE = \(process\.env\.VIDOY_BASE \|\| 'https:\/\/vidoy\.asia'\)/.test(up)) {
    throw new Error('VIDOY_BASE tidak lagi configurable lewat env');
  }
});


t('KRITIS: label link di panel & caption pakai domain ASLI (bukan "vidoy.asia" hardcode)', () => {
  const admin = require('fs').readFileSync(require.resolve('../handlers/admin'), 'utf8');
  if (/vidoy\.asia\/\$\{/.test(admin)) throw new Error('admin.js masih mempatok domain vidoy.asia');
  const f = new Function(admin.match(/function shortLink[\s\S]*?\n}/)[0] + '; return shortLink;')();
  for (const [url, expect] of [
    ['https://vski.cc/e/abc', 'vski.cc/e/abc'],
    ['https://vidkud.com/d/xyz', 'vidkud.com/d/xyz'],
    ['https://vidmonstr.com/e/q1', 'vidmonstr.com/e/q1'],
  ]) {
    if (f(url) !== expect) throw new Error('label salah untuk ' + url + ': ' + f(url) + ' (harus ' + expect + ')');
  }
  if (f('https://vski.cc/e/abc').includes('vidoy.asia')) throw new Error('masih vidoy.asia');
  // caption harus konsisten dengan panel
  const cap = vidoyHandlers.buildCaption({ title: 'X', provider: 'dramawave', part: 1, epStart: 1, epEnd: 10, link: 'https://vski.cc/e/abc' });
  if (!cap.includes('>vski.cc/e/abc</a>')) throw new Error('caption tidak konsisten dengan panel: ' + cap);
});


// ── REGRESSION: interpretasi hasil edit caption ──
t('KRITIS: "message is not modified" dianggap SUKSES (bukan gagal)', () => {
  assert.strictEqual(require('../handlers/admin').isNotModified('ETELEGRAM: 400 Bad Request: message is not modified: specified new message content and reply markup are exactly the same'), true);
  assert.strictEqual(require('../handlers/admin').isNotModified('ETELEGRAM: 400 Bad Request: there is no text in the message to edit'), false);
  assert.strictEqual(require('../handlers/admin').isNotModified(''), false);
});

t('KRITIS: "message to edit not found" terdeteksi (pesan dihapus user)', () => {
  assert.strictEqual(require('../handlers/admin').isMessageGone('ETELEGRAM: 400 Bad Request: message to edit not found'), true);
  assert.strictEqual(require('../handlers/admin').isMessageGone('ETELEGRAM: 400 Bad Request: message is not modified'), false);
});

t('KRITIS: refresh tidak jatuh ke editMessageText saat caption tak berubah', () => {
  const admin = require('fs').readFileSync(require.resolve('../handlers/admin'), 'utf8');
  const fn = admin.slice(admin.indexOf('async function refreshVidoyLink'), admin.indexOf('async function handleAdminPanel'));
  if (!/isNotModified\(capRes\.err\)/.test(fn)) throw new Error('tidak menangani "not modified"');
  if (!/isMessageGone\(capRes\.err\)/.test(fn)) throw new Error('tidak menangani pesan hilang');
  // cabang "not modified" harus Setel captionUpdated = true
  const notMod = fn.slice(fn.indexOf('isNotModified(capRes.err)'));
  if (!/captionUpdated = true/.test(notMod.slice(0, 400))) throw new Error('not modified tidak dihitung sukses');
});

t('KRITIS: db punya clearVidoyTelegramPointer (pesan dihapus → bisa kirim ulang)', () => {
  const dbSrc = require('fs').readFileSync(require.resolve('../db'), 'utf8');
  if (!/async function clearVidoyTelegramPointer/.test(dbSrc)) throw new Error('fungsi tidak ada');
  if (!/tg_chat_id = NULL, tg_message_id = NULL/.test(dbSrc)) throw new Error('tidak membersihkan kedua kolom');
  const exp = require('../db');
  if (typeof exp.clearVidoyTelegramPointer !== 'function') throw new Error('tidak diekspor');
});

t('KRITIS: retry plain-text HANYA untuk error parse entities', () => {
  const src = require('fs').readFileSync(require.resolve('../lib/telegram'), 'utf8');
  if (!/function isHtmlEntityError/.test(src)) throw new Error('helper tidak ada');
  if (!/isHtmlEntityError\(err\)/.test(src)) throw new Error('wrapper editMessage tidak memfilter');
  if (!/isHtmlEntityError\(\{ message: json\.description/.test(src)) throw new Error('apiPost tidak memfilter');
  // harus menolak 400 non-HTML
  const m = src.match(/function isHtmlEntityError[\s\S]{0,500}/);
  if (!/can't parse entities/.test(m[0])) throw new Error('pola error HTML tidak dikenali');
});


t('KRITIS: pilihan target batch tidak boleh ditelan diam-diam (.catch(() => {}))', () => {
  const BOT = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  for (const tag of ['sam_all', 'kur_all']) {
    if (!BOT.includes(`${tag}: gagal tampilkan pilihan target`)) {
      throw new Error(`${tag}: kegagalan tampil menu tidak di-log`);
    }
  }
  if (!BOT.includes('Gagal menampilkan pilihan target')) throw new Error('tidak ada pesan error ke user');
});


// ── REGRESSION KRITIS: struktur inline_keyboard (row = array of Object) ──
t('KRITIS: animeTargetKeyboard WAJIB di-spread (bukan dibungkus array)', () => {
  const BOT = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  const n = (BOT.match(/\.\.\.animeTargetKeyboard\(/g) || []).length;
  if (n < 4) throw new Error('animeTargetKeyboard harus di-spread di 4 tempat, ditemukan: ' + n);
  if (/inline_keyboard: \[\s*\n\s*animeTargetKeyboard\(/.test(BOT)) {
    throw new Error(' masih ada animeTargetKeyboard tanpa spread → "InlineKeyboardButton must be an Object"');
  }
});

t('KRITIS: keyboard yang dibangun valid secara struktur (row berisi objek)', () => {
  const V2 = require('../vidoy-uploader');
  const Vd2 = require('../vidara-uploader');
  const mk = (text, data, on) => (on ? { text, callback_data: data, style: 'primary' } : { text, disabled: {} });
  const rows = [
    [mk('T', 'a:1', true), mk('V', 'b:1', !!Vd2.VIDARA_KEY)],
    [mk('VT', 'c:1', V2.isConfigured()), mk('VV', 'd:1', !!Vd2.VIDARA_KEY && V2.isConfigured())],
  ];
  // rekonstruksi pemakaian yang salah (tanpa spread) dan yang benar (dengan spread)
  const wrong = [rows, [{ text: 'kembali', callback_data: 'k:1' }]];
  const right = [...rows, [{ text: 'kembali', callback_data: 'k:1' }]];
  const isValid = (kb) => kb.every((row) => Array.isArray(row) && row.every((x) => x && typeof x === 'object' && !Array.isArray(x)));
  if (isValid(wrong)) throw new Error('varian salah ikut valid — tes tidak berguna');
  if (!isValid(right)) throw new Error('spread menghasilkan keyboard invalid: ' + JSON.stringify(right));
  for (const row of right) {
    for (const btn of row) {
      if (btn.callback_data !== undefined && (typeof btn.callback_data !== 'string' || !btn.callback_data.length || Buffer.byteLength(btn.callback_data) > 64)) {
        throw new Error('callback_data tidak valid: ' + JSON.stringify(btn.callback_data));
      }
      if (typeof btn.text !== 'string' || !btn.text.length) throw new Error('text tombol kosong');
    }
  }
});


// ── REGRESSION: season anime tidak boleh hilang dari judul ──
const SA = require('../providers/samehadaku');

t('anime season: kedua gaya slug → judul SINGKAT & BERBEDA (S3 vs S4)', () => {
  const u = (slug) => 'https://v2.samehadaku.how/anime/' + slug + '-episode-1/';
  const s3 = SA.parseSamehadakuEpisode(u('tensei-shitara-slime-datta-ken-s3'));
  const s4 = SA.parseSamehadakuEpisode(u('tensei-shitara-slime-datta-ken-s4'));
  if (s3.title !== 'Tensei Shitara Slime Datta Ken S3') throw new Error('gaya -s3 salah: ' + s3.title);
  if (s4.title !== 'Tensei Shitara Slime Datta Ken S4') throw new Error('gaya -s4 salah: ' + s4.title);
  if (s3.title === s4.title) throw new Error('S3 & S4 judul sama → akan menimpa file');
  // gaya -season-N: judul HARUS polos (season di field terpisah) supaya slug
  // library tidak terduplikasi; pembeda season disusun di handlers/vidoy.js
  const l4 = SA.parseSamehadakuEpisode(u('tensei-shitara-slime-datta-ken-season-4'));
  const l3 = SA.parseSamehadakuEpisode(u('tensei-shitara-slime-datta-ken-season-3'));
  if (l4.title !== 'Tensei Shitara Slime Datta Ken') throw new Error('gaya -season-4 judul harus polos: ' + l4.title);
  if (l4.season !== 4) throw new Error('season harus di field season: ' + l4.season);
  if (l3.season !== 3) throw new Error('season salah: ' + l3.season);
});

t('anime season+part: dua gaya slug menghasilkan SLUG YANG SAMA', () => {
  const { sanitizeSlug } = require('../lib/parser');
  const u = (slug) => 'https://v2.samehadaku.how/anime/' + slug + '-episode-2/';
  const slugOf = (i) => 'anime:' + sanitizeSlug(`${i.title}${i.season ? ' S' + i.season : ''}${i.part ? ' P' + i.part : ''}`);
  const a = SA.parseSamehadakuEpisode(u('naruto-kecil-s2-p2'));
  const c = SA.parseSamehadakuEpisode(u('naruto-kecil-season-2-part-2'));
  // Gaya "-s2-p2": season/part sudah jadi kata di judul, season/part = null
  if (a.title !== 'Naruto Kecil S2 P2') throw new Error('judul gaya -s2-p2: ' + a.title);
  if (a.season !== null || a.part !== null) throw new Error('gaya -s2-p2 tidak boleh punya season/part');
  // Gaya "-season-2-part-2": season/part di field terpisah
  if (c.title !== 'Naruto Kecil') throw new Error('judul gaya -season-2-part-2 harus polos: ' + c.title);
  if (c.season !== 2 || c.part !== 2) throw new Error('season/part tidak terbaca: ' + JSON.stringify([c.season, c.part]));
  // WAJIB menghasilkan slug yang sama
  if (slugOf(a) !== slugOf(c)) throw new Error(`slug beda: ${slugOf(a)} vs ${slugOf(c)}`);
  if (slugOf(a) !== 'anime:naruto-kecil-s2-p2') throw new Error('slug salah: ' + slugOf(a));
});

t('anime tanpa season/part: judul polos, season tetap null', () => {
  const r = SA.parseSamehadakuEpisode('https://v2.samehadaku.how/anime/naruto-kecil-episode-5/');
  if (r.title !== 'Naruto Kecil') throw new Error('judul polos berubah: ' + r.title);
  if (r.season !== null) throw new Error('season harus null');
  const m = SA.parseSamehadakuAnime('https://v2.samehadaku.how/anime/tensei-shitara-slime-datta-ken-season-4/');
  if (m.title !== 'Tensei Shitara Slime Datta Ken') throw new Error('parseSamehadakuAnime judul harus polos: ' + m.title);
  if (m.season !== 4) throw new Error('parseSamehadakuAnime season: ' + m.season);
});

t('anime judul: tidak ada spasi ganda / huruf kecil pada sufiks season', () => {
  for (const slug of ['x-season-4', 'x-s3', 'x-season-3-part-2', 'x-part-2', 'naruto-kecil']) {
    const t2 = SA.parseSamehadakuEpisode('https://v2.samehadaku.how/anime/' + slug + '-episode-1/').title;
    if (/\s{2,}/.test(t2)) throw new Error('spasi ganda: ' + JSON.stringify(t2));
    if (/ s\d/.test(t2)) throw new Error('sufiks season huruf kecil: ' + JSON.stringify(t2));
    if (/\bseason\b/i.test(t2)) throw new Error('kata "season" panjang: ' + JSON.stringify(t2));
  }
});


// ── REGRESSION: target di tombol "Download Semua" (batch anime) ──
const BOT = require('fs').readFileSync(require.resolve('../bot'), 'utf8');

t('KRITIS: "Download Semua" WAJIB menanyakan target dulu (tidak langsung ke Telegram)', () => {
  for (const [prefix, pick] of [['sam', 'sam_allgo'], ['kur', 'kur_allgo']]) {
    if (!BOT.includes(`data.startsWith('${prefix}_all:') || data.startsWith('${pick}:')`)) {
      throw new Error(`${prefix}_all tidak punya langkah pilih target`);
    }
    for (const t of ['tg', 'vyt', 'vv']) {
      if (!BOT.includes(`${pick}:${t}:\${bid}`)) throw new Error(`${prefix}: target ${t} tidak bisa dipilih`);
    }
    if (BOT.includes(`${pick}:vt:`)) throw new Error(`${prefix}: target vt (Vidara) tidak boleh ditawarkan`);
    if (!BOT.includes(`if (!['tg', 'vyt', 'vv'].includes(batchTarget))`)) {
      throw new Error(`${prefix}: target tidak divalidasi`);
    }
  }
});

t('KRITIS: loop batch memakai target — non-TG lewat actionAnimeEpisode (semua server)', () => {
  // 둘 다: Telegram tetap pakai downloader lama, target lain via actionAnimeEpisode
  const tgBranch = (BOT.match(/if \(target === 'tg'\) \{/g) || []).length;
  if (tgBranch < 2) throw new Error('cabang target==="tg" kurang dari 2 (sam & kur): ' + tgBranch);
  const calls = (BOT.match(/actionAnimeEpisode\(chatId, \{/g) || []).length;
  if (calls < 2) throw new Error('batch tidak memanggil actionAnimeEpisode: ' + calls);
  for (const dl of ['downloadSamehadakuFile(chatId, e.url, server, servers, sameInfo, { silent: true })',
                    'downloadKuronimeFile(chatId, e.url, server, servers, kurInfo, { silent: true })']) {
    if (!BOT.includes(dl)) throw new Error('jalur Telegram-only berubah: ' + dl.slice(0, 40));
  }
  // resolveDirectUrl dipakai agar semua server (gofile/filedon/kraken/pixeldrain) bisa
  if ((BOT.match(/resolveDirectUrl\(servers\[server\]\)/g) || []).length < 2) {
    throw new Error('batch tidak resolve link file per server');
  }
});

t('KRITIS: mode silent tidak spam pesan per-episode & tidak ambil lock', () => {
  const VSRC2 = require('fs').readFileSync(require.resolve('../handlers/vidoy'), 'utf8');
  if (!/if \(!silent\) await p\.done/.test(VSRC2)) throw new Error('p.done masih jalan di mode silent');
  if (!/if \(!silent\) await p\.fail/.test(VSRC2)) throw new Error('p.fail masih jalan di mode silent');
  if (!/if \(!silent\) \{[\s\S]{0,200}vidaraBusy\.has/.test(VSRC2)) throw new Error('lock tetap diambil saat silent');
  if (!/silent\s*\? \{ update\(\) \{\}, done: async/.test(VSRC2)) throw new Error('progress senyap belum ada');
});

t('KRITIS: link Vidoy per-episode dilaporkan di batch (bukan tenggelam di progress)', () => {
  if (!BOT.includes('🔗 <b>Link Vidoy:</b>')) throw new Error('tidak ada laporan link Vidoy di batch');
  if ((BOT.match(/r\.link\) (vidoyLinks|kurLinks)\.push/g) || []).length < 2) {
    throw new Error('link tidak dikumpulkan untuk kedua runner');
  }
});

t('menu: tombol 🗂 Vidoy Links ada di keyboard Admin Panel yang DIPAKAI', () => {
  const A = fs.readFileSync(require.resolve('../handlers/admin'), 'utf8');
  const fn = A.slice(A.indexOf('function adminPanelKeyboard'), A.indexOf('function', A.indexOf('function adminPanelKeyboard') + 10));
  if (!fn.includes('act:vidoy_links')) throw new Error('handleAdminPanel tidak punya tombol Vidoy Links');
  if (!fn.includes('act:vidara_domain')) throw new Error('tombol Domain Vidara hilang');
});


// ── REGRESSION KRITIS: jangan kirim ulang yang sudah terkirim ──
const VS = require('../services/vidoyService');

t('KRITIS: record DB dengan pointer Telegram dianggap SUDAH terkirim (tidak kirim ulang)', () => {
  const chunks = [Array.from({ length: 10 }, (_, i) => ({ ep: i + 1 })), Array.from({ length: 10 }, (_, i) => ({ ep: i + 11 }))];
  const dbRows = [
    { part: 1, link: 'https://vski.cc/e/aaa', tg_chat_id: -100123, tg_message_id: 5601 },
    { part: 2, link: 'https://vski.cc/e/bbb', tg_chat_id: -100123, tg_message_id: 5602 },
  ];
  const plan = VS.planBatchWork(chunks, dbRows, {}, 10);
  if (!plan.every((p) => p.skip)) throw new Error('part tak ter-skip: ' + JSON.stringify(plan.map((p) => p.skip)));
  for (const p of plan) {
    if (p.known.tgSent !== true) throw new Error('part ' + p.part + 'tgSent bukan true → akan kirim ulang');
  }
});

t('KRITIS: track.jsonTgSent=true tanpa pointer → tetap dianggap terkirim', () => {
  const chunks = [Array.from({ length: 10 }, (_, i) => ({ ep: i + 1 }))];
  const plan = VS.planBatchWork(chunks, [], { vidoyBatches: { '01-10': { link: 'https://vski.cc/e/aaa', tgSent: true } } }, 10);
  if (!plan[0].skip) throw new Error('harus skip');
  if (plan[0].known.tgSent !== true) throw new Error('tgSent track tidak dihormati');
});

t('KRITIS: record DB tanpa pointer → boleh dikirim (mis.僅 Vidoy-only sebelumnya)', () => {
  const chunks = [Array.from({ length: 10 }, (_, i) => ({ ep: i + 1 }))];
  const plan = VS.planBatchWork(chunks, [{ part: 1, link: 'https://vski.cc/e/aaa', tg_chat_id: null, tg_message_id: null }], {}, 10);
  if (!plan[0].skip) throw new Error('vidoy tetap skip');
  if (plan[0].known.tgSent === true) throw new Error('tidak ada pointer → tgSent harus false agar dikirim');
});

t('KRITIS: pointer hanya satu kolom tidak dianggap terkirim', () => {
  const chunks = [Array.from({ length: 10 }, (_, i) => ({ ep: i + 1 }))];
  const plan = VS.planBatchWork(chunks, [{ part: 1, link: 'https://vski.cc/e/aaa', tg_chat_id: -100123, tg_message_id: null }], {}, 10);
  if (plan[0].known.tgSent === true) throw new Error('pointer separuh tidak boleh dihitung terkirim');
});

t('KRITIS: string track lama (link saja) tetap kompatibel', () => {
  const chunks = [Array.from({ length: 10 }, (_, i) => ({ ep: i + 1 }))];
  const plan = VS.planBatchWork(chunks, [], { vidoyBatches: { '01-10': 'https://vski.cc/e/aaa' } }, 10);
  if (!plan[0].skip) throw new Error('harus skip dari string');
  if (plan[0].known.tgSent !== null) throw new Error('tgSent harus null (tidak diketahui)');
});


// ── REGRESSION: caption & refresh link (bug Provider undefined + link tertukar) ──
const VH = require('../handlers/vidoy');
const AH = require('../handlers/admin');
const SRC = require('fs').readFileSync(require.resolve('../handlers/vidoy'), 'utf8');

t('caption drama: format "1 (Ep 1–10)" + provider benar (bukan undefined)', () => {
  const c = VH.buildCaption({ title: 'Terobsesi Padanya Siang dan Malam', provider: 'dramawave',
    part: 1, epStart: 1, epEnd: 10, link: 'https://vski.cc/e/ru9a4av12kd9' });
  if (!c.includes('1 (Ep 1–10)')) throw new Error('format part salah: ' + c);
  if (!c.includes('Provider :- dramawave')) throw new Error('provider salah: ' + c);
  if (c.includes('undefined')) throw new Error('ada "undefined" di caption');
  if (c.includes('Server :-')) throw new Error('baris Server tidak boleh ada');
});

t('caption anime: episode tunggal', () => {
  const c = VH.buildCaption({ title: 'A', provider: 'samehadaku', part: 8, epStart: 8, epEnd: 8, link: 'https://vski.cc/e/aa' });
  if (!c.includes('Episode :- 8')) throw new Error('format anime salah: ' + c);
  if (c.includes('Part/Episode')) throw new Error('episode tunggal tidak boleh pakai Part/Episode: ' + c);
});

t('caption: judul & provider berbahaya dinetralkan (kontrak sanitizer)', () => {
  const c = VH.buildCaption({ title: '<script>x</script>', provider: 'a&b<c>', part: 1, epStart: 1, epEnd: 10, link: 'https://vski.cc/e/aa' });
  if (c.includes('<script>')) throw new Error('tag berbahaya lolos: ' + c);
  if (c.includes('a&b')) throw new Error('ampersand tidak ter-escape: ' + c);
  if (c.includes('<c>')) throw new Error('tag asing lolos: ' + c);
});

t('provider kosong → "—" bukan "undefined"', () => {
  const c = VH.buildCaption({ title: 'X', provider: undefined, part: 1, epStart: 1, epEnd: 10, link: 'https://vski.cc/e/aa' });
  if (c.includes('undefined')) throw new Error('undefined masih muncul: ' + c);
});

t('replaceLinkLine: MENGGANTI baris link, tidak menambah duplikat', () => {
  const c = VH.buildCaption({ title: 'X', provider: 'dramawave', part: 1, epStart: 1, epEnd: 10, link: 'https://vski.cc/e/ru9a4av12kd9' });
  const out = AH.replaceLinkLine(c, 'https://vski.cc/e/NEWLINK999');
  const linkLines = out.split('\n').filter((l) => l.includes('Link :-'));
  if (linkLines.length !== 1) throw new Error('baris link duplikat: ' + linkLines.length);
  if (!out.includes('NEWLINK999')) throw new Error('link baru tidak ada');
  if (out.includes('ru9a4av12kd9')) throw new Error('link lama masih ada');
  if (!out.includes('Provider :- dramawave')) throw new Error('baris lain berubah');
});

t('replaceLinkLine: caption tanpa baris link → ditambahkan di akhir', () => {
  const out = AH.replaceLinkLine('➧ Judul :- <b>X</b>', 'https://vski.cc/e/zzz');
  if (!out.includes('Link :-')) throw new Error('link tidak ditambahkan');
  if (out.split('\n').length !== 2) throw new Error('baris tidak sesuai');
});

t('fallback caption record lama: provider dari media_key, tanpa undefined', () => {
  const c = AH.buildFallbackCaption({ media_key: 'dramawave:8YRT', title: 'X', part: 3, ep_start: 21, ep_end: 30, provider: null },
    'https://vski.cc/e/zzz');
  if (!c.includes('3 (Ep 21–30)')) throw new Error('format part salah: ' + c);
  if (c.includes('undefined')) throw new Error('undefined di fallback');
});

t('fallback caption: media_key null → tetap aman', () => {
  const c = AH.buildFallbackCaption({ media_key: null, title: null, part: 1, ep_start: 1, ep_end: 10, provider: null }, 'https://vski.cc/e/x');
  if (c.includes('undefined')) throw new Error('undefined di fallback: ' + c);
});

t('recordToken: stabil & mengidentifikasi record yang benar', () => {
  const r = { media_key: 'dramawave:8YRT', kind: 'drama', part: 1 };
  const t1 = AH.recordToken(r);
  if (t1 !== AH.recordToken({ ...r })) throw new Error('token tidak deterministik');
  if (AH.recordToken({ ...r, part: 2 }) === t1) throw new Error('part berbeda collided');
  if (AH.recordToken({ ...r, kind: 'anime' }) === t1) throw new Error('kind berbeda collided');
  const found = AH.findRowByToken([{ media_key: 'x', kind: 'anime', part: 8 }, r], t1);
  if (!found || found.media_key !== 'dramawave:8YRT') throw new Error('record tidak ditemukan');
});

t('callback_data token muat di 64 byte', () => {
  const cb = 'act:vidoy_link_one:' + AH.recordToken({ media_key: 'x'.repeat(200), kind: 'drama', part: 12 });
  if (Buffer.byteLength(cb) > 64) throw new Error('callback_data terlalu panjang: ' + Buffer.byteLength(cb));
});

t('kode: drama & anime WAJIB supports_streaming (video tidak stream = bug)', () => {
  // jalur drama: kirim lewat mediaOpts (harus ada supports_streaming di deklarasinya)
  if (!/const mediaOpts = \{[\s\S]{0,200}supports_streaming: true/.test(SRC)) {
    throw new Error('mediaOpts drama tidak punya supports_streaming');
  }
  // jalur anime: sekarang lewat sendAnimeMedia dengan mediaOpts yang berisi
  // supports_streaming (sender juga memaksa flagnya)
  if (!/const mediaOpts = \{[\s\S]{0,200}supports_streaming: true/.test(SRC)) {
    throw new Error('mediaOpts anime tidak punya supports_streaming');
  }
  if (!/sendAnimeMedia\(chatId, destPath, mediaOpts\)/.test(SRC)) {
    throw new Error('kirim anime tidak lewat sendAnimeMedia (topic Anime)');
  }
  // tidak boleh ada call site yang mengirim hanya caption+parse_mode
  if (/sendVideo\([^)]*\{ caption, parse_mode: 'HTML' \}\)/.test(SRC)) {
    throw new Error('ada call site video tanpa supports_streaming');
  }
});

t('kode: TIDAK ada shorthand providerLabel tanpa label (bug "Provider :- undefined")', () => {
  // hanya call site (definisi fungsi diabaikan)
  const all = SRC.match(/buildCaption\(\{[^}]*\}/g) || [];
  const calls = all.filter((c) => SRC.slice(Math.max(0, SRC.indexOf(c) - 9), SRC.indexOf(c)) !== 'function ');
  if (calls.length < 2) throw new Error('tidak menemukan call site buildCaption: ' + all.length + ' total, definisi=' + (all.length - calls.length));
  for (const call of calls) {
    if (!/provider:/.test(call)) throw new Error('buildCaption tanpa key provider: → undefined. ' + call);
    if (!/part:/.test(call) && !/epStart:/.test(call)) throw new Error('call site tanpa ep info: ' + call);
  }
});

t('kode: vinfo didefinisikan sebelum dipakai (bug ReferenceError)', () => {
  if (!/const vinfo = await getVideoInfo\(item\.filePath\)/.test(SRC)) throw new Error('vinfo drama tidak ada');
  if (!/const vinfo = await getVideoInfo\(destPath\)/.test(SRC)) throw new Error('vinfo anime tidak ada');
});

t('kode: caption & provider disimpan ke DB (bukan dirakit ulang saat refresh)', () => {
  if ((SRC.match(/provider: providerLabel,\s*caption/g) || []).length < 1) throw new Error('drama tidak menyimpan provider+caption');
  if ((SRC.match(/provider: animeProvider, caption/g) || []).length < 1) throw new Error('anime tidak menyimpan provider+caption');
});

t('kode: caption yang tersimpan dipakai saat refresh (bukan dirakit ulang)', () => {
  const admin = require('fs').readFileSync(require.resolve('../handlers/admin'), 'utf8');
  if (!/row\.caption && String\(row\.caption\)\.trim\(\)/.test(admin)) throw new Error('refresh tidak memprioritaskan caption tersimpan');
});

t('kode: tabel vidoy_uploads punya kolom provider & caption', () => {
  const dbSrc = require('fs').readFileSync(require.resolve('../db'), 'utf8');
  for (const col of ['provider      TEXT', 'caption       TEXT']) {
    if (!dbSrc.includes(col)) throw new Error('kolom hilang: ' + col);
  }
  if (!dbSrc.includes('ADD COLUMN IF NOT EXISTS provider')) throw new Error('migrasi provider hilang');
  if (!dbSrc.includes('ADD COLUMN IF NOT EXISTS caption')) throw new Error('migrasi caption hilang');
});

t('kode: updateVidoyLink tidak RETURNING kolom id yang tidak ada', () => {
  const dbSrc = require('fs').readFileSync(require.resolve('../db'), 'utf8');
  const m = dbSrc.match(/UPDATE vidoy_uploads[\s\S]{0,300}?RETURNING ([^`]*)/);
  if (!m) throw new Error('tidak menemukan UPDATE vidoy_uploads');
  if (/\bid\b/.test(m[1])) throw new Error('RETURNING id — kolom id tidak ada di tabel: ' + m[1].trim());
});

t('kode: refresh caption video WAJIB editMessageCaption (editMessageText gagal)', () => {
  const admin = require('fs').readFileSync(require.resolve('../handlers/admin'), 'utf8');
  const fn = admin.slice(admin.indexOf('async function refreshVidoyLink'));
  const body = fn.slice(0, fn.indexOf('return { ok: true'));
  if (!/editMessageCaption/.test(body)) throw new Error('tidak pakai editMessageCaption → "there is no text in the message to edit"');
  if (!/editMessageText/.test(body)) throw new Error('tidak ada fallback editMessageText');
  if (/editMessageText[\s\S]{0,120}captionUpdated = await/.test(body)) {
    throw new Error('editMessageText jadi jalur utama');
  }
});

t('kode: initAdmin menerima isAdmin (guard panel tidak boleh blank)', () => {
  const bot = require('fs').readFileSync(require.resolve('../bot'), 'utf8');
  if (!/initAdmin\(\{[^}]*isAdmin/.test(bot)) throw new Error('initAdmin tidak menerima isAdmin');
});

process.exit(failed ? 1 : 0);
