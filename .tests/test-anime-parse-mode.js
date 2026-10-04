/**
 * test-anime-parse-mode.js — bug: `<b>` bocor di caption jalur Telegram-saja.
 *
 * Akar: buildAnimeSender() meneruskan opts apa adanya. Pemanggil di
 * handlers/download.js (10 call site) tidak mengirim parse_mode, jadi tag HTML
 * di caption (dibangun buildCaption) tampil MENTAH di Telegram. Jalur Vidoy
 * aman karena vidoy.js menyertakan parse_mode eksplisit.
 *
 * Fix: parse_mode default 'HTML' diset SEKALI di router (lib/animeTopic.js).
 *
 * Test ini memanggil FUNGSI ASLI dengan sender tiruan (tidak mock logika),
 * jadi benar-benar menguji apa yang sampai ke Telegram.
 *
 * Jalankan: node .tests/test-anime-parse-mode.js
 */

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'scraper');
const { buildAnimeSender } = require(path.join(ROOT, 'lib', 'animeTopic'));

let pass = 0;
let fail = 0;

function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    fail++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

// Sender tiruan: catat payload apa yang AKAN dikirim ke Telegram.
function makeSender(ext = 'mp4') {
  const captured = [];
  const grab = (kind) => async (chatId, filePath, opts = {}) => {
    captured.push({ kind, chatId, filePath, opts });
    return { kind, message_id: 1, video: { file_id: 'FID' } };
  };
  return {
    captured,
    senders: { sendVideo: grab('video'), sendAudio: grab('audio'), sendDocument: grab('doc') },
  };
}

const CAPTION_HTML = '➧ Judul :- <b>Dragon Ball Heroes</b>\n➧ Episode :- 12\n➧ Provider :- samehadaku';

