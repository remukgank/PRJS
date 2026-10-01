// Tes folder per-judul Vidara (fix bug "folder per episode") — reversible.
//
// Jalankan dari root repo:   node .tests/vidara-series-folder.js
// Butuh env: VIDARA_API, dan (opsional utk nesting) VIDARA_USERNAME/PASSWORD
//
// Skenario:
//  1. getOrCreateSeriesFolder('Dragon Ball') → pakai folder YANG SUDAH ADA,
//     jumlah folder tidak boleh bertambah (tidak ada lagi folder per episode).
//  2. getOrCreateSeriesFolder('zzprobe-<ts>') → buat folder baru; diverifikasi
//     sebagai ANAK folder root "Anime" lewat GET /files?folder_id=<root>
//     (nesting terbukti), lalu dihapus — sisa probe 0.
//  3. Assertion source: pemanggil uploadToVidaraFolder di handlers/vidoy.js
//     wajib meneruskan judul polos (folderTitle) terpisah dari title per episode.

const fs = require('fs');
const path = require('path');
const Vdara = require('../scraper/vidara-uploader');
const Vdash = require('../scraper/vidara-dashboard');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✅', label); }
  else { fail++; console.log('  ❌', label, extra !== undefined ? `(nilai: ${extra})` : ''); }
}

(async () => {
  console.log('── 1. judul yang sudah ada → dipakai, tidak membuat baru');
  const before = await Vdara.getFolderList();
  const beforeCount = before.length;
  const existing = before.find(f => f.name === 'Dragon Ball');
  ok(!!existing, 'folder "Dragon Ball" sudah ada di server', beforeCount);
  const id = await Vdash.getOrCreateSeriesFolder('Dragon Ball');
  ok(id && id === existing.fld_id, 'getOrCreateSeriesFolder mengembalikan fld_id folder lama', `${id} vs ${existing && existing.fld_id}`);
  const mid = await Vdara.getFolderList();
  ok(mid.length === beforeCount, 'jumlah folder TIDAK bertambah', `${beforeCount} → ${mid.length}`);

  console.log('── 2. judul baru → folder anak root "Anime" (nesting) + bersih-bersih');
  const probe = `zzprobe-${Date.now()}`;
  const probeId = await Vdash.getOrCreateSeriesFolder(probe);
  ok(!!probeId, 'folder probe dibuat', probeId);
  const afterCreate = await Vdara.getFolderList();
  ok(afterCreate.length === beforeCount + 1, 'tambah tepat 1 folder', `${beforeCount} → ${afterCreate.length}`);

  // verifikasi nesting: halaman dashboard /files?folder_id=<root Anime> memuat nama probe
  const root = afterCreate.find(f => f.name === Vdash.ROOT_FOLDER);
  ok(!!root, 'folder root Anime ada', Vdash.ROOT_FOLDER);
  if (root && probeId) {
    const s = await Vdash.login();
    ok(!!s, 'login dashboard sukses');
    if (s) {
      const r = await fetch(`${Vdash.DASHBOARD_BASE}/files?folder_id=${root.fld_id}`, {
        headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36', cookie: Object.entries(s.cookies).map(([k, v]) => `${k}=${v}`).join('; ') },
      });
      const html = await r.text();
      ok(html.includes(probe), 'probe muncul sebagai ANAK folder Anime (nesting terbukti)');
    }
  }
  const del = await fetch(`https://api.vidara.so/v1/folder/delete?api_key=${process.env.VIDARA_API}&fld_id=${probeId}`);
  const delData = await del.json().catch(() => ({}));
  ok(delData?.result?.deleted === true, 'probe dihapus', JSON.stringify(delData).slice(0, 80));
  const final = await Vdara.getFolderList();
  ok(!final.find(f => f.name === probe), 'sisa probe 0', final.filter(f => /^zzprobe/.test(f.name)).length);

  console.log('── 3. assertion source: pemanggil meneruskan folderTitle terpisah');
  const src = fs.readFileSync(path.join(__dirname, '..', 'scraper', 'handlers', 'vidoy.js'), 'utf8');
  const callLine = src.split('\n').find(l => /await uploadToVidaraFolder\(\s*destPath/.test(l));
  ok(!!callLine, 'pemanggil uploadToVidaraFolder(destPath …) ketemu', callLine);
  ok(!!callLine && /,\s*vidoyTitle\s*\)\s*;?\s*$/.test(callLine.trim()),
    'pemanggil meneruskan vidoyTitle (judul polos) sebagai argumen ke-3', callLine && callLine.trim().slice(-60));
  ok(/getOrCreateSeriesFolder\(\s*folderTitle\s*\)/.test(src),
    'uploadToVidaraFolder memakai getOrCreateSeriesFolder(folderTitle)');
  ok(!/vidaraFolderName\(\s*title\s*,/.test(src),
    'vidaraFolderName(title …) tidak lagi dipakai dengan title per-episode');

  console.log(`\nHASIL: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
