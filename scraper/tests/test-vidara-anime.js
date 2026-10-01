'use strict';

// Vidara sebagai host cadangan sementara (dual-host Vidoy + Vidara).
//
// Konteks (1 Okt 2026): kuota Vidoy 5 GB/bulan habis di HARI PERTAMA window
// (used 5.33/5.37 GB, remaining 36 MB, reset_at 2026-11-01). Registrasi akun
// baru 404, remote upload 500 → tidak ada cara menambah kapasitas Vidoy.
// Vidara dipakai sebagai host cadangan: isi dulu selagi Vidoy penuh, lalu
// hapus begitu episode-nya sah masuk Vidoy.
//
// ATURAN DEDUPE (diminta user, diuji di sini):
//   ada di Vidoy  → jangan sentuh Vidara
//   ada di Vidara → TIDAK menghalangi Vidoy (boleh download + upload Vidoy)
//
// Test mix: assertion statis untuk wiring (meniru pola test repo ini) + test
// fungsi ASLI untuk semua yang bisa di-require (bukan menyalin logika).
//
// Run: node scraper/tests/test-vidara-anime.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HANDLER = path.join(ROOT, 'handlers', 'vidoy.js');
const BOT = path.join(ROOT, 'bot.js');
const UPLOADER = path.join(ROOT, 'vidara-uploader.js');
const DB = path.join(ROOT, 'db.js');

const HANDLER_SRC = fs.readFileSync(HANDLER, 'utf8');
const BOT_SRC = fs.readFileSync(BOT, 'utf8');

let passed = 0;
let failed = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });

// ─── helper: ekstrak fungsi dari source lalu jalankan ─────────────────────────

/** Ambil teks fungsi top-level bernama `name` dari source (body braces balancing). */
function extractFunction(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  assert.ok(m, `fungsi ${name} tidak ditemukan — perubahan hilang?`);
  const braceAt = src.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (let k = braceAt; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, k + 1);
    }
  }
  throw new Error(`akhir fungsi ${name} tidak ketemu`);
}

/** Jalankan fungsi yang diekstrak dengan sandbox. */
function runExtracted(src, name, args = [], extra = {}) {
  const code = extractFunction(src, name);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...Object.keys(extra), `${code}\nreturn ${name};`)(...Object.values(extra));
  return fn(...args);
}

// ═══ 1. TARGET & WIRING ══════════════════════════════════════════════════════

t('1) needVidara hidup untuk target vt/v (bukan false constant)', () => {
  assert.ok(
    /const needVidara = target === 'vt' \|\| target === 'v';/.test(HANDLER_SRC),
    "harus `const needVidara = target === 'vt' || target === 'v';` — kalau masih `false`, tombol Vidara jadi tidak_apply",
  );
  return 'vt + v ✓';
});

t('2) needTg mencakup vt (Vidara + TG) tapi BUKAN v (Vidara saja)', () => {
  const m = /const needTg = ([^;]+);/.exec(HANDLER_SRC);
  assert.ok(m, 'needTg tidak ditemukan');
  const expr = m[1];
  assert.ok(/'vt'/.test(expr), "needTg harus menyertakan 'vt' (Vidara + Telegram)");
  assert.ok(!/'v'/.test(expr), "needTg tidak boleh menyertakan 'v' (Vidara saja = tanpa Telegram)");
  return expr.trim();
});

t('3) animeTargetKeyboard punya tombol Vidara dan mundur kompatibel', () => {
  const fn = extractFunction(BOT_SRC, 'animeTargetKeyboard');
  assert.ok(/vtData/.test(fn) && /vData/.test(fn), 'parameter vtData/vData wajib ada');
  assert.ok(/Vidara \+ TG/.test(fn) && /'🗜 Vidara'/.test(fn), 'dua tombol Vidara wajib ada');
  // Kompatibilitas: pemanggil lama (3 argumen) tidak boleh membuat baris kosong.
  assert.ok(/\.\.\.\(row\.length \? \[row\] : \[\]\)/.test(fn),
    'baris Vidara harus kondisional — pemanggil 3 argumen harus tetap valid');
  return 'vt + v ✓';
});

