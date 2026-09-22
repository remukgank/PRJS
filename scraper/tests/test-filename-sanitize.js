const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { safeFileName, tempUniquePath, TMP_DIR } = require('../downloader');

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log(`PASS  ${name}`);
}

// ── safeFileName ──
ok('nama server asli dipertahankan', safeFileName('One Piece Ep 1125.mp4', 'fb') === 'One Piece Ep 1125.mp4');
ok('path traversal dibersihkan', safeFileName('../x/..\\y.mp4', 'fb') === '__x___y.mp4');
ok('karakter kontrol dibuang', safeFileName('a\nb\tc.mp4', 'fb') === 'abc.mp4');
ok('double dot di-replace', safeFileName('a..b.mp4', 'fb') === 'a_b.mp4');
ok('nama kosong → fallback', safeFileName('', 'gofile_123.mp4') === 'gofile_123.mp4');
ok('nama hanya titik → fallback', safeFileName('.', 'gofile_123.mp4') === 'gofile_123.mp4');
ok('panjang dibatasi 150', safeFileName('x'.repeat(300) + '.mp4', 'fb').length <= 150);

// ── tempUniquePath ──
fs.mkdirSync(TMP_DIR, { recursive: true });
const base = path.join(TMP_DIR, 'test-temp-uniq.mp4');
try { fs.writeFileSync(base, 'dummy'); } catch {}

const second = tempUniquePath('test-temp-uniq.mp4');
ok('file yang sudah ada → path baru (anti-bentrok)', second !== base && path.dirname(second) === TMP_DIR && !fs.existsSync(second) || !second.includes('test-temp-uniq'));
ok('file belum ada → path asli', tempUniquePath('test-temp-uniq-baru.mp4') === path.join(TMP_DIR, 'test-temp-uniq-baru.mp4'));

try { fs.unlinkSync(base); } catch {}
try { fs.unlinkSync(second); } catch {}

console.log(`RESULT: ${passed} pass, 0 fail`);
process.exit(0);