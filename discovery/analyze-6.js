#!/usr/bin/env node
// analyze-6.js — klasifikasi bahasa Indonesia dari title, fetch sinopsis utk yg ambigu
const fs = require('fs');
const axios = require('axios');

const SUBS = ['flickreels', 'shortmax', 'stardusttv', 'dramabox', 'netshort', 'reelshort'];
const LANG = { flickreels: 'id', shortmax: 'id', stardusttv: 'id', dramabox: 'in', netshort: 'id', reelshort: 'id' };

// Genre tags yang muncul di HTML title (bukan judul)
const GENRE_TAGS = new Set(['drama','terlarang','cinta diam','balik alur','komedi ringan','cinta toksik','reuni','terbebas','alur cerita kreatif','sulih suara','episode baru','tayangan baru']);

const INDO_WORDS = new Set(('cinta hati istri suami raja ratu putri pangeran ibu ayah aku kamu ku mu kita kami mereka ini itu yang dan atau tapi dengan untuk dari tidak jangan sangat sahabat teman mawar dendam takdir mimpi selingkuh pernikahan menikah keluarga kaya miskin dokter bos mafia guru dosen anak bocah kakak adik bapak mama papa miliarder pewaris rahasia kejutan kembali bangkit terbuang diremehkan diam bisu gendut sedih rindu maaf tolong bisa harus sudah belum dia engkau keajaiban kesetiaan pengkhianatan penyesalan kehancuran kejayaan wibawa mahkota kekasih pengantin istana kerajaan prajurit perang pedang naga dewa ular serigala raksasa perjalanan tabib biksu biarawati pura-pura palsu asli jahat baik kuat lemah tersembunyi hancurkan tinggalkan ayo sang si terluka terasing terbuang terjebak terikat terlahir kembali hidup mati jiwa tubuh raga dunia langit bumi bulan matahari bintang laut samudra gunung kota desa rumah jalan sekolah kantor uang emas harta warisan takhta kursi singgasana mahkota gelar berdarah berdarah dingin dingin panas api air angin hujan salju malam siang pagi sore tahun bulan hari jam detik waktu kini nanti selamanya abadi sendiri orang asing asing misterius menawan tampan cantik jelita anggun gagah perkasa sakti terhebat terkuat terpintar jenius detektif pengacara jaksa hakim polisi tentara pahlawan penjahat musuh lawan kawan kelompok geng organisasi kerajaan kaisar permaisuri selir dayang pengawal ksatria penjaga istana keraton puri bangsawan ningrat darah biru bangsawan kaya raya jutawan konglomerat taipan hartawan pengusaha direktur manager pemimpin bos besar don gudang bajingan preman jagoan pendekar silat kungfu ninja samurai bangsa keturunan darah warisan pusaka mustika keris tombak panah anak panah senjata pamor azimat jimat ramuan obat mantra kutukan tebusan pengorbanan pengorbanan korban penebusan dosa pahala neraka surga malaikat iblis setan hantu jin roh arwah halusinasi kesurupan kerasukan santet teluh guna guna pelet sihir sihir mistis gaib tersembunyi rahasia gelap misteri teka teki petunjuk bukti jejak sidik jari naskah dokumen surat wasiat perjanjian kesepakatan hutang bayar tebusan tahanan penjara hukuman bebas melarikan diri kabur lari kejar mengejar menghindar sembunyi mencari menemukan bertemu berpisah menangis tertawa marah emosi dendam kesumat benci sayang rindu kangen mencintai mengasihi menyayangi membenci memaafkan menyesali menyesal bersalah salah benar khilaf dosa pahala berniat bercita cita berharap mengharap berdoa beribadah sembahyang mengaji berguru belajar mengajar mendidik melatih berlatih bertanding berlomba berkompetisi menang kalah seri imbang juara runner up kampiun jago terbaik nomor satu tertinggi terbesar terkecil'.split(' ')));

const ENG_WORDS = new Set(('the of my your love wife husband secret revenge billionaire ceo president wedding baby daughter father mother boss doctor prince princess king queen me you we they and for with from not never always forever heart life time day night world city family rich poor dead return rise fallen forgotten chosen hidden forbidden legacy heir empire crown throne sword dragon wolf snake war warrior knight his her their this that who what when why how into upon after before between without until because but so if then there here where when become became became'.split(' ')));

