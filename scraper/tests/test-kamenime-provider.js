'use strict';

// Regression test: provider kamenime (MP4 direct).
//
// 27 Sep 2026 — muncul karena server gdriveplayer (Samehadaku) macet di
// 20–120 KB/s: 43,7 MB dalam 18 menit, 3× retry sia-sia, 65 MB terbuang.
// Kamenime serves MP4 langsung di 3–9 MB/s tanpa perlu remux, tanpa worker
// Cloudflare (yang clearance-nya sering expired).
//
// Yang paling rawan di sini: URL /storage/ mengandung SPASI TELANJANG
// (`/storage/anime/Naruto Shippuden/...mp4`) — kalau tidak di-encode, fetch
// gagal ERR_UNESCAPED_SPACE. Dan file MP4 TIDAK BOLEH masuk jalur gdriveplayer
// (download.js:968 memaksa ekstensi .ts → remuxToMp4 jalan → file salah tipe).
//
// Run: node scraper/tests/test-kamenime-provider.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isKamenimeUrl, resolveKamenimeFile, fileNameFromUrl, absolutize } = require('../providers/kamenime');

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log(`PASS  ${name}`); passed++; }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
}

const SLUG = 'naruto-shippuden';
const PAGE_EP1 = 'https://www.kamenime.com/anime/naruto-shippuden/episode/1';
const FILE_EP1 = 'https://www.kamenime.com/storage/anime/Naruto%20Shippuden/Naruto%20Shippuden-episode-1.mp4';

