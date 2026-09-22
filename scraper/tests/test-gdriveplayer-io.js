'use strict';

// Uji isGdrivePlayerUrl — One Piece pakai gdriveplayer.io (selain me/to).

const assert = require('assert');
const { isGdrivePlayerUrl } = require('../providers/gdriveplayer');

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

t('.io diterima (One Piece style)', () => {
  assert.strictEqual(isGdrivePlayerUrl('https://gdriveplayer.io/download.php?link=iuJGqJHZ'), true);
  assert.strictEqual(isGdrivePlayerUrl('https://www.gdriveplayer.io/download.php?link=abc'), true);
});

t('.me dan .to tetap diterima', () => {
  assert.strictEqual(isGdrivePlayerUrl('https://gdriveplayer.to/download.php?link=x'), true);
  assert.strictEqual(isGdrivePlayerUrl('https://gdriveplayer.me/download.php?link=x'), true);
});

t('host lain / link non-download.php ditolak', () => {
  assert.strictEqual(isGdrivePlayerUrl('https://drive.google.com/file/d/x/view'), false);
  assert.strictEqual(isGdrivePlayerUrl('https://gdriveplayer.io/other'), false);
  assert.strictEqual(isGdrivePlayerUrl('https://evilgdriveplayer.io/download.php?link=x'), false);
  assert.strictEqual(isGdrivePlayerUrl('https://gdriveplayer.org/download.php?link=x'), false);
  assert.strictEqual(isGdrivePlayerUrl(''), false);
  assert.strictEqual(isGdrivePlayerUrl('not a url'), false);
});

console.log(`\n${passed} tests passed`);