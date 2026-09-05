/**
 * test.js
 * Quick smoke-test against the StarDustTV example from the spec.
 *
 * Run:  node scraper/test.js
 *       (from the workspace root, after cd into scraper/ and npm install)
 */

const { getVideoUrl, getAllEpisodes } = require('../index');

const SUBDOMAIN = 'stardusttv';
const ID = '19712';
const SLUG = 'cinta-dan-peluru-semua-untuknya';
const EP = 1;

(async () => {
  try {
    console.log('=== Test: getVideoUrl ===');
    const result = await getVideoUrl(SUBDOMAIN, ID, SLUG, EP);

    console.log('\n--- Result ---');
    console.log(
      JSON.stringify(
        {
          title: result.title,
          episode: result.episode,
          server: result.server,
          videoUrl: result.videoUrl,
          subtitleUrl: result.subtitleUrl,
        },
        null,
        2
      )
    );

    if (!result.videoUrl) {
      console.warn('\n[WARN] No video URL captured — check debug output above.');
      console.warn('Try running with debug=true in interceptVideoUrl() for full request log.');
    }

    console.log('\n=== Test: getAllEpisodes ===');
    const { episodes, meta } = await getAllEpisodes(SUBDOMAIN, ID, SLUG);
    console.log('Meta:', meta);
    console.log(`Found ${episodes.length} episode(s):`);
    episodes.slice(0, 5).forEach((e) => console.log(`  ep ${e.ep}: ${e.url}`));
    if (episodes.length > 5) {
      console.log(`  ... and ${episodes.length - 5} more`);
    }
  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  }
})();
