'use strict';

// Verifikasi pasca-upload Vidoy: filecode harus ada di folder sebelum DB ditulis.
//
// MASALAH: 91 + 8 record `vidoy_uploads` menunjuk file yang tidak pernah
// mendarat di Vidoy (server balas sukses + filecode, tapi file hilang).
// `uploadSingle` menulis DB begitu `uploadFile` return ok — tanpa pernah
// memastikan file benar-benar ada di folder. Record phantom memblokir upload
// ulang via dedup link+part, dan tidak ketahuan sampai dihitung manual.
//
// FIX: setelah upload ok, `folderFileIndex(folderId, {force:true})` harus
// memuat filecode. Kalau tidak → return ok:false, DB TIDAK ditulis.
// Kalau verifikasinya sendiri gagal (network) → fail-open: tulis DB, catat warn.
//
// Test ini mengekstrak blok verifikasi ASLI dari vidoyService.js dan
// menjalankannya dengan stub — tidak menyalin logika.
//
// Run: node scraper/tests/test-vidoy-verify-landing.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SVC = path.join(__dirname, '..', 'services', 'vidoyService.js');
const src = fs.readFileSync(SVC, 'utf8');

let passed = 0;
let failed = 0;
const queue = [];
const t = (name, fn) => queue.push({ name, fn });

/** Ambil blok verifikasi pasca-upload yang asli dari uploadSingle. */
function extractVerifyBlock() {
  const start = src.indexOf('// Verifikasi pasca-upload:');
  assert.ok(start >= 0, 'blok verifikasi tidak ada di vidoyService.js — fix hilang?');
  // akhir blok = `}` yang menutup `if (up.filecode && ...)` — cari dengan depth
  let depth = 0;
  let started = false;
  for (let k = start; k < src.length; k++) {
    if (src[k] === '{') { depth++; started = true; }
    else if (src[k] === '}') {
      depth--;
      if (started && depth === 0) return src.slice(start, k + 1);
    }
  }
  throw new Error('akhir blok verifikasi tidak ketemu');
}

// TIDAK ada ekstraksi saat load. Versi pertama memakai `const BLOCK = ...`
// di sini, sehingga saat blok dihapus (mutasi) file crash sebelum test jalan
// — tidak ada FAIL, tidak ada ringkasan. Sekarang lazy per-test.

/**
 * Jalankan blok verifikasi dengan stub.
 * Mengembalikan { returned, saved } — apa yang di-return dan apakah DB ditulis.
 */
async function runVerify({ filecode, folderId, inFolder, throws }) {
  let BLOCK;
  try { BLOCK = extractVerifyBlock(); }
  catch (e) { return { returned: 'NO_BLOCK: ' + e.message, saved: null }; }
  let saved = null;
  let returned = 'NEVER_RETURNED';
  const scope = {
    up: { filecode, folderId },
    mediaKey: 'One Piece', kind: 'anime', num: 1,
    Vidoy: {
      folderFileIndex: async () => {
        if (throws) throw new Error('network down');
        return { byId: new Map(inFolder ? [[String(filecode), {}]] : []), byTitle: new Map(), total: inFolder ? 1 : 0 };
      },
    },
    logger: { warn: () => {}, info: () => {} },
    db: { saveVidoyUpload: async (row) => { saved = row; } },
  };
  // bungkus: blok asli diakhiri `return {...}` saat gagal; kalau lolos, lanjut.
  // Tambahkan marker agar tahu blok selesai tanpa return.
  const code = `${BLOCK}\nreturn 'PASSED_THROUGH';`;
  const keys = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const fn = new Function(...keys, `return (async () => {\n${code}\n})();`);
  try {
    returned = await fn(...keys.map((k) => scope[k]));
  } catch (e) {
    return { returned: 'THREW: ' + e.message, saved };
  }
  return { returned, saved };
}

t('file mendarat → lolos, DB ditulis', async () => {
  const { returned, saved } = await runVerify({ filecode: 'abc123', folderId: 'fx9', inFolder: true });
  assert.strictEqual(returned, 'PASSED_THROUGH', `harus lolos, dapat: ${JSON.stringify(returned)}`);
  return 'lolos (lanjut ke saveVidoyUpload di luar blok) ✓';
});

t('file TIDAK mendarat → ok:false, DB TIDAK ditulis', async () => {
  const { returned, saved } = await runVerify({ filecode: 'hilang99', folderId: 'fx9', inFolder: false });
  assert.ok(returned && returned.ok === false, `harus return ok:false, dapat: ${JSON.stringify(returned)}`);
  assert.ok(/tidak mendarat/.test(returned.error), `pesan harus jelas: ${returned.error}`);
  assert.strictEqual(saved, null, 'DB TIDAK BOLEH ditulis kalau file tidak ada — itu phantom!');
  return `diblokir: "${returned.error}"`;
});

t('verifikasi gagal (network) → fail-open: DB tetap ditulis', async () => {
  const { returned, saved } = await runVerify({ filecode: 'abc123', folderId: 'fx9', throws: true });
  assert.strictEqual(returned, 'PASSED_THROUGH', `harus lolos (fail-open), dapat: ${JSON.stringify(returned)}`);
  return 'fail-open ✓';
});

t('folder root (id 0) → verifikasi dilewati, DB ditulis', async () => {
  const { returned, saved } = await runVerify({ filecode: 'abc123', folderId: '0', inFolder: false });
  assert.strictEqual(returned, 'PASSED_THROUGH', 'root tidak bisa diverifikasi — harus dilewati');
  return 'root dilewati ✓';
});

t('tanpa filecode → verifikasi dilewati, DB ditulis', async () => {
  const { returned, saved } = await runVerify({ filecode: null, folderId: 'fx9', inFolder: false });
  assert.strictEqual(returned, 'PASSED_THROUGH', 'tanpa filecode tidak ada yang diverifikasi');
  return 'tanpa filecode dilewati ✓';
});

t('blok memakai force:true (tanpa cache basi)', () => {
  let BLOCK;
  try { BLOCK = extractVerifyBlock(); }
  catch (e) { assert.fail('blok verifikasi hilang: ' + e.message); }
  assert.ok(/folderFileIndex\(up\.folderId,\s*\{\s*force:\s*true\s*\}\)/.test(BLOCK),
    'harus force:true — cache basi akan selalu bilang "ada"');
  return 'force:true ✓';
});

t('penjaga: saveVidoyUpload hanya SETELAH blok verifikasi', () => {
  const iVerify = src.indexOf('// Verifikasi pasca-upload:');
  const iSave = src.indexOf('await db.saveVidoyUpload({', iVerify);
  assert.ok(iVerify > 0 && iSave > iVerify, 'urutan salah: save harus setelah verifikasi');
  return 'urutan benar ✓';
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
