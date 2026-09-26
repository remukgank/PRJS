'use strict';

// ⚠ KONTRAK MEDIA — JANGAN DIUBAH TANPA PERSETUJUAN USER ⚠
//
// Dua hal yang user minta berkali-kali dan tidak boleh berubah:
//   1. Video WAJIB dikirim dengan supports_streaming (Telegram tidak stream kalau tidak)
//   2. Format caption WAJIB persis seperti di bawah (4 baris, urutan & label tetap)
//
// Test ini sengaja berada di file terpisah supaya jelas: kalau ada yang mengubah
// streaming atau format caption, test ini GAGAL dengan pesan yang menunjuk
// file & baris — bukanDiam-diam berubah lalu ketahuan saat user menerima video.

const fs = require('fs');
const path = require('path');
const V = require('../handlers/vidoy');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (err) { fail++; console.log('FAIL  ' + name + ': ' + err.message); }
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error((msg || 'tidak cocok') + '\n    harus: ' + JSON.stringify(actual) + '\n    harus: ' + JSON.stringify(expected));
}

const ROOT = path.join(__dirname, '..');
const listJs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name);
  if (d.isDirectory()) return d.name === 'tests' || d.name === 'node_modules' ? [] : listJs(p);
  return d.name.endsWith('.js') ? [p] : [];
});

// ── 1. FORMAT CAPTION: persis, karakter demi karakter ───────────────────────
t('KONTRAK: caption anime (episode tunggal) persis', () => {
  eq(
    V.buildCaption({ title: 'Naruto Kecil', provider: 'samehadaku', part: 5, epStart: 5, epEnd: 5, link: 'https://vski.cc/e/abc' }),
    '➧ Judul :- <b>Naruto Kecil</b>\n'
    + '➧ Episode :- 5\n'
    + '➧ Provider :- samehadaku\n'
    + '➧ Link :- <a href="https://vski.cc/e/abc">vski.cc/e/abc</a>',
    'format caption anime berubah'
  );
});

t('KONTRAK: caption drama (gabung 10) persis', () => {
  eq(
    V.buildCaption({ title: 'Terobsesi Padanya Siang dan Malam', provider: 'dramawave', part: 1, epStart: 1, epEnd: 10, link: 'https://vski.cc/e/ru9a4av12kd9' }),
    '➧ Judul :- <b>Terobsesi Padanya Siang dan Malam</b>\n'
    + '➧ Part/Episode :- 1 (Ep 1–10)\n'
    + '➧ Provider :- dramawave\n'
    + '➧ Link :- <a href="https://vski.cc/e/ru9a4av12kd9">vski.cc/e/ru9a4av12kd9</a>',
    'format caption drama berubah'
  );
});

t('KONTRAK: caption drama part terakhir tetap "Part/Episode"', () => {
  const c = V.buildCaption({ title: 'X', provider: 'dramawave', part: 7, epStart: 61, epEnd: 68, link: 'https://vski.cc/e/zz' });
  if (!c.includes('➧ Part/Episode :- 7 (Ep 61–68)')) throw new Error('label part 7 berubah: ' + c);
});

t('KONTRAK: caption tanpa link tetap 3 baris, tidak ada baris Link kosong', () => {
  const c = V.buildCaption({ title: 'X', provider: 'dramawave', part: 1, epStart: 1, epEnd: 10 });
  if (c.includes('➧ Link')) throw new Error('baris Link muncul tanpa link: ' + c);
  if (c.split('\n').length !== 3) throw new Error('harus 3 baris: ' + c);
});

t('KONTRAK: caption tidak pernah memuat "undefined"', () => {
  for (const args of [
    { title: 'X', provider: 'dramawave', part: 1, epStart: 1, epEnd: 10, link: 'https://vski.cc/e/a' },
    { title: 'X', provider: undefined, part: 3, epStart: 21, epEnd: 30, link: 'https://vski.cc/e/a' },
    { title: undefined, provider: 'p', part: 1, epStart: 1, epEnd: 10, link: 'https://vski.cc/e/a' },
  ]) {
    const c = V.buildCaption(args);
    if (c.includes('undefined')) throw new Error('ada "undefined": ' + c);
  }
});

