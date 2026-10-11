// Tes fix "tombol Download Semua mati" (11 Okt 2026) — kasus Super Dragon Ball
// Heroes: 55/55 terkirim TG tapi 0 record host → tombol batch jadi btnOff
// "✅ Semua episode sudah ada" padahal backfill host (Vidara/Vidoy) masih bisa.
//
// Jalankan dari root repo:   node .tests/picker-host-gap.js
//
// Yang diuji:
//  1. Unit buildPicker (murni, tanpa DB/network):
//     - done semua + hosted parsial → tombol HIDUP "Download Semua (N)" (primary)
//     - done semua + hosted semua  → tetap btnOff (perilaku lama terjaga)
//     - tanpa param hosted         → perilaku lama identik (back-compat)
//  2. Struktural bot.js: ketiga picker (kamenime/samehadaku/kuronime) membangun
//     `hosted` dari st.link || st.vidara dan meneruskannya ke buildPicker.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { buildPicker } = require(path.join(ROOT, 'scraper/lib/samKeyboard.js'));
const src = fs.readFileSync(path.join(ROOT, 'scraper/bot.js'), 'utf8');

let pass = 0;
function t(name, fn) {
  try { const info = fn(); console.log(`✅ ${name}${info ? ' — ' + info : ''}`); pass++; }
  catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; }
}

const eps55 = Array.from({ length: 55 }, (_, i) => ({ ep: i + 1, url: `https://x/anime/a/episode/${i + 1}` }));
const done55 = new Set(eps55.map((e) => e.ep)); // semua terkirim TG
const hosted12 = new Set([1, 2]);               // hanya Ep 1-2 punya link host

t('done semua + hosted parsial → tombol HIDUP (kasus SDBH)', () => {
  const { keyboard } = buildPicker(eps55, { urlId: 'u', done: done55, hosted: hosted12, prefix: 'kam', mkEp: (e) => ({ text: String(e.ep), callback_data: `kam_ep:${e.ep}` }) });
  const b = keyboard[0][0];
  assert.ok(!b.disabled, 'tombol tidak boleh mati — masih ada 53 episode tanpa link host');
  assert.strictEqual(b.callback_data, 'kam_all:u:0', 'callback tombol batch salah');
  assert.strictEqual(b.style, 'primary', 'tombol aksi utama tetap primary');
  assert.ok(/Download Semua \(53\)/.test(b.text), `label harus (53), dapat: ${b.text}`);
  return 'btn aktif · label (53)';
});

t('done semua + hosted semua → tetap btnOff (perilaku lama terjaga)', () => {
  const hostedAll = new Set(eps55.map((e) => e.ep));
  const { keyboard } = buildPicker(eps55, { urlId: 'u', done: done55, hosted: hostedAll, prefix: 'kam', mkEp: (e) => ({ text: String(e.ep), callback_data: `kam_ep:${e.ep}` }) });
  const b = keyboard[0][0];
  assert.ok(b.disabled, 'tombol harus mati kalau TG + host semua lengkap');
  assert.ok(/Semua episode sudah ada/.test(b.text), `label salah: ${b.text}`);
  return 'btnOff ✓';
});

t('tanpa param hosted → perilaku lama identik (back-compat)', () => {
  const k1 = buildPicker(eps55, { urlId: 'u', done: done55, mkEp: (e) => ({ text: String(e.ep), callback_data: `x:${e.ep}` }) });
  assert.ok(k1.keyboard[0][0].disabled, 'tanpa hosted: done semua → tetap btnOff');
  const done52 = new Set(eps55.slice(0, 52).map((e) => e.ep));
  const k2 = buildPicker(eps55, { urlId: 'u', done: done52, mkEp: (e) => ({ text: String(e.ep), callback_data: `x:${e.ep}` }) });
  assert.ok(!k2.keyboard[0][0].disabled, 'tanpa hosted: masih ada kerja → tombol hidup');
  assert.ok(/Download Semua \(3\)/.test(k2.keyboard[0][0].text), `label lama (3), dapat: ${k2.keyboard[0][0].text}`);
  return 'back-compat ✓';
});

t('struktural: ketiga picker membangun hosted + meneruskannya', () => {
  const nHosted = (src.match(/st\.link \|\| st\.vidara\) hosted\.add/g) || []).length;
  assert.strictEqual(nHosted, 3, `hosted.add di buildPicker harus 3 (kamenime/sam/kur), dapat ${nHosted}`);
  const nPass = (src.match(/^\s*hosted,$/gm) || []).length;
  assert.strictEqual(nPass, 3, `pass 'hosted' ke buildPicker harus 3, dapat ${nPass}`);
  return '3 picker ✓';
});

console.log(process.exitCode ? `\n❌ ADA GAGAL (${pass} pass)` : `\n✅ SEMUA PASS (${pass} pass)`);