(async () => {
  // ── a) /anime/<slug>/episode/<N> → resolve ke URL .mp4 benar ──
  await t('a) halaman /anime/<slug>/episode/1 → resolve ke URL .mp4 yang benar', async () => {
    const r = await resolveKamenimeFile(PAGE_EP1);
    assert.ok(isKamenimeUrl(r.fileUrl), 'hasil harus tetap URL kamenime');
    assert.ok(/\/storage\/anime\/Naruto%20Shippuden\/Naruto%20Shippuden-episode-1\.mp4$/.test(r.fileUrl),
      `path salah: ${r.fileUrl}`);
    assert.ok(!/ /.test(r.fileUrl), `URL tidak boleh berisi space mentah: ${r.fileUrl}`);
    assert.strictEqual(r.fileName, 'Naruto Shippuden-episode-1.mp4');
    console.log(`      → ${r.fileUrl}`);
    console.log(`      → fileName: ${r.fileName}`);
  });

  // ── b) /storage/...mp4 → instan, TANPA request network ──
  await t('b) bentuk /storage/ → fileUrl persis input, tanpa request', async () => {
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (...a) => { called++; return realFetch(...a); };
    let r;
    try { r = await resolveKamenimeFile(FILE_EP1); } finally { globalThis.fetch = realFetch; }
    assert.strictEqual(called, 0, `harus tanpa request, tapi ${called} request`);
    assert.strictEqual(r.fileUrl, FILE_EP1, 'fileUrl harus persis input');
    assert.strictEqual(r.fileName, 'Naruto Shippuden-episode-1.mp4');
    console.log(`      → ${r.fileUrl} (0 request)`);
  });

  // ── c) URL non-kamenime → isKamenimeUrl() false (anti-tabrakan) ──
  await t('c) isKamenimeUrl() false untuk URL provider lain', () => {
    const lain = [
      'https://gofile.io/d/abc123', 'https://pixeldrain.com/u/abc', 'https://filedon.co/abc',
      'https://mega.nz/file/abc#key', 'https://drive.google.com/file/d/abc/view',
      'https://gdriveplayer.to/download.php?link=abc', 'https://v2.samehadaku.how/naruto-shippuuden-episode-1/',
      'https://www.kamenime.com/anime/naruto-shippuden',       // halaman anime, BUKAN episode
      'https://kamenime.com.evil.tld/storage/x.mp4',           // domain menipu
      'not-a-url',
    ];
    for (const u of lain) assert.strictEqual(isKamenimeUrl(u), false, `harus false: ${u}`);
  });

  // ── d) halaman tanpa <source> → error jelas, bukan diam ──
  await t('d) halaman tanpa <source> → error yang menyebut <source>', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '<html><body>Tidak ada video di sini</body></html>' });
    let err = null;
    try { await resolveKamenimeFile(PAGE_EP1); } catch (e) { err = e; }
    globalThis.fetch = realFetch;
    assert.ok(err, 'harus melempar error');
    assert.ok(/<source src> tidak ditemukan/.test(err.message), `pesan kurang jelas: ${err.message}`);
    console.log(`      → ${err.message}`);
  });

  // ── e) MUTASI: guard urung agar kamenime masuk jalur gdriveplayer ──
  // download.js memaksa ekstensi .ts pada file gdriveplayer:
  //   const gpName = /\.ts$/i.test(gpBase) ? gpBase : `${gpBase}.ts`;
  // Kalau ini bocor, MP4.Named .ts lalu remuxToMp4 jalan. Test WAJIB gagal
  // kalau urutan guard berubah.
  await t('e) guard: isKamenimeUrl dicek SEBELAH isGdrivePlayerUrl di resolveDirectUrl', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'download.js'), 'utf8');
    // WAJIB dipakai pada scopes resolveDirectUrl SAJA — string isGdrivePlayerUrl
    // juga muncul di downloadSamehadakuFile, dan indexOf akan salah tangkap.
    const start = src.indexOf('async function resolveDirectUrl');
    const end = src.indexOf('\n  async function ', start + 10);
    const body = src.slice(start, end > start ? end : undefined);
    const iKm = body.indexOf('if (isKamenimeUrl(url)) {');
    const iGp = body.indexOf('if (isGdrivePlayerUrl(url)) {');
    assert.ok(iKm > 0, `resolveDirectUrl harus punya cabang kamenime (idx ${iKm})`);
    assert.ok(iGp > 0, `resolveDirectUrl harus punya cabang gdriveplayer (idx ${iGp})`);
    assert.ok(iKm < iGp, `kamenime (idx ${iKm}) harus SEBELUM gdriveplayer (idx ${iGp}) — kalau tidak, .mp4 dipaksa jadi .ts`);
  });

  // ── f) handleKamenimeUrl: pertahankan .mp4 + pastikan FASTSTART ──
  await t('f) handleKamenimeUrl pertahankan .mp4 dan memaksa faststart (streaming)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'download.js'), 'utf8');
    const s = src.indexOf('async function handleKamenimeUrl');
    const e = src.indexOf('async function handleMegaUrl', s);
    assert.ok(s > 0 && e > s, 'handleKamenimeUrl harus ada sebelum handleMegaUrl');
    const body = src.slice(s, e);
    assert.ok(/\.endsWith\('\.mp4'\)/.test(body), 'nama file harus dipertahankan .mp4');
    // faststart: MP4 non-faststart tidak bisa streaming di Telegram
    assert.ok(/isFaststartMp4\(outPath\)/.test(body), 'harus mengecek faststart');
    assert.ok(/remuxToMp4\(outPath/.test(body), 'harus remux kalau belum faststart');
    assert.ok(/sendAnimeMedia/.test(body), 'wajib lewat sendAnimeMedia (topic Anime)');
    assert.ok(/supports_streaming:\s*true/.test(body), 'harus supports_streaming: true (kontrak media)');
    console.log('      → cek faststart + remux saat perlu, .mp4 dipertahankan');
  });

  // ── f2) remuxToMp4: MP4 non-faststart WAJIB di-remux ──
  await t('f2) remuxToMp4 memaksa remux untuk MP4 non-faststart (bukan skip)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'downloader.js'), 'utf8');
    const s = src.indexOf('async function remuxToMp4');
    const e = src.indexOf('\n}', s);
    const body = src.slice(s, e);
    assert.ok(/isFaststartMp4\(inputPath\)/.test(body),
      'remuxToMp4 harus mengecek faststart — MP4 non-faststart tidak boleh di-skip');
    assert.ok(/function isFaststartMp4\(filePath\)/.test(src), 'helper isFaststartMp4 harus ada');
    const helper = src.slice(src.indexOf('function isFaststartMp4'), src.indexOf('async function remuxToMp4'));
    assert.ok(/type === 'moov'/.test(helper) && /type === 'mdat'/.test(helper),
      'helper harus bedakan moov sebelum mdat');
  });


  // ── g) caption WAJIB lewat buildCaption (bug: caption jadi 1 baris) ──
  await t('g) caption pakai buildCaption: 3 baris (atau 4 + link), tidak pernah 1 baris', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'download.js'), 'utf8');
    const s = src.indexOf('async function handleKamenimeUrl');
    const e = src.indexOf('async function handleMegaUrl', s);
    const body = src.slice(s, e > s ? e : undefined);
    assert.ok(/require\('\.\/vidoy'\)\.buildCaption\(/.test(body),
      'handleKamenimeUrl WAJIB memakai buildCaption (kontrak media)');
    // mustahil kembali ke caption 1 baris
    assert.ok(!/let finalCap = cap;/.test(body), 'jangan lagi jatuh ke `cap` mentah (penyebab caption 1 baris)');
    assert.ok(!/if \(titleForCap\)\s*\{\s*finalCap = \[/.test(body), 'caption manual kondisional = bug lama');

    // bukti nyata: buildCaption untuk kasus title ada & kosong
    const { buildCaption } = require('../handlers/vidoy');
    for (const title of ['Naruto Shippuden', null]) {
      const c = buildCaption({ title, provider: 'kamenime', part: 1, epStart: 1, epEnd: 1, link: null });
      const lines = c.split('\n');
      assert.strictEqual(lines.length, 3, `harus 3 baris tanpa link, dapat ${lines.length}: ${c}`);
      assert.ok(lines[0].startsWith('➧ Judul :-'), `baris 1: ${lines[0]}`);
      assert.ok(lines[1].startsWith('➧ Episode :- 1'), `baris 2: ${lines[1]}`);
      assert.ok(lines[2].startsWith('➧ Provider :-'), `baris 3: ${lines[2]}`);
      assert.ok(!/undefined/.test(c), 'caption tidak boleh memuat undefined');
    }
    const c4 = buildCaption({ title: 'X', provider: 'kamenime', part: 1, epStart: 1, epEnd: 1, link: 'https://vski.cc/e/abc' });
    assert.strictEqual(c4.split('\n').length, 4, 'dengan link harus 4 baris');
    console.log('      → tanpa link: 3 baris | dengan link: 4 baris | undefined: tidak ada');
  });

  // ── h) encoding space & decode entity ──
  await t('h) absolutize() encode space + decode &amp;', () => {
    const a = absolutize('/storage/anime/Naruto Shippuden/Naruto Shippuden-episode-1.mp4');
    assert.ok(!/ /.test(a), `space harus ter-encode: ${a}`);
    assert.ok(a.includes('Naruto%20Shippuden'), `path salah: ${a}`);
    const b = absolutize('/storage/anime/A&amp;B/x.mp4');
    assert.ok(b.includes('A&B'), `&amp; harus di-decode: ${b}`);
    assert.strictEqual(fileNameFromUrl(a), 'Naruto Shippuden-episode-1.mp4');
    console.log(`      → encode: ${a.slice(0, 70)}…`);
  });

  // ── i) dl_go target 'tg' → handleKamenimeUrl, BUKAN resolveDirectUrl ──
  // Bug (27 Sep 2026): cabang kamenime TIDAK ADA di blok target 'tg' dari
  // dl_go. Akibatnya link kamenime + target Telegram jatuh ke
  // resolveDirectUrl() — itu jalur Vidoy, jadi user memilih "Telegram"
  // tapi file dikirim ke Vidoy. Salah target.
  await t('i) dl_go target tg → handleKamenimeUrl (bukan resolveDirectUrl/Vidoy)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
    // Blok dispatch dl_go:tg = rangkaian "return handleXUrl(chatId, url, detectedTitle".
    const start = src.indexOf("if (isPixeldrainUrl(url)) return handlePixeldrainUrl(chatId, url, detectedTitle || undefined);");
    assert.ok(start > 0, 'blok dl_go:tg harus ada');
    const end = src.indexOf('// target = vyt atau vv', start);
    assert.ok(end > start, 'harus ada penanda akhir blok tg sebelum jalur vyt/vv');
    const block = src.slice(start, end);
      assert.ok(/if \(isKamenimeUrl\(url\)\) return handleKamenimeUrl\(chatId, url, titleForCap\);/.test(block),
      `blok tg tidak punya cabang kamenime (atau tidak meneruskan titleForCap):\n${block}`);
    // Fallback ke resolveDirectUrl hanya boleh SETELAH semua cabang handler.
    const lastHandler = block.lastIndexOf('return handle');
    const resolveCall = block.indexOf('resolveDirectUrl(');
    assert.ok(resolveCall === -1 || lastHandler < resolveCall,
      'resolveDirectUrl (jalur Vidoy) tidak boleh muncul sebelum cabang handler');
    console.log('      → tg: handleKamenimeUrl ada; resolveDirectUrl (Vidoy) tidak di blok tg');
  });

  // ── j) simulasi: jalankan logika blok tg dengan spy ──
  await t('j) simulasi dispatch tg: kamenime → handleKamenimeUrl dipanggil 1x', async () => {
    const calls = [];
    const fake = {
      handlePixeldrainUrl: async () => { calls.push('pixeldrain'); },
      handleFiledonUrl: async () => { calls.push('filedon'); },
      handleKamenimeUrl: async (c, u) => { calls.push('kamenime'); return { ok: true }; },
      handleMegaUrl: async () => { calls.push('mega'); },
      handleGdriveUrl: async () => { calls.push('gdrive'); },
      resolveDirectUrl: async () => { calls.push('resolveDirectUrl'); return { url: 'x' }; },
    };
    // Logika SAMA PERSIS dengan baris di bot.js (disalin, bukan di-require,
    // karena bot.js menjalankan polling Telegram saat di-require).
    // Test (i) yang mengunci kode bot.js sungguhan; (j) membuktikan urutan
    // percabangan menghasilkan handler yang benar untuk URL kamenime.
    const isGdrive = (u) => /drive\.google\.com/.test(u);
    const isPixeldrain = (u) => /pixeldrain\.com/.test(u);
    const isFiledon = (u) => /filedon\.co/.test(u);
    const isMega = (u) => /mega\.nz/.test(u);
    const dispatch = async (url) => {
      if (isGdrive(url)) return fake.handleGdriveUrl();
      if (isPixeldrain(url)) return fake.handlePixeldrainUrl();
      if (isFiledon(url)) return fake.handleFiledonUrl();
      if (isKamenimeUrl(url)) return fake.handleKamenimeUrl();
      if (isMega(url)) return fake.handleMegaUrl();
      return null;
    };

    const r = await dispatch(FILE_EP1);
    assert.deepStrictEqual(calls, ['kamenime'], `harus(handleKamenimeUrl dipanggil, bukan resolveDirectUrl — dapat ${JSON.stringify(calls)}`);
    assert.ok(r && r.ok, 'harus return hasil handleKamenimeUrl');
    console.log(`      → spy: ${JSON.stringify(calls)} (bukan resolveDirectUrl)`);
  });

  // ── k) parseKamenimeAnime + isKamenimeAnimePage (offline) ──
  await t('k) parseKamenimeAnime() → slug dari URL, isKamenimeAnimePage pisahkan halaman vs episode', () => {
    const { parseKamenimeAnime, isKamenimeAnimePage } = require('../providers/kamenime');
    const a = parseKamenimeAnime('https://www.kamenime.com/anime/naruto-shippuden');
    assert.strictEqual(a.slug, 'naruto-shippuden');
    assert.strictEqual(a.pageUrl, 'https://www.kamenime.com/anime/naruto-shippuden');
    // halaman anime → true; episode & file → false (bukan pintu picker)
    assert.strictEqual(isKamenimeAnimePage('https://www.kamenime.com/anime/naruto-shippuden'), true);
    assert.strictEqual(isKamenimeAnimePage('https://www.kamenime.com/anime/naruto-shippuden/'), true);
    assert.strictEqual(isKamenimeAnimePage('https://www.kamenime.com/anime/naruto-shippuden/episode/1'), false);
    assert.strictEqual(isKamenimeAnimePage(FILE_EP1), false);
    assert.strictEqual(isKamenimeAnimePage('https://gofile.io/d/abc'), false);
    console.log('      → slug:', a.slug, '| halaman anime=true, episode/file=false');
  });

  // ── l) listKamenimeEpisodes dari FIXTURE (tanpa network) ──
  await t('l) listKamenimeEpisodes() parse effects.html fixture → [{ep,url,title}]', async () => {
    const { listKamenimeEpisodes } = require('../providers/kamenime');
    const fx = fs.readFileSync(path.join(__dirname, 'fixtures', 'kamenime', 'effects-episodes.html'), 'utf8');
    const realFetch = globalThis.fetch;
    // 1) GET halaman anime (snap + csrf)  2) POST /livewire/update → effects.html
    const pageHtml = '<html><head><meta name="csrf-token" content="TESTTOKEN"></head><body>'
      + '<div wire:id="AAA" wire:snapshot="{&quot;memo&quot;:{&quot;name&quot;:&quot;offcanvas-navbar&quot;},&quot;data&quot;:{}}"></div>'
      + '<div wire:id="BBB" wire:snapshot="{&quot;memo&quot;:{&quot;name&quot;:&quot;show.anime-show&quot;},&quot;data&quot;:{&quot;video_open&quot;:false}}"></div>'
      + '</body></html>';
    let posted = 0;
    globalThis.fetch = async (u, opt) => {
      if (String(u).endsWith('/livewire/update')) {
        posted++;
        const body = JSON.parse(opt.body);
        // snapshot WAJIB string — kalau objek, Livewire asli membalas 500.
        assert.strictEqual(typeof body.components[0].snapshot, 'string', 'snapshot harus string');
        // WAJIB komponen show.anime-show, BUKAN komponen pertama di halaman
        // (offcanvas-navbar) — memilih yang salah = 404 / data salah.
        const memo = JSON.parse(body.components[0].snapshot).memo;
        assert.strictEqual(memo.name, 'show.anime-show', `pilih komponen salah: ${memo.name}`);
        assert.ok(body.components[0].calls.some((c) => c.method === 'toggleVideo'), 'harus panggil toggleVideo');
        return { ok: true, status: 200, text: async () => JSON.stringify({ components: [{ effects: { html: fx } }] }) };
      }
      return { ok: true, status: 200, headers: { getSetCookie: () => ['XSRF-TOKEN=X; path=/'] }, text: async () => pageHtml };
    };
    let r;
    try { r = await listKamenimeEpisodes('https://www.kamenime.com/anime/naruto-shippuden'); }
    finally { globalThis.fetch = realFetch; }
    assert.strictEqual(posted, 1, `harus 1 POST Livewire, dapat ${posted}`);
    assert.strictEqual(r.slug, 'naruto-shippuden');
    const nums = r.episodes.map((e) => e.ep);
    assert.ok(nums.includes(1) && nums.includes(13), `harus berisi ep 1 & 13, dapat ${nums.join(',')}`);
    // Anchor navigasi (EPISODE TERLAMA/TERBARU) tidak boleh jadi judul
    assert.ok(!r.episodes.some((e) => /terlama|terbaru/i.test(e.title)), 'judul navigasi bocor');
    assert.ok(r.episodes.every((e) => /^Episode \d+$/.test(e.title)), `judul harus ternormalisasi: ${r.episodes.map((e) => e.title).slice(0, 3)}`);
    assert.strictEqual(nums.length, [...new Set(nums)].length, 'tidak boleh ada ep duplikat');
    console.log(`      → ${r.episodes.length} episode dari fixture: ep ${nums.join(',')}`);
    console.log(`      → contoh: ${JSON.stringify(r.episodes[1])}`);
  });

  // ── m) listing gagal → error jujur, bukan tebakan ──
  await t('m) Livewire gagal → error "kirim URL episode manual", bukan daftar karangan', async () => {
    const { listKamenimeEpisodes } = require('../providers/kamenime');
    const realFetch = globalThis.fetch;
    const pageHtml = '<html><head><meta name="csrf-token" content="TESTTOKEN"></head><body>'
      + '<div wire:id="BBB" wire:snapshot="{&quot;memo&quot;:{&quot;name&quot;:&quot;show.anime-show&quot;},&quot;data&quot;:{}}"></div>'
      + '</body></html>';
    // Halaman anime OK, tapi POST /livewire/update yang gagal.
    globalThis.fetch = async (u) => {
      if (String(u).endsWith('/livewire/update')) return { ok: false, status: 500, text: async () => 'boom' };
      return { ok: true, status: 200, headers: { getSetCookie: () => [] }, text: async () => pageHtml };
    };
    let err = null;
    try { await listKamenimeEpisodes('https://www.kamenime.com/anime/naruto-shippuden'); }
    catch (e) { err = e; }
    globalThis.fetch = realFetch;
    assert.ok(err, 'harus melempar error');
    assert.ok(/kirim URL episode manual/.test(err.message), `pesan harus: ${err.message}`);
    assert.ok(/Livewire HTTP 500/.test(err.message), `harus sebut penyebab: ${err.message}`);
    console.log(`      → ${err.message}`);
  });

  // ── n) regression: /storage/ tetap resolve TANPA request ──
  await t('n) REGRESI: /storage/...mp4 tetap instan (tanpa request) setelah ada listing', async () => {
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = () => { called++; throw new Error('tidak boleh request untuk /storage/'); };
    let r;
    try { r = await resolveKamenimeFile(FILE_EP1); } finally { globalThis.fetch = realFetch; }
    assert.strictEqual(called, 0, `harus 0 request, dapat ${called}`);
    assert.strictEqual(r.fileUrl, FILE_EP1);
    console.log(`      → ${r.fileUrl} (0 request)`);
  });

  // ── o) picker: bot.js punya dispatcher anime-page + callback kam_ep ──
  await t('o) bot.js: dispatcher halaman anime + callback kam_ep + map', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
    assert.ok(/if \(isKamenimeAnimePage\(text\)\) \{/.test(src), 'butuh dispatcher halaman anime');
    assert.ok(/listKamenimeEpisodes\(text\.trim\(\)\)/.test(src), 'dispatcher harus memanggil listKamenimeEpisodes');
    assert.ok(/data\.startsWith\('kam_ep:'\)/.test(src), 'butuh handler kam_ep:');
    assert.ok(/kamenimeEpisodeMap\.set\(epId, e\.url\)/.test(src), 'butuh map epId → url');
    assert.ok(/callback_data: `kam_ep:\$\{epId\}`/.test(src), 'butuh callback_data kam_ep');
    // dispatcher halaman anime harus SEBELUM isKamenimeUrl (keduanya mulai 'kamenime')
    const iPage = src.indexOf('if (isKamenimeAnimePage(text)) {');
    const iFile = src.indexOf('if (isKamenimeUrl(text)) {');
    assert.ok(iPage > 0 && iFile > iPage, `anime-page (${iPage}) harus sebelum isKamenimeUrl (${iFile})`);
  });

  // ── p) kam_ep: pilih judul (bisa Ganti Judul) lalu target ──
  await t('p) kam_ep: pakai alur prompt judul (Ganti Judul), TIDAK langsung unduh', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
    const i = src.indexOf("if (data.startsWith('kam_ep:')) {");
    assert.ok(i > 0, 'butuh handler kam_ep:');
    const e = src.indexOf("if (data.startsWith('sam_ep:')) {", i);
    const block = src.slice(i, e > i ? e : undefined);
    // prompt judul → ada tombol Ganti Judul
    assert.ok(/titlePromptKeyboard\(/.test(block), 'kam_ep harus pakai titlePromptKeyboard (prompt judul)');
    assert.ok(/resolveProviderTitle\(/.test(block), 'harus resolveProviderTitle untuk judul terdeteksi');
    assert.ok(!/handleKamenimeUrl\(/.test(block), 'kam_ep TIDAK boleh langsung unduh');
    // resolveProviderTitle harus mengenal kamenime (kalau tidak, judul selalu fileName)
    const rpt = src.slice(src.indexOf('async function resolveProviderTitle'), src.indexOf('async function', src.indexOf('async function resolveProviderTitle') + 10));
    assert.ok(/isKamenimeUrl\(url\)/.test(rpt), 'resolveProviderTitle harus punya cabang kamenime');
  });

  // ── q) label provider = hokireceh, dan internal dispatch key tetap kamenime ──
  await t('q) label provider "hokireceh"; internal dispatch key tetap "kamenime"', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
    // internal dispatch (pending.handler) → harus 'kamenime' (dipakai dispatch)
    assert.ok(/handler:[^;]*isKamenimeUrl\(url\) \? 'kamenime'/.test(src),
      "pending.handler harus 'kamenime' — kalau 'hokireceh', dispatch `pending.handler === 'kamenime'` tidak akan jalan");
    // dan harus ada branche dispatch
    assert.ok(/pending\.handler === 'kamenime'/.test(src), 'butuh cabang dispatch pending.handler === kamenime');
    // label tampilan → hokireceh
    assert.ok(/const provider = [^;]*isKamenimeUrl\(url\) \? 'hokireceh'/.test(src),
      "label provider harus 'hokireceh'");
    // caption juga
    const dl = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'download.js'), 'utf8');
    const s = dl.indexOf('async function handleKamenimeUrl');
    const b = dl.slice(s, dl.indexOf('async function handleMegaUrl', s));
    assert.ok(/providerLabel = [^;]*'hokireceh'/.test(b), "caption provider harus 'hokireceh'");
  });

  // ── r) judul picker harus judul ASLI, bukan slug ──
  await t('r) listKamenimeEpisodes mengembalikan judul asli (bukan slug)', async () => {
    const { listKamenimeEpisodes, kamenimeTitleFromHtml } = require('../providers/kamenime');
    //-judul asli dari <title> — helper yang sama dipakai listing
    assert.strictEqual(kamenimeTitleFromHtml('<title>  Naruto Shippuden - Kamenime\n</title>', null), 'Naruto Shippuden');
    assert.strictEqual(kamenimeTitleFromHtml('<title>Black Torch — Kamenime</title>', null), 'Black Torch');
    assert.strictEqual(kamenimeTitleFromHtml('<title>Tanpa Judul</title>', 'fallback'), 'Tanpa Judul');
    assert.strictEqual(kamenimeTitleFromHtml('', 'fallback'), 'fallback');

    // listing harus mengembalikan title dari halaman yang sama (tanpa request tambahan)
    const fx = fs.readFileSync(path.join(__dirname, 'fixtures', 'kamenime', 'effects-episodes.html'), 'utf8');
    const pageHtml = '<html><head><meta name="csrf-token" content="T"></head><body>'
      + '<div wire:id="BBB" wire:snapshot="{&quot;memo&quot;:{&quot;name&quot;:&quot;show.anime-show&quot;},&quot;data&quot;:{}}"></div>'
      + '</body></html>';
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u) => String(u).endsWith('/livewire/update')
      ? { ok: true, status: 200, text: async () => JSON.stringify({ components: [{ effects: { html: fx } }] }) }
      : { ok: true, status: 200, headers: { getSetCookie: () => [] }, text: async () => pageHtml };
    let r;
    try { r = await listKamenimeEpisodes('https://www.kamenime.com/anime/naruto-shippuden'); }
    finally { globalThis.fetch = realFetch; }
    // tanpa <title> di fixture → judul jatuh ke slug (harus tetap ada, bukan undefined)
    assert.ok(r.title, 'title harus selalu ada');
    assert.ok(typeof r.title === 'string' && r.title.length > 0, `title tidak boleh kosong: ${r.title}`);
    console.log(`      → judul dari <title>: "Naruto Shippuden" | fallback: "${r.title}"`);
  });

  // ── s) picker TIDAK boleh pakai slug sebagai judul ──
  await t('s) picker pakai title asli, bukan slug (kunci library harus cocok)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
    const s = src.indexOf('async function buildKamenimeEpisodePicker');
    const e = src.indexOf('async function buildSamehadakuEpisodePicker', s);
    const body = src.slice(s, e > s ? e : undefined);
    assert.ok(/titleOverride/.test(body), 'builder harus menerima title dari listing');
    assert.ok(/const title = titleOverride \|\| slug;/.test(body),
      'judul harus pakai titleOverride (judul asli) sebelum jatuh ke slug');
    // dispatcher harus meneruskan title dari listKamenimeEpisodes
    assert.ok(/listKamenimeEpisodes\(text\.trim\(\)\);/.test(src), 'dispatcher harus memanggil listing');
    assert.ok(/title: animeTitle/.test(src), 'dispatcher harus meneruskan title ke builder');
    console.log('      → picker memakai judul asli; slug hanya fallback');
  });


  // ── t) REGRESI: logCtx harus terdefinisi (bug: "logCtx is not defined") ──
  await t('t) handleKamenimeUrl: logCtx dideklarasikan, bukan IdentifierError', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'download.js'), 'utf8');
    const s = src.indexOf('async function handleKamenimeUrl');
    const e = src.indexOf('async function handleMegaUrl', s);
    const body = src.slice(s, e > s ? e : undefined);
    // WAJIB ada deklarasi logCtx di dalam handleKamenimeUrl
    assert.ok(/const logCtx = \{/.test(body),
      'handleKamenimeUrl harus mendeklarasikan logCtx — tanpa itu ReferenceError di setiap remux');
    // dan tidak boleh ada logger yang memakai logCtx tanpa deklarasi lokal
    const uses = (body.match(/\.\.\.logCtx/g) || []).length;
    const decl = (body.match(/const logCtx = \{/g) || []).length;
    assert.ok(decl >= 1, 'deklarasi logCtx wajib ada');
    assert.ok(uses > 0, 'logCtx harus benar-benar dipakai (bukan sisa kode mati)');
    // logger.debug tanpa ?. — logger.debug?.()看不見 redirect
    assert.ok(/logger\.debug\(\{/.test(body), 'pakai logger.debug({ ... }) langsung, bukan optional chaining');
    console.log(`      → deklarasi logCtx: ${decl}, pemakaian: ${uses}`);
  });

  // ── u) Ganti Judul harus MASIH bisa pilih target ──
  await t('u) setelah "Ganti Judul" kamenime tetap menanyakan target', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
    // cabang custom-title untuk kamenime TIDAK boleh langsung unduh
    const i = src.indexOf("if (pending.handler === 'kamenime') {");
    assert.ok(i > 0, 'butuh cabang kamenime di jalur custom title');
    const e = src.indexOf("if (pending.handler === 'mega')", i);
    const block = src.slice(i, e > i ? e : undefined);
    assert.ok(!/return handleKamenimeUrl\(/.test(block),
      'custom title TIDAK boleh langsung unduh — harus tampilkan pilihan target');
    assert.ok(/animeTargetKeyboard\(/.test(block), 'harus menanyakan target');
    assert.ok(/customTitleMap\.set\(/.test(block), 'harus menyimpan judul kustom untuk dl_go');
    for (const t of ['dl_go:tg:', 'dl_go:vyt:', 'dl_go:vv:']) {
      assert.ok(block.includes(t), `butuh tombol ${t}`);
    }
    // dl_go harus membaca judul kustom
    assert.ok(/customTitleMap\.get\(url\)/.test(src), 'dl_go harus membaca customTitleMap');
    assert.ok(/titleForCap = customTitle \|\| detectedTitle/.test(src),
      'judul kustom harus diprioritaskan atas judul terdeteksi');
    assert.ok(/isKamenimeUrl\(url\)\) return handleKamenimeUrl\(chatId, url, titleForCap\)/.test(src),
      'dl_go tg harus meneruskan titleForCap ke handleKamenimeUrl');
  });

  console.log(`\n${passed} pass / ${failed} fail`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
