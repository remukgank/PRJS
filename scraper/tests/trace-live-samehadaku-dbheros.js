// trace-live-samehadaku-dbheros.js — verifikasi live picker 50 ep + centang library
// Replika setia bot.js: resolveSamehadakuFullhd + buildSamehadakuEpisodePicker + hashUrl
const crypto = require('crypto');
const { resolveSamehadakuFullhd, parseSamehadakuAnime } = require('../providers/samehadaku');
const { listPartsWithFile } = require('../db');
const { sanitizeSlug } = require('../lib/parser');

const ANIME_URL = 'https://v2.samehadaku.how/anime/dragon-ball-heroes/';
function hashUrl(url) { return crypto.createHash('md5').update(url).digest('hex'); }

async function main() {
  const res = await resolveSamehadakuFullhd(ANIME_URL);
  console.log('=== WORKER RESULT ===');
  console.log('type:', res.type, '| episodes:', res.episodes?.length);
  const first = res.episodes?.[0];
  const last = res.episodes?.[res.episodes.length - 1];
  console.log('ep1:', first?.ep, first?.url);
  console.log('epMax:', last?.ep, last?.url);
  const slugs = new Set(res.episodes?.map(e => {
    try { return new URL(e.url).pathname.split('/').filter(Boolean)[0].split('-episode-')[0]; } catch { return '?'; }
  }));
  console.log('slug unik:', [...slugs].join(', '));
  const gaps = [];
  const nums = (res.episodes || []).map(e => e.ep).sort((a, b) => a - b);
  for (let i = 1; i <= nums[nums.length - 1]; i++) if (!nums.includes(i)) gaps.push(i);
  console.log('ep hilang (1..max):', gaps.length ? gaps.join(', ') : 'tidak ada');

  // === PICKER (replika buildSamehadakuEpisodePicker) ===
  const info = parseSamehadakuAnime(ANIME_URL);
  const title = info?.title ? `${info.title}${info.season ? ` S${info.season}` : ''}${info.part ? ` P${info.part}` : ''}` : 'Samehadaku';
  const slug = `anime:${sanitizeSlug(`${info.title}${info.season ? ` S${info.season}` : ''}${info.part ? ` P${info.part}` : ''}`)}`;
  console.log('\n=== PICKER ===');
  console.log('title:', title, '| library slug:', slug);
  let rows = [];
  try { rows = await listPartsWithFile(slug); } catch (e) { console.log('listPartsWithFile warn:', e.message); }
  console.log('library parts:', rows.map(r => r.part).join(', ') || '(kosong)');
  const done = new Set(rows.map(r => Number(r.part)));
  const doneCount = res.episodes.filter(e => done.has(Number(e.ep))).length;
  const total = res.episodes.length;
  const keyboard = [];
  for (let i = 0; i < res.episodes.length; i += 5) {
    keyboard.push(res.episodes.slice(i, i + 5).map(e => done.has(Number(e.ep)) ? `✅${e.ep}` : `Ep${e.ep}`));
  }
  console.log('row 1:', keyboard[0].join(' '));
  console.log('row 10:', keyboard[9]?.join(' '));
  console.log('doneCount:', doneCount, '/', total, `(${total ? Math.round(doneCount / total * 100) : 0}%)`);
  console.log('\n=== RESOLVE EP1 (server FULLHD) ===');
  try {
    const r1 = await resolveSamehadakuFullhd(res.episodes[0].url);
    console.log('type:', r1.type, '| quality:', r1.quality, '| servers:', Object.keys(r1.servers || {}).join(', '));
  } catch (e) { console.log('ep1 resolve gagal:', e.message.slice(0, 120)); }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });