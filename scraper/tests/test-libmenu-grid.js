const assert = require('assert');
const { libraryPartsGrid, buildLibMenuCaption, _libDelMode } = require('../handlers/library');
const { resolveSlug } = require('../lib/urlCache');

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed++;
  console.log(`PASS  ${name}`);
}

const slug = 'anime:one-piece';
const parts = Array.from({ length: 95 }, (_, i) => ({ part: i + 1 }));

// ── Grid halaman 1 (95 part, admin, non-delMode) ──
const kb1 = libraryPartsGrid(slug, parts, 1, { isAdminUser: true, delMode: false });
const flat1 = kb1.inline_keyboard;
const gridRows = flat1.filter((r) => r.every((b) => /^\d+$/.test(b.text)) && r.length === 5);
ok('halaman 1: 4 baris angka penuh (20 part, 5 tombol/baris)', gridRows.length === 4 && gridRows.every(r => r.length === 5));
const firstGrid = flat1.findIndex((r) => /^\d+$/.test(r[0].text));
const cb1 = flat1[firstGrid][0].callback_data;
ok('episode pertama = tombol 1 (lib_part) + slug resolve', flat1[firstGrid][0].text === '1' && /^lib_part:\d+:1$/.test(cb1) && resolveSlug(cb1.split(':')[1]) === slug);
const kbPage5 = libraryPartsGrid(slug, parts, 5, { isAdminUser: false });
const page5Flat = kbPage5.inline_keyboard.filter((r) => /^\d+$/.test(r[0].text)).flat();
ok('episode ke-95 ada di halaman 5 (baris ke-3)', page5Flat[page5Flat.length - 1].text === '95' && /^lib_part:\d+:95$/.test(page5Flat[page5Flat.length - 1].callback_data));
const nav1 = flat1.find((r) => r.some((b) => b.text === '1/5'));
ok('nav menampilkan p/total (1/5)', !!nav1 && nav1.some((b) => b.text === 'Next ➡️'));
ok('admin: tombol Hapus Ep + Hapus Judul', flat1.some(r => r[0]?.text === '🗑️ Hapus Ep') && flat1.some(r => r[1]?.text === '🗑️ Hapus Judul'));
ok('kembali ke list', flat1.some(r => r[0]?.text === '⬅️ Kembali'));

// ── Halaman 2: ada Prev, tidak ada 1 di grid ──
const kb2 = libraryPartsGrid(slug, parts, 2, { isAdminUser: false });
const nav2 = kb2.inline_keyboard.find((r) => r.some((b) => b.text === '2/5'));
ok('halaman 2: Prev + 2/5 + Next', !!nav2 && nav2.some((b) => b.text === '⬅️ Prev') && nav2.some((b) => b.text === 'Next ➡️'));
const flat2 = kb2.inline_keyboard.filter((r) => /^\d+$/.test(r[0].text)).flat();
ok('halaman 2 mulai dari ep 21', flat2[0].text === '21');

// ── Non-admin: tidak ada tombol admin ──
const kbUser = libraryPartsGrid(slug, parts, 1, { isAdminUser: false });
ok('user biasa tanpa tombol hapus', !kbUser.inline_keyboard.some((r) => r.some((b) => b.text.startsWith('🗑️'))));

// ── DelMode: label jadi 🗑️ N ──
const kbDel = libraryPartsGrid(slug, parts, 1, { isAdminUser: true, delMode: true });
const delBtn = kbDel.inline_keyboard
  .flat()
  .find((b) => b.callback_data && b.callback_data.startsWith('lib_del_ep:'));
ok('delMode: tombol jadi 🗑️ N + callback lib_del_ep', !!delBtn && /^lib_del_ep:\d+:1$/.test(delBtn.callback_data) && resolveSlug(delBtn.callback_data.split(':')[1]) === slug);
ok('delMode: ada tombol Selesai', kbDel.inline_keyboard.some((r) => r.some((b) => b.callback_data && b.callback_data.startsWith('lib_delmode:') && b.text.endsWith('Selesai'))));

// ── Caption ──
const cap = buildLibMenuCaption({ nama: 'One Piece', synopsis: 'Petualangan<br> & <b>Luffy</b>' }, slug, parts);
ok('caption: judul + provider + jumlah episode', /One Piece/.test(cap) && /Provider:.*anime/.test(cap) && /95 episode tersedia/.test(cap));
ok('caption: sinopsis di-escape HTML', /&lt;b&gt;Luffy&lt;\/b&gt;/.test(cap));

// ── State toggle ──
_libDelMode.delete('99');
_libDelMode.set('99', true);
ok('libDelMode state set', _libDelMode.get('99') === true);
_libDelMode.delete('99');

console.log(`RESULT: ${passed} pass, 0 fail`);
process.exit(0);