t('4) SEMUA call site animeTargetKeyboard mengirim 5 target (tg, vyt, vv, vt, v)', () => {
  // Pisah dengan 'animeTargetKeyboard(' lalu ambil 500 karakter berikutnya —
  // regex non-greedy `\(...\)` akan berhenti di `)` pertama, yaitu `${server}`.
  const chunks = BOT_SRC.split('animeTargetKeyboard(').slice(1);
  const withArgs = chunks.filter((c) => /`[a-z_]+:(tg|vyt|vv|vt|v):/.test(c.slice(0, 500)));
  assert.ok(withArgs.length >= 6, `call site terdeteksi hanya ${withArgs.length}`);
  const bad = [];
  for (const c of withArgs) {
    const head = c.slice(0, 500);
    // Empat target host wajib ada di semua call site.
    for (const t of ['vyt', 'vv', 'vt', 'v']) {
      if (!new RegExp(`:${t}[\\$:\`]`).test(head)) bad.push(`${t} di ${c.slice(0, 50)}`);
    }
    // Target Telegram punya DUA bentuk sah: `:tg:` (dl_go, *_allgo) atau
    // prefix polos tanpa slot target (sam_go/kur_go — parser Sammat:: null →
    // Telegram). Yang salah kalau keduanya hilang.
    const adaTg = /:tg[\$:]/.test(head);
    const adaPolos = /`[a-z_]+:\$\{/.test(head) || /`[a-z_]+:\$\{urlId\}/.test(head);
    if (!adaTg && !adaPolos) bad.push(`tg di ${c.slice(0, 50)}`);
  }
  assert.ok(bad.length === 0, 'call site tanpa target baru: ' + bad.slice(0, 3).join(' | '));
  return `${withArgs.length} call site lengkap ✓`;
});

t('5) daftar validasi target memuat vt dan v', () => {
  const lists = BOT_SRC.match(/\['tg', 'vyt', 'vv'[^\]]*\]/g) || [];
  assert.ok(lists.length >= 5, `hanya ${lists.length} daftar target ditemukan`);
  for (const l of lists) {
    assert.ok(/'vt'/.test(l) && /'v'/.test(l), `daftar target belum punya vt/v: ${l}`);
  }
  return `${lists.length} daftar ✓`;
});

t('6) label target TIDAK menyimpang antara handlers/vidoy.js dan bot.js', () => {
  const grab = (src, fn) => {
    const f = extractFunction(src, fn);
    const m = /const map = \{([^}]+)\}/.exec(f);
    assert.ok(m, `peta label tidak ada di ${fn}`);
    return m[1];
  };
  const a = grab(HANDLER_SRC, 'targetLabel').replace(/\s+/g, '');
  const b = grab(BOT_SRC, 'batchTargetLabel').replace(/\s+/g, '');
  assert.strictEqual(a, b,
    `label target menyimpang:\n  handlers/vidoy.js: ${a}\n  bot.js: ${b}`);
  return a;
});

// ═══ 2. DEDUPE ═══════════════════════════════════════════════════════════════

t('7) pre-check dedupe berjalan SEBELUM download', () => {
  const iPre = HANDLER_SRC.indexOf('Pre-check dedupe');
  const iDl = HANDLER_SRC.indexOf('await ensureMp4(');
  assert.ok(iPre > 0, 'blok pre-check dedupe hilang');
  assert.ok(iPre < iDl,
    'pre-check harus sebelum ensureMp4 — kalau sesudah, unduhan 250 MB sudah\n     terbuang untuk episode yang ternyata "sudah ada"');
  return `pre-check @${iPre} < download @${iDl} ✓`;
});

t('8) Vidoy menang: record Vidoy = skip, tidak ada upload ke Vidara', () => {
  const fn = extractFunction(HANDLER_SRC, 'actionAnimeEpisode');
  const iVidoy = fn.indexOf('listVidoyUploads');
  const iGuard = fn.indexOf('skip — episode sudah ada di Vidoy');
  assert.ok(iVidoy > 0 && iGuard > iVidoy, 'cek record Vidoy tidak ada / salah urutan');
  // Bagian skip harus mengembalikan OUT (tidak ada upload apa pun setelahnya).
  assert.ok(/skip — episode sudah ada di Vidoy[\s\S]{0,400}return silent/.test(fn),
    'penjaga "sudah ada di Vidoy" harus return, bukan lanjut upload');
  return 'skip total ✓';
});

