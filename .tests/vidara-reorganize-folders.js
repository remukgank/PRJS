// Reorganisasi folder lama Vidara: "anime — <Judul> — Ep NN" (1 file/folder)
// → pindahkan semua video ke folder per judul, lalu hapus folder kosongnya.
//
// Jalankan dari root repo:
//   node .tests/vidara-reorganize-folders.js            # DRY-RUN (hanya lapor)
//   node .tests/vidara-reorganize-folders.js --execute  # eksekusi
//
// Butuh env: VIDARA_API (+ VIDARA_USERNAME/PASSWORD kalau perlu bikin folder baru)
// Keamanan: move dulu → VERIFIKASI folder kosong → baru delete.
// Idempoten: folder lama yang sudah tidak ada dilewati.

const Vdara = require('../scraper/vidara-uploader');
const Vdash = require('../scraper/vidara-dashboard');

const EXEC = process.argv.includes('--execute');
const LEGACY_RE = /^anime — (.+?) — Ep \d+$/;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rest(ep, params) {
  const u = `https://api.vidara.so/v1${ep}?api_key=${process.env.VIDARA_API}&${new URLSearchParams(params)}`;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(u);
    if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
    return { s: r.status, d: await r.json().catch(() => ({})) };
  }
  return { s: 0, d: {} };
}
async function listVideos(fldId) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const { d } = await rest('/video/list', { fld_id: fldId, page, limit: 200 });
    const vids = d?.result?.videos || [];
    out.push(...vids);
    if (!d?.result || page >= (d.result.total_pages || 1)) break;
  }
  return out;
}

(async () => {
  const folders = await Vdara.getFolderList();
  const legacy = folders.filter(f => LEGACY_RE.test(f.name || ''));
  console.log(`Mode: ${EXEC ? 'EKSEKUSI' : 'DRY-RUN'} — folder lama ditemukan: ${legacy.length}`);

  // kelompokkan per judul
  const byTitle = new Map();
  for (const f of legacy) {
    const judul = f.name.match(LEGACY_RE)[1];
    if (!byTitle.has(judul)) byTitle.set(judul, []);
    byTitle.get(judul).push(f);
  }
  console.log('Judul terdampak:', [...byTitle.keys()].join(', ') || '(tidak ada)');

  // tujuan per judul (folder yang sudah ada ATAU dibuat baru — nested kalau bisa)
  const target = new Map();
  for (const judul of byTitle.keys()) {
    const existing = folders.find(f => f.name === judul && !LEGACY_RE.test(f.name));
    target.set(judul, existing ? existing.fld_id : null);
    console.log(`  ${judul}: tujuan ${existing ? `fld_id ${existing.fld_id} (sudah ada)` : 'BELUM ADA → akan dibuat'}`);
  }
  if (!EXEC) {
    let totalFiles = 0;
    for (const fs2 of byTitle.values()) totalFiles += fs2.reduce((a, f) => a + (f.videos || 0), 0);
    console.log(`\nRencana: ${legacy.length} folder → ${byTitle.size} folder judul, ± ${legacy.length + byTitle.size} request.`);
    console.log('Jalankan dengan --execute untuk eksekusi.');
    return;
  }

  let moved = 0, deleted = 0, skipped = 0, failed = 0;
  for (const [judul, list] of byTitle) {
    let dest = target.get(judul);
    if (!dest) { dest = await Vdash.getOrCreateSeriesFolder(judul); target.set(judul, dest); }
    if (!dest) { console.log(`  ❌ ${judul}: folder tujuan tidak bisa dibuat — semua folder legacy dilewati`); skipped += list.length; continue; }
    for (const f of list) {
      try {
        // JUMLAH VIDEO PAKAI folder/list.videos — /video/list?fld_id= TERBUKTI
        // basi (masih menampilkan video yang sudah dipindah), jangan dipakai
        // sebagai penentu "folder sudah kosong".
        const cur = (await Vdara.getFolderList()).find(x => x.fld_id === f.fld_id);
        const n = cur ? (cur.videos || 0) : 0;
        if (n > 0) {
          const vids = await listVideos(f.fld_id);
          for (const v of vids) {
            const r = await rest('/video/move', { filecode: v.filecode, fld_id: dest });
            if (r.s === 200) moved++; else { failed++; console.log(`    ❌ move ${v.filecode}: HTTP ${r.s}`); }
            await sleep(120);
          }
        }
        // VERIFIKASI kosong (folder/list.videos === 0) sebelum delete
        const after = (await Vdara.getFolderList()).find(x => x.fld_id === f.fld_id);
        if (after && (after.videos || 0) === 0) {
          const d = await rest('/folder/delete', { fld_id: f.fld_id });
          if (d.d?.result?.deleted) deleted++;
          else { failed++; console.log(`    ❌ delete ${f.name}: ${JSON.stringify(d.d).slice(0, 80)}`); }
        } else {
          skipped++;
          console.log(`    ⚠️ ${f.name} masih berisi ${after ? after.videos : '?'} video — TIDAK dihapus`);
        }
        await sleep(80);
      } catch (e) {
        failed++; console.log(`    ❌ ${f.name}: ${e.message}`);
      }
    }
    console.log(`  ✔ ${judul}: ${list.length} folder diproses`);
  }

  // VERIFIKASI AKHIR
  const after = await Vdara.getFolderList();
  const sisaLegacy = after.filter(f => LEGACY_RE.test(f.name || ''));
  console.log('\n=== HASIL ===');
  for (const [judul, fldId] of target) {
    if (!fldId) continue;
    const v = await listVideos(fldId);
    console.log(`  folder "${judul}" (fld_id ${fldId}): ${v.length} video`);
  }
  console.log(`  pindah: ${moved} | folder dihapus: ${deleted} | gagal: ${failed} | dilewati: ${skipped}`);
  console.log(`  sisa folder lama: ${sisaLegacy.length} ${sisaLegacy.length === 0 ? '✅' : '❌'}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
