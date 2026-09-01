/**
 * test-all-subdomains.js
 * Test scrape untuk semua subdomain dramafren.org.
 *
 * Usage: npm run test:all
 */

const { getAllEpisodes, getVideoUrl } = require('./index');

// Known working IDs per subdomain (update when found)
const TEST_URLS = {
  shortmax:     { id: '25396' },
  flickreels:   { id: '3367' },
  stardusttv:   { id: '19712' },
  dramabox:     { id: '41000104494' },
  goodshort:    { id: '31001380498' },
  dramapops:    { id: '17007' },
  microdrama:   { id: '17007' },
  reelshort:    { id: '69ca53872d1778675e012f55' },
  flextv:       { id: '17007' },
  dramabite:    { id: '17007' },
  netshort:     { id: '2062101818012962817' },
  dramawave:    { id: 'iSHkRLZsIs' },
  shortwave:    { id: '17007' },
  kalostv:      { id: '17007' },
  tvseries:     { id: '17007' },
  moboreels:    { id: '17007' },
  idrama:       { id: '17007' },
  reelfren:     { id: '17007' },
};

async function testSubdomain(name) {
  const cfg = TEST_URLS[name];
  if (!cfg) return '⚠️ no test config';

  try {
    const { episodes } = await getAllEpisodes(name, cfg.id, '', 'id');
    if (!episodes.length) return '⚠️ no episodes (maybe wrong ID)';

    const result = await getVideoUrl(name, cfg.id, '', 1, 1, 'id');
    if (result.videoUrl) {
      const type = result.videoUrl.includes('.m3u8') ? 'HLS' :
                   result.videoUrl.includes('.mp4') ? 'MP4' : 'API';
      return `✅ ${episodes.length} eps, ${type}`;
    }
    return `⚠️ ${episodes.length} eps, no video URL`;
  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('403')) return '🔒 Cloudflare 403';
    if (msg.includes('ENOTFOUND')) return '❌ domain not found';
    return `❌ ${msg.slice(0, 50)}`;
  }
}

(async () => {
  const names = Object.keys(TEST_URLS);
  console.log(`\n=== Test ${names.length} subdomains ===\n`);

  let passed = 0;
  let blocked = 0;
  let failed = [];

  for (const name of names) {
    process.stdout.write(`  ${name.padEnd(15)}`);
    const result = await testSubdomain(name);
    console.log(result);
    if (result.startsWith('✅')) passed++;
    else if (result.includes('403')) blocked++;
    else failed.push(`${name}: ${result}`);
  }

  console.log(`\n=== ${passed} passed | ${blocked} cloudflare | ${failed.length} failed ===`);
  if (failed.length) {
    console.log('\nNeeds fix:');
    failed.forEach(f => console.log(`  ${f}`));
  }
})();
