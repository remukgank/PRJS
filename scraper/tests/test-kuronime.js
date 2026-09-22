'use strict';

// Unit test: provider kuronime (parse, pick quality terbaik, AES mirror).
// Live test (list + resolve) hanya jalan dgn KURONIME_LIVE=1 (butuh internet).

const assert = require('assert');
const crypto = require('crypto');
const {
  isKuronimeUrl, parseKuronimeEpisode, parseKuronimeAnime,
  decryptKuronimeMirror, pickKuronimeBest,
  KURONIME_PASSPHRASE, KURONIME_SERVER_PRIORITY,
} = require('../providers/kuronime');

let failed = 0;
const t = (name, fn) => {
  try { const r = fn(); if (r?.then) return r.then(() => console.log(`PASS  ${name}`)).catch((e) => { failed++; console.error(`FAIL  ${name}: ${e.message}`); }); console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
};

t('isKuronimeUrl', () => {
  assert.strictEqual(isKuronimeUrl('https://kuronime.sbs/anime/dragon-ball-heroes/'), true);
  assert.strictEqual(isKuronimeUrl('https://kuronime.sbs/nonton-dragon-ball-heroes-episode-46/'), true);
  assert.strictEqual(isKuronimeUrl('https://v2.samehadaku.how/anime/x/'), false);
  assert.strictEqual(isKuronimeUrl('bukan url'), false);
});

t('parseKuronimeEpisode', () => {
  const r = parseKuronimeEpisode('https://kuronime.sbs/nonton-dragon-ball-heroes-episode-46/');
  assert.deepStrictEqual(r, { title: 'Dragon Ball Heroes', episode: 46, provider: 'kuronime', slug: 'dragon-ball-heroes' });
  assert.strictEqual(parseKuronimeEpisode('https://kuronime.sbs/anime/dragon-ball-heroes/'), null);
});

t('parseKuronimeAnime', () => {
  const r = parseKuronimeAnime('https://kuronime.sbs/anime/dragon-ball-heroes/');
  assert.deepStrictEqual(r, { title: 'Dragon Ball Heroes', provider: 'kuronime', slug: 'dragon-ball-heroes' });
  assert.strictEqual(parseKuronimeAnime('https://kuronime.sbs/nonton-x-episode-1/'), null);
});

// Round-trip: enkripsi format CryptoJSAesJson dgn node:crypto → dekripsi via modul.
t('decryptKuronimeMirror round-trip', () => {
  const plain = JSON.stringify({ download: { v720p: { gofile: 'https://gofile.io/d/abc' } } });
  const salt = crypto.randomBytes(8);
  const iv = crypto.randomBytes(16);
  let dx = Buffer.alloc(0), keyiv = Buffer.alloc(0);
  while (keyiv.length < 48) {
    dx = crypto.createHash('md5').update(Buffer.concat([dx, Buffer.from(KURONIME_PASSPHRASE, 'utf8'), salt])).digest();
    keyiv = Buffer.concat([keyiv, dx]);
  }
  const c = crypto.createCipheriv('aes-256-cbc', keyiv.subarray(0, 32), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const b64 = Buffer.from(JSON.stringify({ ct: ct.toString('base64'), iv: iv.toString('hex'), s: salt.toString('hex') })).toString('base64');
  assert.deepStrictEqual(decryptKuronimeMirror(b64), JSON.parse(plain));
});

t('decrypt gagal memberi error jelas', () => {
  assert.throws(() => decryptKuronimeMirror('!!!bukan-base64!!!'), /Kuronime decrypt gagal/);
});

t('pickKuronimeBest: quality terbaik + gofile dulu', () => {
  const q = {
    v1080p: { krakenfiles: 'k', gofile: 'g1080', pixeldrain: 'p1080' },
    v720p: { gofile: 'g720' },
  };
  assert.deepStrictEqual(pickKuronimeBest(q), { quality: 'v1080p', server: 'gofile', url: 'g1080' });
  assert.deepStrictEqual(pickKuronimeBest({ v720p: { pixeldrain: 'p' } }), { quality: 'v720p', server: 'pixeldrain', url: 'p' });
  assert.strictEqual(pickKuronimeBest({ v720p: { krakenfiles: 'k' } }), null);
  assert.strictEqual(pickKuronimeBest({}), null);
  assert.deepStrictEqual(KURONIME_SERVER_PRIORITY, ['gofile', 'pixeldrain']);
});

(async () => {
  if (process.env.KURONIME_LIVE === '1') {
    const { listKuronimeEpisodes, resolveKuronimeMirrors } = require('../providers/kuronime');
    await t('LIVE list episode db heroes', async () => {
      const eps = await listKuronimeEpisodes('https://kuronime.sbs/anime/dragon-ball-heroes/');
      assert.ok(eps.length >= 10, `dapat ${eps.length} ep`);
      assert.ok(eps.every((e) => e.ep > 0 && e.url.includes('episode-')));
    });
    await t('LIVE resolve ep46 best = v1080p gofile/pixeldrain', async () => {
      const { qualities } = await resolveKuronimeMirrors('https://kuronime.sbs/nonton-dragon-ball-heroes-episode-46/');
      const best = pickKuronimeBest(qualities);
      assert.strictEqual(best.quality, 'v1080p');
      assert.ok(['gofile', 'pixeldrain'].includes(best.server));
      assert.ok(/^https?:\/\//.test(best.url));
    });
  } else {
    console.log('SKIP live test (set KURONIME_LIVE=1)');
  }
  console.log(process.exitCode = failed, '\n');
  console.log(process.exitCode ? 'ADA YANG GAGAL' : 'Semua test OK');
  process.exit(failed ? 1 : 0);
})();
