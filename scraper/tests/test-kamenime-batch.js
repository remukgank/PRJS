/**
 * test-kamenime-batch.js
 *
 * Mengunci 10 item di docs/proposals/2026-09-27-kamenime-download-semua.md
 *
 * Akar yang berulang: tombol "⬇️ Download Semua" di picker kamenime mengirim
 * sam_all: (prefix default buildPicker) → dijalankan sebagai perintah Samehadaku.
 * Setelah di-prefix jadi 'kam', tombolnya jadi PATAH (tidak ada handler) —
 * violations "kegagalan diam-diam" AGENTS.md §4. Test ini mengunci handler
 * yang benar-benar bekerja + 4 koreksi dari review user.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BOT = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
const DL = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'download.js'), 'utf8');
const VID = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'vidoy.js'), 'utf8');

let pass = 0, fail = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });
const done = (name, err) => {
  if (err) { fail++; console.log(`FAIL  ${name}\n      ${String(err.message).split('\n')[0]}`); }
  else { pass++; console.log(`PASS  ${name}`); }
};
/** Blok fungsi di bot.js mulai dari pola. */
function botBlock(marker, len = 20000) {
  const i = BOT.indexOf(marker);
  if (i < 0) return '';
  return BOT.slice(i, i + len);
}
/**('@' 2) Potong blok PADA handler berikutnya, bukan angka karakter tetap. */
function botHandler(marker, nextMarker) {
  const i = BOT.indexOf(marker);
  if (i < 0) return '';
  const j = nextMarker ? BOT.indexOf(nextMarker, i) : -1;
  return BOT.slice(i, j > 0 ? j : i + 20000);
}
/**
 * Potong blok PADA deklarasi fungsi berikutnya, bukan angka karakter tetap.
 *
 * PENTING (1 Okt 2026): `len = 9000` pernah dipakai di sini dan gagal diam-diam
 * begitu actionAnimeEpisode tumbuh melewati 9 KB (fungsi ini kini ~13 KB setelah
 * jalur Vidara masuk). Empat tes ikut gagal padahal perilakunya masih benar.
 * Potong di batas fungsi → panjang fungsi boleh berubah tanpa membuat tesbuta.
 */
function vidBlock(marker) {
  const i = VID.indexOf(marker);
  if (i < 0) return '';
  const j = VID.indexOf('\nfunction ', i + 1);
  return VID.slice(i, j > 0 ? j : VID.length);
}

// ── 1) kam_all: menampilkan pilihan target ───────────────────────────────
t('1) kam_all: menampilkan pilihan target tg/vyt/vv + "Lengkapi"', () => {
  const b = botBlock("data.startsWith('kam_all:')");
  assert.ok(b, 'handler kam_all: tidak ada');
  assert.ok(b.includes('animeTargetKeyboard('), 'harus pakai animeTargetKeyboard');
  for (const tg of ['kam_allgo:tg:', 'kam_allgo:vyt:', 'kam_allgo:vv:']) {
    assert.ok(b.includes(tg), `tombol target ${tg} tidak ada`);
  }
  assert.ok(b.includes('kam_fix:'), 'harus ada tombol "⟳ Lengkapi yang hilang"');
  assert.ok(b.includes('Pilih target upload untuk semua episode'), 'harus menanyakan target');
});

// ── 2) episode yang sudah lengkap DILEWATI (AGENTS.md §6) ────────────────
t('2) episode yang link+Telegram lengkap dilewati (bukan diunggah ulang)', () => {
  const b = botBlock("data.startsWith('kam_all:')");
  assert.ok(b.includes('animeDoneMap('), 'harus pakai animeDoneMap');
  const m = b.match(/st\.link\s*&&\s*st\.hasTg[\s\S]{0,90}skip/);
  assert.ok(m, 'harus ada guard "st.link && st.hasTg" → skip');
  assert.ok(b.includes('kmSkipped++'), 'harus menghitung episode yang dilewati');
});

