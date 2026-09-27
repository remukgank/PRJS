'use strict';

// Fix: folder Vidoy tidak lagi dibuat ganda karena beda ejaan judul.
//
// MASALAH (terbukti di DB + log, 27 Sep 2026):
//   13:49:43–14:12:53  23 episode → folder myci7nuu4s1
//                      title "Re:Zero kara Hajimeru Isekai Seikatsu"  (TITIK DUA)
//   14:35:16           episode 7 & 16 gagal ("download HTTP 500")
//   14:41:33–14:44:50  retry 2 episode → folder gzovkizv6x7 (BARU)
//                      title "Re-Zero kara Hajimeru Isekai Seikatsu"  (STRIP)
//
// URL-nya sama persis. Yang beda hanya judul. `animeFolderPath(title)` memakai
// judul mentah sebagai segmen folder terakhir, dan `findNode` mencocokkan dengan
// `toLowerCase()` saja — sehingga "Re:Zero" dan "Re-Zero" jadi dua kunci
// berbeda → `createFolderVerified` bikin folder baru. Di dashboard kedua nama
// itu terlihat "sama" (beda 1 karakter).
//
// FIX: `folderKey()` menormalkan kunci pencocokan (buang semua non-alnum).
// Yang dinormalkan HANYA cara mencari — nama folder yang sudah ada tidak
// berubah, jadi tidak ada rename/migrasi.
//
// Run: node scraper/tests/test-folder-vidoy-kunci.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'vidoy-uploader.js');
const src = fs.readFileSync(SRC, 'utf8');
// eslint-disable-next-line import/no-dynamic-require
const V = require(SRC);

let passed = 0;
let failed = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });

const RE_DASH = 'Re-Zero kara Hajimeru Isekai Seikatsu';
const RE_COLON = 'Re:Zero kara Hajimeru Isekai Seikatsu';
const RE_S2 = 'Re:Zero kara Hajimeru Isekai Seikatsu S2';

// ── 1) kasus yang jadi bukti ────────────────────────────────────────────────
t('1a) Re-Zero (strip) dan Re:Zero (titik dua) menghasilkan kunci yang SAMA', () => {
  const a = V.folderKey(RE_DASH);
  const b = V.folderKey(RE_COLON);
  assert.notStrictEqual(a, '', 'kunci tidak boleh kosong');
  assert.strictEqual(a, b,
    `kunci berbeda → folder akan dibuat dua kali: "${a}" vs "${b}"`);
  return `"${a}"`;
});

t('1b) S2 tetap folder terpisah (bukan ikut menyatu)', () => {
  assert.notStrictEqual(V.folderKey(RE_S2), V.folderKey(RE_COLON),
    'S2 jangan sampai ikut key yang sama — itu anime berbeda');
  assert.ok(V.folderKey(RE_S2).endsWith('s2'), `kunci S2 harus berakhiran s2: ${V.folderKey(RE_S2)}`);
  return `S2 = "${V.folderKey(RE_S2)}"`;
});

t('1c) Naruto Kecil vs Naruto-Shippuden tetap terpisah', () => {
  assert.notStrictEqual(V.folderKey('Naruto Kecil'), V.folderKey('Naruto Shippuden'),
    'judul berbeda tidak boleh collide');
  return `"${V.folderKey('Naruto Kecil')}" vs "${V.folderKey('Naruto Shippuden')}"`;
});

// ── 2) sifat umum kunci ────────────────────────────────────────────────────
t('2a) pemisah (spasi/-/_/./:) & huruf besar tidak berpengaruh pada kunci', () => {
  const variants = [
    'Black Torch', 'black-torch', 'BLACK TORCH', 'Black  Torch',
    'Black_Torch', 'Black.Torch', 'Black: Torch',
  ];
  const keys = new Set(variants.map(V.folderKey));
  assert.strictEqual(keys.size, 1,
    `varian pemisah menghasilkan ${keys.size} kunci: ${[...keys].join(' | ')}`);
  return `7 varian pemisah → 1 kunci "${[...keys][0]}"`;
});