t('9) record Vidara tidak memblokir target Vidoy (hanya mencegah upload ulang)', () => {
  const fn = extractFunction(HANDLER_SRC, 'actionAnimeEpisode');
  // Seluruh pre-check (kedua penjaga) harus berada DI DALAM blok needVidara:
  // target vyt/vv tidak boleh pernah berhenti hanya karena ada record Vidara.
  const iNeed = fn.indexOf('if (needVidara) {');
  const iGuardVidara = fn.indexOf('if (!preVidoy && preVidara && !needTg) {');
  const iGuardVidoy = fn.indexOf('if (preVidoy && (!needTg || hasTg)) {');
  assert.ok(iNeed > 0, 'blok if (needVidara) hilang');
  assert.ok(iGuardVidara > iNeed && iGuardVidoy > iNeed,
    'kedua penjaga harus DI DALAM if (needVidara) — kalau tidak, Vidara bisa\n     memblokir target Vidoy (melanggar aturan: ada Vidara tetap boleh ke Vidoy)');
  // Penjaga Vidara hanya berlaku kalau tidak butuh Telegram: kalau butuh TG,
  // file tetap diunduh untuk dikirim (link diambil dari record, bukan diupload).
  const block = fn.slice(iGuardVidara, iGuardVidara + 700);
  assert.ok(block.includes('vidaraLinkFromRecord'), 'penjaga Vidara harus memakai link tersimpan');
  assert.ok(!/if \(!needVidoy && preVidara\)/.test(fn),
    'dilarang ada kondisi yang memblokir Vidoy hanya karena ada record Vidara');
  return 'pre-check hanya untuk target vt/v ✓';
});