function cleanTitle(raw) {
  let t = raw
    .replace(/&amp;/g, '&')
    .replace(/🔥\s*\d+/g, '')
    .replace(/Eps:\s*\d+/g, '')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map(s => s.replace(/[^\w\s&'’\-:!?]/g, '').trim())
    .filter(Boolean);
  // Ambil baris judul: baris pertama yang bukan genre tag
  const titleLines = t.filter(l => !GENRE_TAGS.has(l.toLowerCase()));
  // Jika tidak ada, fallback ke seluruh baris pertama yang masuk akal
  if (!titleLines.length) return (t[0] || raw).slice(0, 100);
  // Beberapa baris genre menyatu — ambil yang punya kapitalisasi kata 2+ atau terpanjang
  let best = titleLines[0];
  for (const l of titleLines) {
    if (l.split(/\s+/).length > best.split(/\s+/).length && l.length > 3) best = l;
    if (l.split(/\s+/).length >= 3) break;
  }
  return best.slice(0, 100);
}

function classify(title) {
  const words = title.toLowerCase().replace(/[^a-z0-9&\s]/g, ' ').split(/\s+/).filter(Boolean);
  let indo = 0, eng = 0;
  for (const w of words) {
    if (INDO_WORDS.has(w)) indo++;
    if (ENG_WORDS.has(w)) eng++;
  }
  // 1 kata pendek ("Cinta") → indo
  if (eng === 0 && indo >= 1) return 'id';
  if (indo === 0 && eng >= 1) return 'ambig';
  if (indo >= 1 && indo >= eng) return 'id';
  return 'ambig';
}

function classifySynopsis(synopsis) {
  if (!synopsis) return 'id'; // tanpa sinopsis, default aman (sudah lang=id/in)
  const words = synopsis.toLowerCase().replace(/[^a-z0-9&\s]/g, ' ').split(/\s+/).filter(Boolean);
  let indo = 0, eng = 0;
  for (const w of words) {
    if (INDO_WORDS.has(w)) indo++;
    if (ENG_WORDS.has(w)) eng++;
  }
  if (eng === 0) return 'id';
  if (indo > eng) return 'id';
  return 'non-id';
}

async function fetchDetail(sub, id) {
  const lang = LANG[sub];
  const url = `https://${sub}.dramafren.org/index.php?page=detail&id=${id}&lang=${lang}`;
  // Coba axios direct dulu (detail page gak butuh CF session)
  try {
    const resp = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      timeout: 15000,
      httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
    });
    if (resp.data && !resp.data.includes('Just a moment')) return resp.data;
  } catch {}
  // Fallback FlareSolverr (tanpa session — batch punya session sendiri)
  try {
    const resp = await axios.post('http://127.0.0.1:8191/v1', {
      cmd: 'request.get', url, maxTimeout: 60000,
    }, { timeout: 90000 });
    return resp.data?.solution?.response || '';
  } catch {
    return '';
  }
}

function parseDetail(html) {
  const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  const ogDesc = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
  const title = ogTitle?.[1]?.replace(/ - .*$/, '').trim() || null;
  const synopsis = ogDesc?.[1]?.trim() || null;
  return { title, synopsis };
}

(async () => {
  const report = [];
  let needFetch = 0;

  for (const sub of SUBS) {
    const file = `${__dirname}/${sub}_new.json`;
    if (!fs.existsSync(file)) continue;
    const items = JSON.parse(fs.readFileSync(file, 'utf8'));
    const results = [];

    for (const item of items) {
      let title = item.title;
      const cleaned = cleanTitle(item.title);
      // Untuk title kotor (terlalu banyak noise) — pakai og:title dari detail page
      const noiseScore = (title.match(/🔥/g) || []).length + (title.match(/\n/g) || []).length;
      let verdict = classify(cleaned);

      if (noiseScore > 0) {
        // Title kotor → harus fetch detail untuk dapat judul bersih + sinopsis
        needFetch++;
        const html = await fetchDetail(sub, item.id);
        const meta = parseDetail(html);
        if (meta.title) title = meta.title;
        verdict = classify(cleanTitle(title));
        const synVerdict = classifySynopsis(meta.synopsis);
        results.push({ id: item.id, title: cleanTitle(title), verdict, synopsis: meta.synopsis?.slice(0, 120) || null, synVerdict });
        continue;
      }

      if (verdict === 'ambig') {
        needFetch++;
        const html = await fetchDetail(sub, item.id);
        const meta = parseDetail(html);
        const synVerdict = classifySynopsis(meta.synopsis);
        results.push({ id: item.id, title: cleaned, verdict, synopsis: meta.synopsis?.slice(0, 120) || null, synVerdict });
        continue;
      }

      results.push({ id: item.id, title: cleaned, verdict, synopsis: null, synVerdict: null });
    }

    const idCount = results.filter(r => r.verdict === 'id').length;
    const ambigCount = results.filter(r => r.verdict === 'ambig' && (!r.synVerdict || r.synVerdict === 'id')).length;
    const nonId = results.filter(r => r.synVerdict === 'non-id' || (r.verdict === 'ambig' && r.synVerdict === 'non-id')).length;

    report.push({ sub, total: results.length, idCount: idCount + (results.filter(r => r.verdict === 'ambig' && r.synVerdict === 'id').length), ambigKept: ambigCount, nonId, items: results });
    console.log(`\n=== ${sub}: ${results.length} baru, ~${idCount} jelas-ID, ${results.filter(r => r.verdict === 'ambig').length} ambigu`);
    for (const r of results) {
      const tag = r.verdict === 'ambig'
        ? (r.synVerdict === 'non-id' ? '❌ non-ID' : '⚠️ ambigu→cek')
        : '✅ id';
      console.log(`  ${tag} ${r.id} - ${r.title}`);
      if (r.synopsis && r.verdict === 'ambig') console.log(`         synopsis: ${r.synopsis}`);
    }
  }

  console.log(`\n\n=== RINGKASAN (fetch detail: ${needFetch})`);
  for (const r of report) {
    console.log(`${r.sub}: ${r.items.filter(i => i.verdict === 'id' || i.synVerdict === 'id').length}/${r.total} Indonesia (non-ID: ${r.nonId}, ambigu tanpa keputusan: ${r.items.filter(i => i.verdict === 'ambig' && i.synVerdict === null).length})`);
  }
})();
