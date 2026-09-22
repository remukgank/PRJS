'use strict';
// Unit test: server-pick batch "Download Semua" + status-return downloadSamehadakuFile.
const assert = require('assert');
const dl = require('../handlers/download');

(async () => {
  let failed = 0;
  const t = (name, fn) => {
    try {
      fn();
      console.log(`PASS  ${name}`);
    } catch (e) {
      failed++;
      console.error(`FAIL  ${name}: ${e.message}`);
    }
  };

  t('pickBestServer: prioritas gofile > filedon > pixeldrain > gdriveplayer', () => {
    assert.strictEqual(dl.pickBestServer({ gofile: 'x', filedon: 'y' }), 'gofile');
    assert.strictEqual(dl.pickBestServer({ filedon: 'y', pixeldrain: 'z' }), 'filedon');
    assert.strictEqual(dl.pickBestServer({ pixeldrain: 'z' }), 'pixeldrain');
    assert.strictEqual(dl.pickBestServer({ gdriveplayer: 'g' }), 'gdriveplayer');
  });

  t('pickBestServer: server di luar prioritas diabaikan', () => {
    assert.strictEqual(dl.pickBestServer({ krakenfiles: 'k' }), null);
  });

  t('pickBestServer: object kosong / undefined', () => {
    assert.strictEqual(dl.pickBestServer({}), null);
    assert.strictEqual(dl.pickBestServer(), null);
  });

  t('pickBestServerList: urutan fallback sesuai SERVER_PRIORITY', () => {
    assert.deepStrictEqual(dl.pickBestServerList({ gofile: 'g', filedon: 'f', pixeldrain: 'p', gdriveplayer: 'd' }), ['gofile', 'filedon', 'pixeldrain', 'gdriveplayer']);
  });

  t('pickBestServerList: server yang tidak tersedia dilewati (fallback)', () => {
    assert.deepStrictEqual(dl.pickBestServerList({ filedon: 'f', gdriveplayer: 'd' }), ['filedon', 'gdriveplayer']);
    assert.deepStrictEqual(dl.pickBestServerList({ gdriveplayer: 'd' }), ['gdriveplayer']);
    assert.deepStrictEqual(dl.pickBestServerList({ krakenfiles: 'k' }), []);
  });

  t('pickBestServerList: kosong / undefined', () => {
    assert.deepStrictEqual(dl.pickBestServerList({}), []);
    assert.deepStrictEqual(dl.pickBestServerList(), []);
  });

  t('pickBestServer konsisten dgn pickBestServerList[0]', () => {
    const servers = { filedon: 'f', gofile: 'g', pixeldrain: 'p' };
    assert.strictEqual(dl.pickBestServer(servers), dl.pickBestServerList(servers)[0]);
  });

  t('partMismatch: file salah nomor ditolak', () => {
    assert.strictEqual(dl.partMismatch(69, 70), 'file server keliru: Ep 70 (link Ep 69)');
    assert.strictEqual(dl.partMismatch('69', '70'), 'file server keliru: Ep 70 (link Ep 69)');
  });

  t('partMismatch: cocok / tak tahu = null', () => {
    assert.strictEqual(dl.partMismatch(69, 69), null);
    assert.strictEqual(dl.partMismatch(69, 0), null);
    assert.strictEqual(dl.partMismatch(69, NaN), null);
    assert.strictEqual(dl.partMismatch(null, 70), null);
    assert.strictEqual(dl.partMismatch(undefined, undefined), null);
  });

  t('SAM_BATCH_PACE_MS default = 1000', () => {
    assert.strictEqual(dl.SAM_BATCH_PACE_MS, 1000);
  });

  try {
    const res = await dl.downloadSamehadakuFile(1, 'https://x/ep', 'gofile', {}, null)
      .catch((e) => ({ ok: false, error: 'THREW:' + e.message }));
    assert.ok(res.ok === false);
    assert.ok(String(res.error).length > 0);
    console.log('PASS  downloadSamehadakuFile server-kosong -> { ok:false } tanpa crash');
  } catch (e) {
    failed++;
    console.error(`FAIL  downloadSamehadakuFile: ${e.message}`);
  }

  // init ctx mock utk cek silent mode (batch) vs pesan detail Ep (single)
  const sent = [];
  dl.initDownload({
    bot: { sendMessage: async (_c, text, opts) => { sent.push({ text, opts }); return { message_id: 1 }; } },
    config: {},
    samehadakuEpisodeMap: new Map(),
  });

  try {
    sent.length = 0;
    await dl.downloadSamehadakuFile(1, 'https://x/ep', 'acefile', { acefile: 'url' }, { title: 'T', episode: 12, season: null, part: null });
    const msg = sent.find((s) => s.text.includes('belum didukung'));
    assert.ok(msg, 'harus ada pesan belum-didukung');
    assert.ok(msg.text.includes('Ep 12'), `pesan harus menyebut Ep 12, dapat: ${msg?.text}`);
    console.log('PASS  non-silent: pesan gagal menyebut nomor episode (Ep 12)');
  } catch (e) {
    failed++;
    console.error(`FAIL  non-silent detail Ep: ${e.message}`);
  }

  try {
    sent.length = 0;
    const res = await dl.downloadSamehadakuFile(1, 'https://x/ep', 'acefile', { acefile: 'url' }, { title: 'T', episode: 12, season: null, part: null }, { silent: true });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(sent.length, 0, 'silent=true tidak boleh mengirim pesan');
    console.log('PASS  silent=true (batch): tidak ada pesan ke chat');
  } catch (e) {
    failed++;
    console.error(`FAIL  silent mode: ${e.message}`);
  }

  // leafAlert: api ⚠️ dari leaf handler (pixeldrain/filedon) harus ikut diam saat quiet=batch
  try {
    sent.length = 0;
    await dl.leafAlertTest.alert(1, '⚠️ Pixeldrain gagal: test');
    assert.strictEqual(sent.length, 1, 'default (loud): pesan harus terkirim');
    dl.leafAlertTest.setQuiet(true);
    await dl.leafAlertTest.alert(1, '⚠️ Pixeldrain gagal: test bisu');
    assert.strictEqual(sent.length, 1, 'quiet=batch: pesan leaf alert tidak boleh terkirim');
    dl.leafAlertTest.setQuiet(false);
    await dl.leafAlertTest.alert(1, '⚠️ Filedon gagal: test lagi');
    assert.strictEqual(sent.length, 2, 'setelah quiet=false normal lagi');
    console.log('PASS  leafAlert mengikuti mode quiet (batch senyap, manual lantang)');
  } catch (e) {
    failed++;
    console.error(`FAIL  leafAlert quiet: ${e.message}`);
  }

  console.log(process.exitCode = failed, '\n');
  console.log(process.exitCode ? 'ADA YANG GAGAL' : 'Semua test OK');
  process.exit(failed ? 1 : 0);
})();