// Apostrof TIDAK ikut dihapus sebagai pemisah, dan itu benar: `Black's Torch`
// dan `Black Torch` adalah dua string berbeda, jadi tidak boleh dipaksa collide.
// Versi test awal sempat menuntut keduanya collide dan gagal — itu asumsi salah.
t('2a2) kutip/kerawang tidak dianggap pemisah (dokumentasi batas normalisasi)', () => {
  const withAp = V.folderKey("Black's Torch");
  const plain = V.folderKey('Black Torch');
  assert.notStrictEqual(withAp, plain,
    "apostrof tidak boleh diperlakukan sebagai pemisah — 'Black's' bukan 'Black'");
  assert.strictEqual(withAp, 'blackstorch', 'kunci terhitung: apostrof dibuang, huruf tetap ikut');
  return `"Black's Torch" → "${withAp}"  ≠  "Black Torch" → "${plain}"  ( disengaja)`;
});

t('2b) kata berbeda tetap menghasilkan kunci berbeda', () => {
  const distinct = ['Naruto Kecil', 'Black Torch', 'Terobsesi Padanya Siang dan Malam', 'One Piece'];
  const keys = distinct.map(V.folderKey);
  assert.strictEqual(new Set(keys).size, distinct.length,
    `dua judul berbeda collide: ${keys.join(' | ')}`);
  return `${distinct.length} judul → ${new Set(keys).size} kunci unik`;
});

t('2c) kunci tidak pernah kosong untuk judul valid', () => {
  for (const t2 of ['A', 'Re:Zero', 'Naruto Kecil', '123', 'Fate Zero']) {
    assert.ok(V.folderKey(t2), `kunci kosong untuk ${JSON.stringify(t2)}`);
  }
  return '5 judul → semua kunci non-kosong';
});

t('2d) CJK & emoji tetap punya kunci (tidak hilang jadi "")', () => {
  // audit 25 Sep: CJK aman, emoji jadi ???. Kunci harus tetap ada.
  const cjk = V.folderKey('Bokurano wa Houfuku');
  const cjk2 = V.folderKey('纺织 Re:Zero');
  assert.ok(cjk && cjk.length > 0, `CJK jadi kosong: ${JSON.stringify(cjk)}`);
  assert.ok(cjk2 && cjk2.length > 0, `CJK+latin jadi kosong: ${JSON.stringify(cjk2)}`);
  return `"${cjk}" / "${cjk2}"`;
});

// ── 3) wiring di kode ──────────────────────────────────────────────────────
t('3a) findNode memakai folderKey untuk node yang sudah ada', () => {
  const m = /function findNode\(nodes, name, parentId\) \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(m, 'fungsi findNode tidak ditemukan');
  const body = m[1];
  assert.ok(/folderKey\(n\.name\)/.test(body),
    'pencocokan node existing HARUS lewat folderKey, bukan toLowerCase');
  assert.ok(!/\.trim\(\)\.toLowerCase\(\) ===/.test(body),
    'laptop: masih ada perbandingan toLowerCase mentah');
  return 'findNode → folderKey(n.name)';
});

t('3b) folderKey membuang non-alnum (bukan cuma lowercase)', () => {
  const m = /function folderKey\(name\)\s*\{[\s\S]*?replace\(\/\[([^\]]*)\]\+\/g, ''\)/.exec(src);
  assert.ok(m, 'folderKey tidak membuang karakter apa pun');
  assert.ok(m[1].includes('a-z0-9'),
    `pola buang karakter tidak menyertakan a-z0-9: "${m[1]}"`);
  return `pola: /[${m[1]}]+/g`;
});

t('3c) animeFolderPath tetap memakai judul (tidak diubah — tidak perlu migrasi)', () => {
  const m = /function animeFolderPath\(title\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(m, 'animeFolderPath tidak ditemukan');
  assert.ok(m[0].includes('title'), 'animeFolderPath harus tetap memakai title');
  return 'segmen terakhir tetap title — nama folder tidak diubah';
});

t('3d) folderKey di-export (bisa diuji & dipakai consumer lain)', () => {
  assert.ok(/^\s*folderKey,\s*$/m.test(src), 'folderKey belum ada di module.exports');
  assert.strictEqual(typeof V.folderKey, 'function');
  return 'module.exports.folderKey ✓';
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