(async () => {
  console.log('\n== test-anime-parse-mode ==\n');

  // ── 1._video: parse_mode HARUS terkirim walau pemanggil tidak Providing ──
  {
    const { captured, senders } = makeSender();
    const send = buildAnimeSender(senders, async () => 655);
    await send(-100123, '/tmp/x.mp4', { caption: CAPTION_HTML, supports_streaming: true });
    const got = captured[0];
    assert.ok(got, 'tidak ada payload');
    t('video: parse_mode terkirim tanpa pemanggil menyediakannya', () => {
      assert.strictEqual(got.opts.parse_mode, 'HTML');
    });
    t('video: caption tidak berubah (tag tetap utuh utk di-parse Telegram)', () => {
      assert.strictEqual(got.opts.caption, CAPTION_HTML);
    });
    t('video: supports_streaming tetap true', () => {
      assert.strictEqual(got.opts.supports_streaming, true);
    });
    t('video: message_thread_id tetap diteruskan', () => {
      assert.strictEqual(got.opts.message_thread_id, 655);
    });
  }

  // ── 2. parse_mode eksplisit pemanggil TIDAK ditimpa ──
  {
    const { captured, senders } = makeSender();
    const send = buildAnimeSender(senders, async () => 655);
    await send(-100123, '/tmp/x.mp4', { caption: 'x', parse_mode: 'MarkdownV2' });
    t('parse_mode eksplisit pemanggil tidak ditimpa', () => {
      assert.strictEqual(captured[0].opts.parse_mode, 'MarkdownV2');
    });
  }

  // ── 3. tanpa topic (resolveThread null) tetap dapat parse_mode ──
  {
    const { captured, senders } = makeSender();
    const send = buildAnimeSender(senders, async () => null);
    await send(-100123, '/tmp/x.mp4', { caption: CAPTION_HTML });
    t('fallback ke chat asal: parse_mode tetap ada', () => {
      assert.strictEqual(captured[0].opts.parse_mode, 'HTML');
      assert.strictEqual(captured[0].opts.message_thread_id, undefined);
    });
  }

  // ── 4. resolveThread melempar → fallback, parse_mode tetap ──
  {
    const { captured, senders } = makeSender();
    const send = buildAnimeSender(senders, async () => { throw new Error('boom'); });
    await send(-100123, '/tmp/x.mp4', { caption: CAPTION_HTML });
    t('resolveThread error: fallback tetap parse_mode HTML', () => {
      assert.strictEqual(captured[0].opts.parse_mode, 'HTML');
    });
  }

  // ── 5. audio & document juga dapat parse_mode (bug yang sama di branch itu) ──
  {
    const { captured, senders } = makeSender();
    const send = buildAnimeSender(senders, async () => 655);
    await send(-100123, '/tmp/x.mp3', { caption: CAPTION_HTML });
    await send(-100123, '/tmp/x.pdf', { caption: CAPTION_HTML });
    t('audio: parse_mode HTML', () => {
      assert.strictEqual(captured[0].opts.parse_mode, 'HTML');
    });
    t('document: parse_mode HTML', () => {
      assert.strictEqual(captured[1].opts.parse_mode, 'HTML');
    });
  }

  // ── 6. caption tanpa HTML (teks polos) tidak dirusak ──
  {
    const { captured, senders } = makeSender();
    const send = buildAnimeSender(senders, async () => 655);
    await send(-100123, '/tmp/x.mp4', { caption: 'file biasa' });
    t('caption polos tetap utuh', () => {
      assert.strictEqual(captured[0].opts.caption, 'file biasa');
    });
  }

  // ── 7. regression: ketiga branch send wajib menyertakan parse_mode ──
  // Audio & document TIDAK memakai spread `withThread` (hanya butuh caption +
  // thread), jadi keduanya harus menyebut parse_mode secara eksplisit.
  {
    const src = require('fs').readFileSync(path.join(ROOT, 'lib', 'animeTopic.js'), 'utf8');
    const branches = ['sendAudio', 'sendVideo', 'sendDocument']
      .map((fn) => {
        const i = src.indexOf(`${fn}(chatId, filePath, {`);
        return i < 0 ? { fn, body: '' } : { fn, body: src.slice(i, src.indexOf('}, cacheInfo)', i)) };
      });
    t('ketiga branch send punya baris-call yang bisa diperiksa', () => {
      for (const b of branches) assert.ok(b.body, `branch ${b.fn} tidak ditemukan`);
    });
    t('sendVideo memakai spread withThread (ikut parse_mode)', () => {
      assert.ok(/\.\.\.withThread/.test(branches.find((b) => b.fn === 'sendVideo').body));
    });
    t('sendAudio & sendDocument menyebut parse_mode eksplisit', () => {
      for (const fn of ['sendAudio', 'sendDocument']) {
        const body = branches.find((b) => b.fn === fn).body;
        assert.ok(/parse_mode/.test(body), `${fn} tidak mengirim parse_mode`);
        assert.ok(/caption: withThread\.caption/.test(body), `${fn} caption tidak dari withThread`);
      }
    });
  }

  // ── 8. hanya satu deklarasi base; tidak ada sisa pakai yang salah ──
  {
    const src = require('fs').readFileSync(path.join(ROOT, 'lib', 'animeTopic.js'), 'utf8');
    t('satu deklarasi `const base` yang menyertakan parse_mode', () => {
      assert.strictEqual((src.match(/const base =/g) || []).length, 1);
      assert.ok(/const base = \{ \.\.\.opts, parse_mode: opts\.parse_mode \|\| 'HTML' \}/.test(src),
        'deklarasi base harus menyetel parse_mode');
    });
    t('tidak ada payload send yang memakai `base` mentah (harus withThread)', () => {
      const lines = src.split('\n');
      for (const l of lines) {
        if (/await send(Video|Audio|Document)\(/.test(l)) {
          assert.ok(!/\bbase\b/.test(l) || /withThread/.test(l),
            `branch mengirim base mentah: ${l.trim()}`);
        }
      }
    });
  }

  console.log(`\n== ${pass} pass, ${fail} fail ==\n`);
  process.exit(fail ? 1 : 0);
})();