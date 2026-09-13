/**
 * test-samehadaku-parse-ep1.js — parseSamehadakuEpisode dukung url ep1 /<slug>/
 * (halaman <slug>/ tanpa -episode-N), dengan guard movie/single tetap null.
 *
 * Usage: node scraper/tests/test-samehadaku-parse-ep1.js
 */

const { parseSamehadakuEpisode } = require('../providers/samehadaku');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name); }
}

console.log('== ep1-slug positif ==');
{
  const r = parseSamehadakuEpisode('https://v2.samehadaku.how/isekai-mokushiroku-mynoghra/');
  ok(!!r, 'parse sukses');
  ok(r?.episode === 1, 'episode = 1');
  ok(r?.slug === 'isekai-mokushiroku-mynoghra', 'slug benar');
  ok(r?.title === 'Isekai Mokushiroku Mynoghra', 'title benar');
  ok(r?.provider === 'samehadaku', 'provider samehadaku');
}

console.log('== ep1-slug dengan season/part ==');
{
  const r = parseSamehadakuEpisode('https://v2.samehadaku.how/tensei-shitara-slime-datta-ken-season-4/');
  ok(r?.episode === 1 && r?.season === 4, 'season 4 ep 1');
}

console.log('== negatif: movie/single ==');
{
  ok(parseSamehadakuEpisode('https://v2.samehadaku.how/conan-movie-26/') === null, 'movie flag null');
  ok(parseSamehadakuEpisode('https://v2.samehadaku.how/one-piece-ova/') === null, 'ova null');
  ok(parseSamehadakuEpisode('https://v2.samehadaku.how/xxx-special/') === null, 'special null');
  ok(parseSamehadakuEpisode('https://v2.samehadaku.how/naruto-shippuden-480p-batch/') === null, 'batch null');
}

console.log('== negatif: anime index ==');
{
  ok(parseSamehadakuEpisode('https://v2.samehadaku.how/anime/isekai-mokushiroku-mynoghra/') === null, '/anime/ index null');
}

console.log('== regresi: pola normal -episode-N ==');
{
  const r = parseSamehadakuEpisode('https://v2.samehadaku.how/isekai-mokushiroku-mynoghra-episode-11/');
  ok(r?.episode === 11, 'ep 11');
  const rEnd = parseSamehadakuEpisode('https://v2.samehadaku.how/isekai-mokushiroku-mynoghra-episode-13-end/');
  ok(rEnd?.episode === 13, 'ep 13 [-end]');
  const rS = parseSamehadakuEpisode('https://v2.samehadaku.how/tensei-shitara-slime-datta-ken-season-4-episode-22/');
  ok(rS?.episode === 22 && rS?.season === 4, 'tensura S4 ep 22');
}

console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);