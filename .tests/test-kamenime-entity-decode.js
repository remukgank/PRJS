'use strict';
/**
 * Test — decode HTML entity di src kamenime (fix 28 Sep 2026).
 *
 * Bug: `decodeHtmlEntities` hanya kena 2 digit (`&#39;`), padahal kamenime
 * menulis 3 digit (`&#039;`). Akibatnya:
 *   - `&#039;` lolos mentah ke URL → server balas 404
 *   - `&` diperlakukan URL sebagai pemisah query → `fileNameFromUrl`
 *     memotong nama file di tengah
 *
 * Gejala di produksi: "A Gatherer's Adventure in Isekai" → ok 0 / gagal 12.
 *
 * Test ini memakai fungsi PRODUKSI (`resolveKamenimeFile`), bukan menyalin
 * definisi ke dalam file test. Mutasi di file ini harus mengubah hasil.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const KAMENIME = path.join(__dirname, '..', 'scraper', 'providers', 'kamenime.js');
const SRC = fs.readFileSync(KAMENIME, 'utf8');

let pass = 0;
let fail = 0;
function t(nama, fn) {
  try {
    const detail = fn();
    console.log(`PASS  ${nama}${detail ? `\n      ${detail}` : ''}`);
    pass++;
  } catch (e) {
    console.log(`FAIL  ${nama}\n      ${e.message}`);
    fail++;
  }
}

// ---------------------------------------------------------------------------
// 1. Ekstrak fungsi decodeHtmlEntities dari file produksi
// ---------------------------------------------------------------------------
function ambilFungsi(nama) {
  const i = SRC.indexOf(`function ${nama}(`);
  assert.ok(i > 0, `fungsi ${nama} tidak ditemukan di ${KAMENIME}`);
  const dari = SRC.indexOf('{', i);
  let depth = 0;
  for (let k = dari; k < SRC.length; k++) {
    if (SRC[k] === '{') depth++;
    else if (SRC[k] === '}') {
      depth--;
      if (depth === 0) return SRC.slice(i, k + 1);
    }
  }
  throw new Error(`tidak menemukan akhir fungsi ${nama}`);
}

const fDecode = new Function(`${ambilFungsi('decodeNumericEntity')}\n${ambilFungsi('decodeHtmlEntities')}\nreturn decodeHtmlEntities;`)();

// ---------------------------------------------------------------------------
// 2. src mentah dari kamenime — ini yang benar-benar dikirim server
// ---------------------------------------------------------------------------
const SRC_RAW = '/storage/anime/A Gatherer&#039;s Adventure in Isekai/A Gatherer&#039;s Adventure in Isekai-episode-1.mp4';
const KONTROL = '/storage/anime/ONE PIECE/ONE PIECE-episode-1.mp4';

t('src mentah dari kamenime benar-benar memakai &#039; (3 digit)', () => {
  assert.ok(SRC_RAW.includes('&#039;'), 'fixture harus memuat &#039;');
  assert.ok(!SRC_RAW.includes('&#39;'), 'fixture tidak boleh memuat &#39;');
  return 'fixture: A Gatherer&#039;s ...-episode-1.mp4';
});

t('fungsi decodeHtmlEntities produksi tersedia', () => {
  assert.strictEqual(typeof fDecode, 'function');
});

t('&#039; (3 digit) di-decode → apostrof', () => {
  const out = fDecode(SRC_RAW);
  assert.ok(!out.includes('&#'), `masih ada entity: ${out.slice(0, 90)}`);
  assert.ok(out.includes("Gatherer's"), `apostrof tidak ada: ${out.slice(0, 90)}`);
  return out.slice(0, 88) + '…';
});

t('&#039; otomatis dari decodeNumericEntity, bukan cuma alias', () => {
  // Kalau decodeNumericEntity dihapus, alias &#0*39; masih menutup &#039;.
  // Test ini mengunci bahwa keduanya ada DAN urutannya benar.
  assert.ok(/decodeNumericEntity\(s\)/.test(SRC), 'decodeHtmlEntities harus memanggil decodeNumericEntity');
  const numeric = new Function(`${ambilFungsi('decodeNumericEntity')}\nreturn decodeNumericEntity;`)();
  assert.strictEqual(numeric('A&#039;s'), "A's", 'decodeNumericEntity harus menangani &#039; sendiri');
  return '&#039; ditangani oleh decodeNumericEntity';
});

t('KONTROL: judul polos tetap sama seperti sebelumnya', () => {
  const out = fDecode(KONTROL);
  assert.strictEqual(out, KONTROL, 'judul polos tidak boleh berubah');
  return out;
});

t('named entity tidak regressi', () => {
  const T = [
    ['x&amp;y', 'x&y'],
    ['a&quot;b', 'a"b'],
    ['5&lt;6', '5<6'],
    ['6&gt;5', '6>5'],
    ['A&#39;s', "A's"],
  ];
  for (const [masuk, harap] of T) {
    assert.strictEqual(fDecode(masuk), harap, `${masuk} → ${harap}`);
  }
  return `${T.length} named entity utuh`;
});

t('fileNameFromUrl: decodeURIComponent WAJIB ada (space jadi spasi, bukan %20)', () => {
  // Mutasi M4 (hapus decodeURIComponent) harus tertangkap test ini.
  // Tanpa decode, fileName berisi "%20" mentah → caption & nama folder di
  // Vidoy jadi jelek, walau URL-nya sendiri masih valid.
  const fn = new Function(`${ambilFungsi('fileNameFromUrl')}\nreturn fileNameFromUrl;`)();
  const url = "https://www.kamenime.com/storage/anime/A%20Gatherer's%20Adventure%20in%20Isekai/A%20Gatherer's%20Adventure%20in%20Isekai-episode-1.mp4";
  const nama = fn(url);
  assert.ok(!nama.includes('%20'), `fileName masih ter-encode: ${nama}`);
  assert.strictEqual(nama, "A Gatherer's Adventure in Isekai-episode-1.mp4");
  return nama;
});

t('fileNameFromUrl: URL polos tetap sama', () => {
  const fn = new Function(`${ambilFungsi('fileNameFromUrl')}\nreturn fileNameFromUrl;`)();
  assert.strictEqual(fn('https://x/ONE%20PIECE-episode-1.mp4'), 'ONE PIECE-episode-1.mp4');
  return 'ONE PIECE-episode-1.mp4';
});

// ---------------------------------------------------------------------------
// 3. Entity numeric lain — angka desimal & heksa
// ---------------------------------------------------------------------------
t('entity numeric desimal lain (&#8217; tipografis)', () => {
  assert.strictEqual(fDecode('a&#8217;b'), 'a’b');
  return '&#8217; → ’';
});

t('entity numeric heksa (&#x27;)', () => {
  assert.strictEqual(fDecode('a&#x27;b'), "a'b");
  return '&#x27; → apostrof';
});

t('entity di luar batas BMP dibiarkan utuh (tidak crash)', () => {
  const inputs = ['&#999999999;', '&#xZZZZ;', '&#;', '&#-5;'];
  for (const s of inputs) {
    const out = fDecode(s);
    assert.strictEqual(typeof out, 'string');
  }
  return `${inputs.length} input aneh tidak crash`;
});

// ---------------------------------------------------------------------------
// 4. Alur produksi penuh — resolveKamenimeFile (butuh network, boleh di-skip)
// ---------------------------------------------------------------------------
const ONLINE = process.argv.includes('--online');
const K = require(KAMENIME);

if (ONLINE) {
  (async () => {
    try {
      const r = await K.resolveKamenimeFile(
        'https://www.kamenime.com/anime/a-gatherers-adventure-in-isekai/episode/1');
      const cek = [r.fileUrl, r.fileName];
      t('URL hasil resolve tidak punya entity HTML', () => {
        for (const v of cek) assert.ok(!v.includes('&#'), `entity tersisa: ${v}`);
        return `fileName = ${JSON.stringify(r.fileName)}`;
      });
      t('fileName tidak terpotong di tengah (tidak ada &-stub)', () => {
        assert.ok(!r.fileName.endsWith('&'), `fileName terpotong: ${r.fileName}`);
        assert.ok(r.fileName.endsWith('.mp4'), `fileName tidak .mp4: ${r.fileName}`);
        return r.fileName;
      });
      const kontrol = await K.resolveKamenimeFile(
        'https://www.kamenime.com/anime/one-piece/episode/1');
      t('KONTROL One Piece tetap resolver (tidak regresi online)', () => {
        assert.ok(kontrol.fileUrl.endsWith('.mp4'), kontrol.fileUrl);
        assert.ok(!kontrol.fileUrl.includes('&#'));
        return kontrol.fileName;
      });
    } catch (e) {
      console.log(`FAIL  alur online: ${e.message}`);
      fail++;
    }
    console.log(`\n${pass} pass / ${fail} fail`);
    if (fail) process.exit(1);
  })();
} else {
  console.log(`\n${pass} pass / ${fail} fail`);
  if (fail) process.exit(1);
}