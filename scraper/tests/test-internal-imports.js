'use strict';

// Deteksi "ReferenceError: X is not defined" untuk identifier dari modul internal.
//
// Insiden 27 Sep 2026: bot.js memakai `kamenimeTitleFromFileName(...)` tapi
// fungsinya TIDAK ikut di-import — import-nya ditambahkan di script yang gagal
// di tengah (assertion), jadi tidak pernah tersimpan. `node --check` LOLOS
// (itu syntactic, bukan unresolved identifier). Baru ketahuan saat user tes:
//   ReferenceError: kamenimeTitleFromFileName is not defined
//     at bot.js:4414
//
// Test ini menutup kelas bug itu untuk SEMUA modul internal, bukan cuma kamenime.
//
// Run: node scraper/tests/test-internal-imports.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BOT = path.join(__dirname, '..', 'bot.js');
const src = fs.readFileSync(BOT, 'utf8');

let passed = 0;
let failed = 0;
const t = (name, fn) => {
  try { const extra = fn(); console.log(`PASS  ${name}`); if (extra) console.log(`      ${extra}`); passed++; }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${e.message}`); }
};

/**
 * Buang komentar TANPA merusak string.
 * - `(?<!:)//` supaya URL seperti 'https://x' tidak ikut terpotong.
 * - /* … *\/ dihapus utuh; penting karena komentar bisa berisi kurung tak
 *   berpasangan ("// … (lihat") yang membuat penghitung depth kacau dan
 *   menghasilkan nama export palsu.
 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Buang string & template literal — teks di dalamnya bukan kode. */
function stripLiterals(code) {
  return code
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

/** Nama yang dipanggil sebagai fungsi: `nama(` dan TIDAK didahului `.` atau `$`. */
function calledNames(code) {
  const out = new Set();
  const clean = stripLiterals(stripComments(code));
  const re = /(?<![\w$.])([a-zA-Z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(clean))) out.add(m[1]);
  return out;
}

/** Nama yang benar-benar di-export modul — HANYA dari blok `module.exports = {…}`. */
function exportedNames(rawSrc) {
  const modSrc = stripComments(rawSrc);
  const i = modSrc.indexOf('module.exports');
  if (i < 0) return new Set();
  const start = modSrc.indexOf('{', i);
  if (start < 0) return new Set();
  let depth = 0; let end = -1;
  for (let k = start; k < modSrc.length; k++) {
    if (modSrc[k] === '{') depth++;
    else if (modSrc[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end < 0) return new Set();

  // pisahkan entri top-level berdasarkan koma (abaikan koma di dalam kurung)
  const body = modSrc.slice(start + 1, end);
  const entries = [];
  let d = 0; let cur = '';
  for (const ch of body) {
    if ('([{'.includes(ch)) d++;
    else if (')]}'.includes(ch)) d--;
    if (ch === ',' && d === 0) { entries.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) entries.push(cur);

  const out = new Set();
  for (const raw of entries) {
    const e = raw.trim();
    if (!e) continue;
    // `key: value` → nama publik yang di-export adalah KEY-nya
    //   (mis. `module.exports = { logger: appLogger }` → nama publik "logger")
    // `name` / `async name` → nama itu sendiri
    const colon = /^([A-Za-z_$][\w$]*)\s*:\s*.+$/.exec(e);
    if (colon) out.add(colon[1]);
    else {
      const n = /^(?:async\s+)?([A-Za-z_$][\w$]*)/.exec(e);
      if (n) out.add(n[1]);
    }
  }
  return out;
}

/** Peta: nama → Set modul asal, dari SEMUA import destructure di bot.js. */
function importMap() {
  const map = new Map();
  const clean = stripComments(src);
  const re = /const\s*\{([^}]*)\}\s*=\s*require\(['"](\.[^'"]*)['"]\s*;?/gs;
  let m;
  while ((m = re.exec(src))) {
    const mod = m[2];
    for (const raw of m[1].split(',')) {
      const e = raw.trim();
      if (!e) continue;
      // `key: alias` → nama publik yang di-import adalah KEY-nya
      const al = /^([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$]*$/.exec(e);
      const name = al ? al[1] : e;
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(mod);
    }
  }
  return map;
}

/** Nama yang dideklarasi sendiri di bot.js (wrapper/fungsi lokal) → bukan import. */
function locallyDefined() {
  const out = new Set();
  const pats = [
    /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm,
    /^\s*class\s+([A-Za-z_$][\w$]*)/gm,
  ];
  for (const re of pats) for (const m of src.matchAll(re)) out.add(m[1]);
  return out;
}

/** Modul lokal yang punya module.exports dan dipanggil minimal satu nama darinya. */
function localModules() {
  const out = [];
  const clean = stripComments(src);
  const re = /require\(['"](\.[^'"]*)['"]\s*\)/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(clean))) {
    const rel = m[1];
    if (seen.has(rel)) continue;
    seen.add(rel);
    const base = path.resolve(path.dirname(BOT), rel);
    const file = base.endsWith('.js') ? base : `${base}.js`;
    if (!fs.existsSync(file)) continue; // package eksternal
    const exp = exportedNames(fs.readFileSync(file, 'utf8'));
    if (exp.size) out.push({ rel, exp });
  }
  return out;
}

const imports = importMap();
const mods = localModules();

t('semua modul internal berhasil dipetakan', () => {
  assert.ok(mods.length >= 20, `hanya ${mods.length} modul terpetakan,(expected >= 20)`);
  assert.ok(imports.size >= 40, `hanya ${imports.size} nama ter-import (expected >= 40)`);
  return `${mods.length} modul · ${imports.size} nama ter-import`;
});

t('fungsi providers/kamenime yang dipakai bot.js ter-import dari modul itu', () => {
  const mod = mods.find((x) => x.rel === './providers/kamenime');
  assert.ok(mod, 'bot.js harus meng-require providers/kamenime');
  const used = [...calledNames(src)].filter((n) => mod.exp.has(n)).sort();
  assert.ok(used.length >= 6, `hanya ${used.length} fungsi kamenime terpakai`);
  const missing = used.filter((n) => !(imports.get(n) || new Set()).has('./providers/kamenime'));
  assert.deepStrictEqual(missing, [],
    `dipakai tapi TIDAK di-import dari providers/kamenime → ReferenceError: ${missing.join(', ')}`);
  return `7 fungsi terpakai, semua ter-import: ${used.join(', ')}`;
});

t('SEMUA modul internal: fungsi yang dipanggil selalu ter-import', () => {
  const called = calledNames(src);
  const local = locallyDefined();
  const problems = [];
  let usedCount = 0;
  for (const n of called) {
    // nama yang bentrok dengan export modul internal:
    // harus (a) di-deklarasi sendiri di bot.js sebagai wrapper lokal, atau
    // (b) di-import dari salah satu modul internal.
    const owners = mods.filter((m) => m.exp.has(n));
    if (!owners.length) continue;
    usedCount++;
    if (local.has(n)) continue;              // wrapper lokal, mis. handleKamenimeUrl
    if (imports.has(n)) continue;            // sudah di-import dari suatu modul
    problems.push(`"${n}" dipanggil tapi TIDAK di-deklarasi lokal dan TIDAK di-import `
      + `→ ReferenceError saat runtime (export oleh: ${owners.map((o) => o.rel).join(', ')})`);
  }
  assert.ok(usedCount > 40, `hanya ${usedCount} nama yang dicek (expected > 40)`);
  assert.deepStrictEqual(problems, [],
    `indeks => ReferenceError saat runtime:\n      ${problems.join('\n      ')}`);
  return `${usedCount} nama colliding dicek (${local.size} wrapper lokal, ${imports.size} nama import), 0 bermasalah`;
});

t('nama yang di-import dari modul internal memang ada di module.exports modul itu', () => {
  const problems = [];
  for (const [name, from] of imports) {
    for (const rel of from) {
      const mod = mods.find((x) => x.rel === rel);
      if (!mod) continue; // bukan modul lokal
      if (!mod.exp.has(name)) problems.push(`bot.js meng-import "${name}" dari ${rel}, tapi tidak ada di module.exports-nya`);
    }
  }
  assert.deepStrictEqual(problems, [], problems.join('\n      '));
  return `semua import dari modul lokal terverifikasi ada di exports`;
});

console.log(`\n${passed} pass / ${failed} fail`);
process.exit(failed ? 1 : 0);