t('10) record Vidara memakai key ber-suffix musim (S1 ≠ S3)', () => {
  const fn = extractFunction(HANDLER_SRC, 'actionAnimeEpisode');
  assert.ok(/getVidaraUpload\(String\(vidoyTitle\)/.test(fn),
    'getVidaraUpload harus pakai vidoyTitle (ada suffix musim)');
  assert.ok(/saveVidaraUpload\(String\(vidoyTitle\)/.test(fn),
    'saveVidaraUpload harus pakai vidoyTitle — key title polos menabrak antar musim');
  assert.ok(!/saveVidaraUpload\(String\(title\)/.test(fn),
    'masih ada saveVidaraUpload(String(title)) — key tanpa musim');
  return 'vidoyTitle ✓';
});

// ═══ 3. FALLBACK KUOTA ═══════════════════════════════════════════════════════

t('11) fallback HANYA untuk error kuota; error lain tetap dilempar', () => {
  const fn = extractFunction(HANDLER_SRC, 'actionAnimeEpisode');
  assert.ok(
    /if \(!canFallbackToVidara \|\| !isQuotaExceededError\(vErr\)\) throw vErr;/.test(fn),
    'penjaga fallback wajib: hanya quota_exceeded yang fallback.\n     CDN/signature/network error bukan alasan menyalin file ke host kedua',
  );
  return 'hanya kuota ✓';
});

t('12) fallback butuh VIDARA_KEY (tidak diam-diam berubah jadi error lain)', () => {
  const fn = extractFunction(HANDLER_SRC, 'actionAnimeEpisode');
  assert.ok(/const canFallbackToVidara = !!\(needVidoy && Vdara\.VIDARA_KEY\);/.test(fn),
    'canFallbackToVidara harus mengecek VIDARA_KEY');
  return 'VIDARA_KEY dicek ✓';
});

t('13) file bisa dipindah ke Vidara saat upload Vidoy gagal karena kuota', () => {
  const fn = extractFunction(HANDLER_SRC, 'actionAnimeEpisode');
  const iCatch = fn.indexOf('Vidoy quota habis — fallback ke Vidara');
  const iAllow = fn.indexOf('const vidaraAllowed =');
  assert.ok(iCatch > 0, ' fallback tidak ada');
  assert.ok(iAllow > iCatch, 'penentuan vidaraAllowed harus setelah percobaan Vidoy');
  assert.ok(/needVidara \|\| \(needVidoy && !out\.vidoy && canFallbackToVidara\)/.test(fn),
    'vidaraAllowed harus mencakup perluVidara DAN fallback');
  return 'fallback tersambung ✓';
});

t('14) lib/quota.js mengenali pesan 413 nyata (payload 1 Okt 2026)', () => {
  const { isQuotaExceededError, quotaResetDate } = require(path.join(ROOT, 'lib', 'quota.js'));
  const real = '{"status":413,"code":"quota_exceeded","title":"Storage limit reached","quota":{"views":0,"used":5332339036,"limit":5368709120,"limit_label":"5 GB","remaining":36370084,"exceeded":false,"percent":99.3,"next_tier":{"views_needed":100,"label":"10 GB"},"reset_at":"2026-11-01"}}';
  assert.ok(isQuotaExceededError(real), 'payload 413 asli harus terdeteksi');
  assert.strictEqual(quotaResetDate(real), '2026-11-01', 'tanggal reset harus terbaca');
  assert.ok(isQuotaExceededError(new Error('Vidoy register gagal: ' + real)), 'Error object harus terdeteksi');
  assert.ok(!isQuotaExceededError('Vidoy CDN status invalid'), 'error lain TIDAK boleh dianggap kuota');
  assert.ok(!isQuotaExceededError(null) && !isQuotaExceededError(undefined), 'null aman');
  return '413 asli ✓ reset 2026-11-01 ✓';
});

t('14b) quota terdeteksi dari judul pesan TANPA kata "quota"', () => {
  const { isQuotaExceededError } = require(path.join(ROOT, 'lib', 'quota.js'));
  // Kalau hanya "quota_exceeded" yang dikenali, pesan yang TITLE-nya saja yang
  // menandakan kuota akan lolos → tidak ada fallback, dan kuota habis jadi
  // diam-diam. Ini yang mengunci mutasi M8.
  const cases = [
    '{"status":413,"title":"Storage limit reached"}',
    '{"status":413,"code":"storage_limit"}',
    'insufficient storage to write file',
    'out of storage space on account',
    'You have exceeded your storage quota',
  ];
  for (const c of cases) assert.ok(isQuotaExceededError(c), `harus terdeteksi sebagai kuota: ${c}`);
  // "Rate limit reached" = 429 sementara. Salah klasifikasi akan menyalin file
  // ke host kedua untuk error yang hilang dalam hitungan detik.
  const notQuota = [
    'Rate limit reached, retry in 30s',
    'Too many requests',
    'Vidoy CDN status invalid',
    'gagal mengunduh video',
    'Encoding error',
    '',
  ];
  for (const c of notQuota) assert.ok(!isQuotaExceededError(c), `TIDAK boleh dianggap kuota: ${c}`);
  return `${cases.length} varian positif ✓ ${notQuota.length} negatif ✓`;
});

t('15) bot.js memakai lib/quota (tidak ada regex duplikat)', () => {
  assert.ok(/require\('\.\/lib\/quota'\)/.test(BOT_SRC), 'bot.js harus import dari lib/quota');
  const dup = BOT_SRC.match(/quota_exceeded\|storage limit reached/g) || [];
  assert.ok(dup.length === 0, `masih ada regex kuota duplikat di bot.js (${dup.length}) — harus satu sumber kebenaran`);
  return 'satu sumber ✓';
});

// ═══ 4. AUTO-HAPUS ════════════════════════════════════════════════════════════

t('16) auto-hapus Vidara setelah Vidoy sukses, dengan urutan server→DB', () => {
  const fn = extractFunction(HANDLER_SRC, 'actionAnimeEpisode');
  const iDel = fn.indexOf('Vdara.deleteVideo(');
  const iRow = fn.indexOf('db.deleteVidaraUpload(');
  assert.ok(iDel > 0 && iRow > 0, 'auto-hapus tidak ada (deleteVideo / deleteVidaraUpload)');
  assert.ok(iDel < iRow,
    'WAJIB hapus file di server DULU baru record DB.\n     Kalau dibalik: deleteVideo gagal → file yatim tanpa record (pola phantom record)');
  assert.ok(/if \(preVidara && preVidara\.filecode\)/.test(fn), 'auto-hapus harus hanya saat ada record Vidara');
  return 'server → DB ✓';
});

t('17) deleteVidaraUpload ada di db.js dan di-expor', () => {
  const dbSrc = fs.readFileSync(DB, 'utf8');
  assert.ok(/async function deleteVidaraUpload\(/.test(dbSrc), 'fungsi deleteVidaraUpload hilang');
  assert.ok(/deleteVidaraUpload,/.test(dbSrc), 'deleteVidaraUpload belum di module.exports');
  assert.ok(/RETURNING filecode/.test(dbSrc), 'sebaiknya RETURNING agar pemanggil tahu benar-benar terhapus');
  return 'db ✓';
});

// ═══ 5. CAPTION & LINK ═══════════════════════════════════════════════════════

t('18) caption memakai link Vidoy, atau link Vidara sebagai pengganti', () => {
  const fn = extractFunction(HANDLER_SRC, 'actionAnimeEpisode');
  assert.ok(/const captionLink = \(out\.vidoy && out\.vidoy\.link\) \|\| out\.vidaraLink \|\| '';/.test(fn),
    'captionLink harus pakai link Vidoy dulu, lalu Vidara');
  assert.ok(/link: captionLink,/.test(fn), 'buildCaption harus menerima captionLink');
  return 'link ✓';
});

t('19) caption 4 baris saat ada link (kontrak §5), label = domain asli URL', () => {
  const { buildCaption } = require(HANDLER);
  const cap = buildCaption({ title: 'Re:Zero kara Hajimeru Isekai Seikatsu S3', provider: 'Kamenime', part: 3, epStart: 3, epEnd: 3, link: 'https://vidara.to/0ijmPKLZqPCMr' });
  const lines = cap.split('\n');
  assert.strictEqual(lines.length, 4, `harus 4 baris, dapat ${lines.length}:\n${cap}`);
  assert.ok(lines[0].startsWith('➧ Judul'), 'baris 1 = Judul');
  assert.ok(lines[1].startsWith('➧ '), 'baris 2 = Part/Episode');
  assert.ok(lines[2].startsWith('➧ Provider'), 'baris 3 = Provider');
  assert.ok(lines[3].includes('vidara.to'), `baris 4 harus label domain ASLI (vidara.to): ${lines[3]}`);
  assert.ok(!cap.includes('undefined'), 'caption tidak boleh memuat undefined');
  // Tanpa link tetap 3 baris (Telegram-only).
  const cap3 = buildCaption({ title: 'X', provider: 'Kamenime', part: 1, epStart: 1, epEnd: 1 });
  assert.strictEqual(cap3.split('\n').length, 3, 'tanpa link harus 3 baris');
  return '4 baris ✓ label vidara.to ✓';
});

t('20) host Vidara diambil dari respons API, tidak dipatok di kode', () => {
  const V = require(UPLOADER);
  const fromUrl = V.extractUploadRef('{"filecode":"https://vidara.to/e/0ijmPKLZqPCMr"}');
  assert.strictEqual(fromUrl.code, '0ijmPKLZqPCMr', 'kode harus diambil dari URL');
  assert.strictEqual(fromUrl.host, 'vidara.to', 'host harus dari respons API');
  const bare = V.extractUploadRef({ result: { filecode: 'ABC123' } });
  assert.strictEqual(bare.code, 'ABC123', 'kode polos harus lewat');
  assert.strictEqual(bare.host, '', 'kode polos tidak punya host');
  // Domain lain harus ikut terpakai (situsnya bisa ganti domain).
  const lain = V.extractUploadRef('{"filecode":"https://vidara.example/e/XYZ9"}');
  assert.strictEqual(lain.host, 'vidara.example', 'host tidak boleh dipatok');
  assert.strictEqual(V.buildVideoLink(lain, ''), 'https://vidara.example/XYZ9', 'link dibangun dari host respons');
  // Link dari API (/video/info) menang karena itu yang dipakai server.
  assert.strictEqual(V.buildVideoLink(fromUrl, 'https://vidara.to/0ijmPKLZqPCMr'), 'https://vidara.to/0ijmPKLZqPCMr');
  // extractFilecode lama harus tetap kompatibel (dipakai drama).
  assert.strictEqual(V.extractFilecode('{"filecode":"https://vidara.to/e/0ijmPKLZqPCMr"}'), '0ijmPKLZqPCMr');
  return 'host dinamis ✓';
});

t('21) vidaraLinkFromRecord merekonstruksi link dari record DB', () => {
  const got = runExtracted(HANDLER_SRC, 'vidaraLinkFromRecord', [{ filecode: '0ijmPKLZqPCMr', domain: 'vidara.to' }]);
  assert.strictEqual(got, 'https://vidara.to/0ijmPKLZqPCMr', `link salah: ${got}`);
  // Domain default 'vidara.so' MEMANG ada titik → boleh dipakai sebagai fallback.
  const fb = runExtracted(HANDLER_SRC, 'vidaraLinkFromRecord', [{ filecode: 'ABC', domain: 'vidara.so' }]);
  assert.strictEqual(fb, 'https://vidara.so/ABC', `fallback salah: ${fb}`);
  // Host/url ikut diterima (kalau kolom berisi URL penuh).
  const full = runExtracted(HANDLER_SRC, 'vidaraLinkFromRecord', [{ filecode: 'https://vidara.to/e/ZZZ1', domain: 'vidara.to' }]);
  assert.strictEqual(full, 'https://vidara.to/ZZZ1', `URL penuh salah: ${full}`);
  // Tanpa domain tidak boleh fabricating link.
  assert.strictEqual(runExtracted(HANDLER_SRC, 'vidaraLinkFromRecord', [{ filecode: 'ABC', domain: '' }]), '');
  assert.strictEqual(runExtracted(HANDLER_SRC, 'vidaraLinkFromRecord', [null]), '');
  return 'rekonstruksi ✓';
});

t('22) extractUploadRef exists + deleteVideo memanggil endpoint yang benar', () => {
  const V = require(UPLOADER);
  assert.strictEqual(typeof V.extractUploadRef, 'function', 'extractUploadRef belum di-export');
  assert.strictEqual(typeof V.deleteVideo, 'function', 'deleteVideo belum di-export');
  assert.ok(/\/video\/delete/.test(V.deleteVideo.toString()), 'endpoint harus /video/delete');
  return 'export ✓';
});

// ═══ 6. STATUS PICKER ════════════════════════════════════════════════════════

t('23) statusBreakdown menghitung "Vidara saja" terpisah dari Telegram', () => {
  const map = new Map([
    [1, { lib: false, tg: true, link: null, vidara: false }],
    [2, { lib: false, tg: false, link: null, vidara: true }],
    [3, { lib: false, tg: false, link: 'https://v/3', vidara: false }],
  ]);
  const s = runExtracted(BOT_SRC, 'statusBreakdown', [map, 5]);
  assert.ok(/\ud83d\udce8 1 di Telegram/.test(s), `tidak ada hitungan Telegram: ${s}`);
  assert.ok(/\ud83d\udd1c 1 Vidara saja/.test(s), `tidak ada label "Vidara saja": ${s}`);
  assert.ok(/\ud83d\uddc4 1 perlu dikirim/.test(s), `hitungan perlu dikirim salah: ${s}`);
  assert.ok(/⬜ 2 belum ada/.test(s), `hitungan belum salah: ${s}`);
  // Vidara yang SUDAH terkirim ke Telegram tidak boleh dihitung dua kali.
  const both = new Map([[1, { lib: false, tg: true, link: null, vidara: true }]]);
  const s2 = runExtracted(BOT_SRC, 'statusBreakdown', [both, 1]);
  assert.ok(/\ud83d\udce8 1 di Telegram/.test(s2), `harus tetap dihitung sebagai Telegram: ${s2}`);
  assert.ok(!/Vidara saja/.test(s2), `tidak boleh dobel: ${s2}`);
  return `1/1/1/2 ✓`;
});

t('24) episodeStatusMap menandai vidara dari vidara_uploads tanpa mengubah tg/link', async () => {
  const dbPath = require.resolve(path.join(ROOT, 'db.js'));
  const real = require.cache[dbPath];
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
      listPartsWithFile: async () => [],
      listVidoyUploads: async () => [],
      listVidaraUploads: async (k) => (k === 'Judul S3' ? [{ ep: 5, filecode: 'AAA', domain: 'vidara.to' }] : []),
      findMediaByPattern: async () => null,
    },
  };
  let map;
  try {
    delete require.cache[require.resolve(path.join(ROOT, 'lib', 'episode-status.js'))];
    const mod = require(path.join(ROOT, 'lib', 'episode-status.js'));
    map = await mod.episodeStatusMap('anime:judul', 'Judul S3');
  } finally {
    if (real) require.cache[dbPath] = real; else delete require.cache[dbPath];
  }
  const st = map.get(5);
  assert.ok(st, 'episode 5 tidak muncul di statusMap');
  assert.strictEqual(st.vidara, true, 'vidara harus true');
  assert.strictEqual(st.tg, false, 'vidara TIDAK boleh menandai terkirim ke Telegram');
  assert.strictEqual(st.link, null, 'vidara TIDAK boleh mengisi link');
  return 'vidara flag ✓ tg/link tidak tersentuh ✓';
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