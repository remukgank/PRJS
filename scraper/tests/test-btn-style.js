'use strict';

// Tes helper tombol: nilai style, struktur row, batas callback_data.

const B = require('../lib/btn');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (err) { fail++; console.log('FAIL  ' + name + ': ' + err.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

t('btn: tombol aksi dengan style', () => {
  const b = B.btn('📚 Cari', 'act:x', 'primary');
  assert(b.text === '📚 Cari');
  assert(b.callback_data === 'act:x');
  assert(b.style === 'primary');
});

t('btn: navigasi tanpa style', () => {
  const b = B.nav('⬅️ Kembali', 'act:back');
  assert(b.style === undefined, 'nav tidak boleh punya style');
  assert(b.callback_data === 'act:back');
});

t('btn: style tidak valid ditolak lebih awal', () => {
  for (const bad of ['link', 'rainbow', 'PRIMARY', 1, true]) {
    let threw = false;
    try { B.btn('X', 'x:1', bad); } catch { threw = true; }
    assert(threw, 'style takAhead valid lolos: ' + String(bad));
  }
});

t('btnOff: tombol mati + boleh tetap berwarna', () => {
  const off = B.btnOff('📥 Vidoy + TG');
  assert(off.disabled && typeof off.disabled === 'object', 'harus punya disabled');
  assert(off.style === undefined);
  assert(off.callback_data === undefined, 'tombol mati tidak boleh punya callback_data');
  const offStyled = B.btnOff('📥 Vidoy + TG', 'success');
  assert(offStyled.style === 'success', 'disabled boleh tetap diberi style');
});

t('btn: callback_data divalidasi (1–64 byte)', () => {
  let threw = false;
  try { B.btn('X', ''); } catch { threw = true; }
  assert(threw, 'callback_data kosong harus ditolak');
  threw = false;
  try { B.btn('X', 'a'.repeat(65)); } catch { threw = true; }
  assert(threw, 'callback_data >64 byte harus ditolak');
  const ok = B.btn('X', 'a'.repeat(64));
  assert(ok.callback_data.length === 64, '64 byte harus boleh');
});

t('grid: melempar error kalau row berisi array (bug InlineKeyboardButton)', () => {
  const rows = [[{ text: 'A', callback_data: 'a:1' }]];
  let threw = false;
  try { B.grid([[rows]]); } catch { threw = true; }
  assert(threw, 'nested array harus ditolak — Telegram akan 400');
  const good = B.grid(rows);
  assert(good[0][0].text === 'A');
});

t('grid: tombol tanpa text ditolak', () => {
  let threw = false;
  try { B.grid([[{ callback_data: 'a:1' }]]); } catch { threw = true; }
  assert(threw, 'tombol tanpa text harus ditolak');
});

t('kb: membungkus jadi inline_keyboard', () => {
  const k = B.kb([[B.btn('A', 'a:1', 'primary')]]);
  assert(Array.isArray(k.inline_keyboard));
  assert(k.inline_keyboard[0][0].style === 'primary');
});

t('countStyle: menghitung tombol per warna', () => {
  const k = B.kb([
    [B.btn('A', 'a:1', 'primary'), B.btn('B', 'b:1', 'success')],
    [B.btn('C', 'c:1'), B.btn('D', 'd:1', 'primary')],
  ]);
  assert(B.countStyle(k, 'primary') === 2, 'dua primary terhitung');
  assert(B.countStyle(k, 'success') === 1);
});

console.log(`\n${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