// ── 2. STREAMING: setiap call site kirim video ─────────────────────────────
// Wrapper yang meny-spread opsi dari pemanggil. Tetap diperiksa ulang: kalau
// baris ini hilang/berubah, allowlist ikut gagal dan wajib ditinjau manusia.
const ALLOWED = [
  {
    file: 'bot.js',
    needle: 'sendVideo(RF_GROUP_ID, filePath, { ...opts, message_thread_id: threadId })',
    why: 'sendToTopicVideo() meneruskan opts dari pemanggil; pemanggil (vidara.js & merge drama)verified punya supports_streaming',
  },
  {
    file: 'bot.js',
    needle: 'sendVideo(RF_GROUP_ID, filePath, { ...opts, message_thread_id: newThreadId })',
    why: 'sama seperti di atas — retry saat topic baru dibuat',
  },
];

t('KONTRAK: semua call site kirim video memakai supports_streaming', () => {
  const files = listJs(ROOT);
  const offenders = [];
  const stillPresent = ALLOWED.map((a) => {
    const f = path.join(ROOT, a.file);
    if (!fs.existsSync(f) || !fs.readFileSync(f, 'utf8').includes(a.needle)) {
      offenders.push(a.file + ': allowlist tidak lagi cocok → ' + a.why);
    }
    return true;
  });
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/\bsendVideo\s*\(|\bsendToTopicVideo\s*\(|\bsendAnimeMedia\s*\(/.test(line)) continue;
      if (/function\s+send(Video|ToTopicVideo|AnimeMedia)\b/.test(line)) continue;
      // definisi/passthrough sender: "sendVideo: (a, b, opts) => ..." — bukan call site
      if (/^\s*(send(Video|AnimeMedia|ToTopicVideo))\s*:/.test(line)) continue;
      // kirim ulang file_id: tidak ada upload → flag tidak berlaku
      if (/\bsendVideo\(\s*[^,]+,\s*[^,]*file_id\s*,/.test(line)) continue;
      const win = lines.slice(Math.max(0, i - 12), i + 13).join('\n');
      let ok = /supports_streaming/.test(win);
      // opsi lewat variabel (opts/options/mediaOpts) → cari definisinya di file yang sama
      if (!ok) {
        const varName = line.match(/send(?:ToTopic)?Video\s*\([^,]+,\s*[^,]+,\s*([A-Za-z_$][\w$]*)/);
        if (varName) {
          const re = new RegExp('(const|let|var)\\s+' + varName[1] + '\\s*=\\s*\\{');
          if (re.test(src)) {
            const at = src.search(re);
            ok = /supports_streaming/.test(src.slice(at, at + 600));
          }
        }
      }
      if (ok) continue;
      const rel = path.relative(ROOT, f);
      const allowed = ALLOWED.some((a) => a.file === rel && line.includes(a.needle));
      if (!allowed) {
        offenders.push(rel + ':' + (i + 1) + '  →  ' + line.trim().slice(0, 90));
      }
    }
  }
  if (offenders.length) {
    throw new Error('call site video TANPA supports_streaming (video tidak akan stream):\n     - '
      + offenders.join('\n     - '));
  }
});

t('KONTRAK: lib/animeTopic memaksa supports_streaming', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'animeTopic.js'), 'utf8');
  if (!/\{ \.\.\.base, supports_streaming: true \}/.test(src)) {
    throw new Error('animeTopic tidak lagi memaksa supports_streaming — video anime tidak stream');
  }
});

t('KONTRAK: handlers/vidoy mengirim dengan streaming di drama & anime', () => {
  const src = fs.readFileSync(path.join(ROOT, 'handlers', 'vidoy.js'), 'utf8');
  const count = (src.match(/supports_streaming: true/g) || []).length;
  if (count < 2) throw new Error('handlers/vidoy hanya punya ' + count + ' supports_streaming (minimal 2: drama & anime)');
  if (!/sendAnimeMedia\(chatId, destPath, mediaOpts\)/.test(src)) {
    throw new Error('anime tidak lewat sendAnimeMedia → masuk topic General');
  }
});

// ── 3. TOPIC: anime ke topic Anime, drama ke topic drama ─────────────────────
t('KONTRAK: animeDIARAHKAN ke topic anime (bukan General)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'animeTopic.js'), 'utf8');
  if (!/message_thread_id: threadId/.test(src)) throw new Error('animeTopic tidak menambah message_thread_id');
});

t('KONTRAK: lib/telegram meneruskan supports_streaming ke API', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'telegram.js'), 'utf8');
  if (!/const \{ caption, supports_streaming/.test(src)) throw new Error('supports_streaming tidak diteruskan di lib/telegram');
  if ((src.match(/supports_streaming,/g) || []).length < 2) throw new Error('field tidak dikirim di semua jalur API');
});

console.log(`\n${pass} pass, ${fail} fail`);
if (fail) {
  console.log('\n⚠ KONTRAK MEDIA BERSYARAH — jangan dipush tanpa izin user.');
  process.exit(1);
}