// ── 3) silent per-panggilan: tidak membuat RichProgress per episode ──────
t('3) handleKamenimeUrl menerima opts.silent dan tidak buat RichProgress', () => {
  assert.ok(/handleKamenimeUrl\(chatId, url, customTitle = null, expectedEp = null, opts = \{\}\)/.test(DL),
    'signature harus punya parameter ke-5 opts = {}');
  const i = DL.indexOf('async function handleKamenimeUrl');
  const blk = DL.slice(i, i + 2400);
  assert.ok(/opts\.silent\s*\|\|\s*_samQuiet/.test(blk),
    'harus pakai opts.silent || _samQuiet (backward-compatible)');
  assert.ok(blk.includes('noopRp()'), 'harus memakai noopRp() saat silent');
  // TIDAK boleh hanya _samQuiet (itu yang bocor ke download manual)
  assert.ok(!/rp = _samQuiet \? noopRp/.test(blk), 'masih memakai _samQuiet global saja');
});

// ── 4) semua call-site lama tetap kompatibel ────────────────────────────
t('4) call-site handleKamenimeUrl yang ada tetap kompatibel', () => {
  // bot.js wrapper (1514) & dl_go (4505) — keduanya 3 argumen, default {} aman
  const m = BOT.match(/return _downloadHandlers\.handleKamenimeUrl\([^)]*\)/);
  assert.ok(m, 'wrapper bot.js tidak ditemukan');
  assert.ok(!/,\s*\{\s*silent/.test(m[0]), 'wrapper lama tidak perlu opts');
  // tidak ada call-site yang mengirim >4 argumen tanpa opts
  for (const mm of BOT.matchAll(/handleKamenimeUrl\(([^)]*)\)/g)) {
    const args = mm[1].split(',').length;
    assert.ok(args <= 5, `call-site dengan ${args} argumen (max 5): ${mm[0].slice(0, 70)}`);
  }
});

// ── 5) actionAnimeEpisode menyimpan library, gated libsimpan ─────────────
t('5) actionAnimeEpisode menulis library + gate getSetting("libsimpan")', () => {
  const b = vidBlock('async function actionAnimeEpisode');
  assert.ok(b.includes('upsertMedia('), 'harus memanggil upsertMedia');
  assert.ok(b.includes('savePartFileId('), 'harus memanggil savePartFileId');
  assert.ok(b.includes("getSetting('libsimpan')"), 'harus gate libsimpan');
  // Gaya download.js:817 → (await getSetting('libsimpan')) === 'on'
  assert.ok(/\(await getSetting\('libsimpan'\)\) === 'on'/.test(b),
    "harus tepat: (await getSetting('libsimpan')) === 'on'");
  assert.ok(/savePartFileId\(libSlug, num, sent\.video\.file_id/.test(b),
    'file_id harus diambil dari hasil send (telegram)');
});

// ── 6) tidak dobel-tulis kalau sudah ada file_id ────────────────────────
t('6) cek duplikat: getPartFileId dulu sebelum tulis', () => {
  const b = vidBlock('async function actionAnimeEpisode');
  const iGet = b.indexOf('getPartFileId(');
  const iUp = b.indexOf('upsertMedia(');
  assert.ok(iGet > 0 && iUp > 0, 'harus ada getPartFileId + upsertMedia');
  assert.ok(iGet < iUp, 'getPartFileId harus DIPANGGIL SEBELUM upsertMedia');
  assert.ok(/if \(!existing\)/.test(b), 'hanya tulis kalau belum ada');
});

// ── 7) source_pattern dari URL, bukan nama file (jebak ejaan) ───────────
t('7) source_pattern dari episodeUrl (bukan sanitizeSlug(namaFile))', () => {
  const b = vidBlock('async function actionAnimeEpisode');
  assert.ok(b.includes('kamenimeSourcePattern(episodeUrl)'),
    'WAJIB kamenimeSourcePattern(episodeUrl) — pola dari URL stabil');
  assert.ok(!/kamenimeSourcePattern\(\s*destPath/.test(b),
    'jangan pakai destPath (nama file) sebagai pola');
  const m = b.match(/const libPat = [^;]+;/);
  assert.ok(m && m[0].includes('episodeUrl'), 'libPat harus dari episodeUrl');
});

// ── 8) customTitle dikirim di SETIAP episode, bukan hanya ep 1 ───────────
t('8) customTitle dikirim di setiap episode (bukan hanya episode 1)', () => {
  const b = botBlock("data.startsWith('kam_all:')");
  const iCall = b.indexOf('handleKamenimeUrl(chatId, e.url');
  assert.ok(iCall > 0, 'handleKamenimeUrl harus dipanggil di dalam loop');
  const line = b.slice(iCall, iCall + 180);
  assert.ok(/kmTitle/.test(line),
    'harus mengirim kmTitle sebagai customTitle di setiap episode');
  assert.ok(/\{ silent: true \}/.test(line), 'harus mengirim { silent: true }');
  // WAJIB: customTitle UNTAK bersyarat pada nomor episode. Kalau diberi hanya
  // untuk ep 1 (mis. `Number(e.ep) === 1 ? kmTitle : null`), dan ep 1 gagal di
  // savePartFileId, maka 499 episode berikutnya jatuh ke nama file. Regulator ini
  // menangkap pola kondisional itu — bukan sekadar cek kata "kmTitle" ada.
  const arg = line.match(/handleKamenimeUrl\(chatId, e\.url,\s*([^,]+),/);
  assert.ok(arg, 'tidak bisa mengambil argumen customTitle');
  const customTitleArg = arg[1].trim();
  assert.ok(!/\?/.test(customTitleArg),
    `customTitle bersyarat ("${customTitleArg}") — harus dikirim apa adanya di setiap episode`);
  assert.ok(!/(===|==|!==|!=|\?|\bep\b\s*===)/.test(customTitleArg),
    `customTitle memakai kondisi episode ("${customTitleArg}") — hanya ep 1 boleh, itu bug`);
  assert.ok(customTitleArg === 'kmTitle',
    `customTitle harus kmTitle apa adanya, dapat "${customTitleArg}"`);
});

// ── 9) pace + try/finally lepas lock ────────────────────────────────────
t('9) loop memberi pace (SAM_BATCH_PACE_MS) + finally lepas lock', () => {
  const b = botHandler("data.startsWith('kam_all:')", "data.startsWith('sam_ep:')");
  assert.ok(b.includes("data.startsWith('kam_all:')"), 'blok handler kosong');
  assert.ok(b.includes('sleep(_downloadHandlers.SAM_BATCH_PACE_MS'),
    'harus pace dengan SAM_BATCH_PACE_MS (sama seperti sam_all)');
  const iTry = b.indexOf('try {');
  const iFin = b.indexOf('} finally {');
  const iDel = b.indexOf('samAllBusy.delete(');
  assert.ok(iTry > 0 && iFin > iTry && iDel > iFin,
    'harus try { ... } finally { samAllBusy.delete(...) }');
  assert.ok(b.includes('samAllBusy.add(kmBusyKey)'), 'harus kunci anime lewat samAllBusy');
  assert.ok(b.includes('sedang berjalan'), 'harus tolak kalau batch sedang jalan');
});

// ── 10) rekap akhir memuat DAFTAR episode gagal ─────────────────────────
t('10) rekap akhir memuat daftar episode gagal, bukan cuma jumlah', () => {
  const b = botHandler("data.startsWith('kam_all:')", "data.startsWith('sam_ep:')");
  assert.ok(b.includes('kmRp.done()'), 'blok handler terpotong — test tidak bisa percaya');
  assert.ok(b.includes('kmFailed.push('), 'harus mengumpulkan episode gagal');
  assert.ok(b.includes('kmFailed.length'), 'harus menghitung');
  // Regex wajib vendor-nestable: map() arg-nya template literal berisi ')'.
  const m = b.match(/kmFailed\.map\([\s\S]{0,60}?\)\.join\(/);
  assert.ok(m, 'rekap harus MENYATUKAN nomor episode gagal ke pesan');
  assert.ok(/Gagal \(/.test(b), 'rekap harus menampilkan daftar "Gagal (n): Ep x, Ep y"');
  assert.ok(b.includes('kmLinks') || b.includes('kmLinkBlock'),
    'rekap harus menampilkan link Vidoy (meniru sam_all)');
});

// ── 11) bonus: guard provider, jangan sampai samehadaku/kuronime ikut ────
t('11) library di actionAnimeEpisode WAJIB gated provider=hokireceh', () => {
  const b = vidBlock('async function actionAnimeEpisode');
  const iCond = b.indexOf("animeProvider === 'hokireceh'");
  assert.ok(iCond > 0,
    'harus ada syarat animeProvider === "hokireceh" — tanpa itu samehadaku+kuronime ikut mengisi library');
  const iUp = b.indexOf('upsertMedia(');
  assert.ok(iCond < iUp, 'syarat provider harus SEBELUM upsertMedia');
  assert.ok(b.includes('gagal'), 'kegagalan library tidak boleh menggagalkan upload');
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); done(name, null); }
    catch (e) { done(name, e); }
  }
  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
