/**
 * index.js
 * Public API for the dramafren scraper.
 *
 * Supported subdomains (all use the same URL pattern):
 *   dramabox, goodshort, starshort, flickreels, dramapops,
 *   stardusttv, microdrama, shortmax, reelshort, flextv, dramabite
 *
 * URL pattern:
 *   https://{subdomain}.dramafren.org/index.php?page=watch&id=...&ep=...&sv=1&lang=id
 */

const { interceptVideoUrl, destroySession, decodeHtmlEntities } = require('./providers/dramafren');
const axios = require('axios');
const https = require('https');
const { logger } = require('./logger');

const BASE_DOMAIN = 'dramafren.org';
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191';

async function fetchPageHtml(url, session, _isRetry) {
  // Coba direct axios dulu (cepat)
  try {
    const resp = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      timeout: 15_000,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
    // Cek apakah kena Cloudflare
    if (resp.data && !resp.data.includes('Just a moment')) {
      return resp.data;
    }
  } catch {
    // 403 atau error lain, lanjut ke FlareSolverr
  }

  // Fallback ke FlareSolverr (lambat tapi bypass CF)
  let resp;
  try {
    const body = {
      cmd: 'request.get',
      url,
      maxTimeout: 120000,
    };
    if (session) body.session = session;
    resp = await axios.post(`${FLARESOLVERR_URL}/v1`, body, { timeout: 150000 });
  } catch (err) {
    if (!_isRetry) return fetchPageHtml(url, session, true);
    throw new Error(err.message);
  }

  if (resp.data?.status === 'ok' && resp.data?.solution?.response) {
    return resp.data.solution.response;
  }
  if (!_isRetry) return fetchPageHtml(url, session, true);
  throw new Error(resp.data?.message || 'FlareSolverr: invalid response');
}

/**
 * Build a watch URL from its components.
 */
function buildWatchUrl(subdomain, id, slug, ep, sv = 1, lang = 'id') {
  const params = new URLSearchParams({ page: 'watch', id: String(id), ep: String(ep), sv: String(sv), lang });
  if (slug) params.set('slug', String(slug));
  return `https://${subdomain}.${BASE_DOMAIN}/index.php?${params.toString()}`;
}

/**
 * Build a detail/listing URL for a drama.
 */
function buildDetailUrl(subdomain, id, slug, lang = 'id') {
  const params = new URLSearchParams({ page: 'detail', id: String(id), lang });
  if (slug) params.set('slug', String(slug));
  return `https://${subdomain}.${BASE_DOMAIN}/index.php?${params.toString()}`;
}

/**
 * Direct video-server API hosts per subdomain (no Cloudflare — plain JSON).
 * Discovered from the watch page's `videoServerEndpoints` JS variable.
 */
const VIDEO_SERVER_API_HOSTS = {
  shortmax: ['cdn-shortmaxv3.dramafren.org', 'cdn-shortmax.dramafren.org'],
};

/**
 * Resolve a video URL via the subdomain's direct video_server JSON API.
 * The site's own watch page loads URLs client-side via AJAX from these hosts;
 * scraping the watch page races that AJAX (empty/stale videoServers), so call
 * the API ourselves instead. Fresh signed URL every request.
 *
 * @returns {Promise<{ videoUrl: string|null, subtitleUrl: string|null, title: string|null }>}
 */
async function getVideoUrlViaApi(subdomain, id, ep, sv = 1, lang = 'id') {
  const hosts = VIDEO_SERVER_API_HOSTS[subdomain];
  if (!hosts) return { videoUrl: null, subtitleUrl: null, title: null };

  for (const host of hosts) {
    const apiUrl = `https://${host}/index.php?action=video_server&server=server${sv}&id=${encodeURIComponent(id)}&ep=${encodeURIComponent(ep)}&lang=${encodeURIComponent(lang)}`;

    // API-nya flaky (~1 dari 4 panggilan balik kosong) → retry
    for (let attempt = 0; attempt < 3; attempt++) {
      let data;
      try {
        const resp = await axios.get(apiUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Referer': buildWatchUrl(subdomain, id, null, ep, sv, lang),
          },
          timeout: 6_000,
          httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        });
        data = resp.data;
      } catch {
        continue;
      }

      const server = data?.server;
      if (data?.ok && server?.available) {
        // playUrl = CDN langsung; proxyUrl = proxy dramafren (fallback kalau CDN diblok)
        const qualities = Array.isArray(server.qualities) ? server.qualities : [];
        const bestQuality = qualities
          .map(q => ({ url: q.url, res: parseInt(String(q.quality || '').match(/(\d+)/)?.[1] || '0', 10) }))
          .filter(q => q.url)
          .sort((a, b) => b.res - a.res)[0];
        return {
          videoUrl: bestQuality?.url || server.playUrl || server.proxyUrl || null,
          subtitleUrl: server.subtitleUrl || server.caption?.url || null,
          title: null,
        };
      }
      if (data) break; // jawaban valid tapi unavailable → coba host berikutnya
    }
  }
  return { videoUrl: null, subtitleUrl: null, title: null };
}

/**
 * Get the video URL (and optional subtitle URL) for a single episode.
 * Tries the subdomain's direct JSON API first (fast, fresh URL), then falls
 * back to FlareSolverr watch-page scraping with sv fallback.
 *
 * @param {string} subdomain  e.g. "stardusttv"
 * @param {string|number} id  Drama ID
 * @param {string} slug       Drama slug  e.g. "cinta-dan-peluru-semua-untuknya"
 * @param {string|number} ep  Episode number
 * @param {number} sv         Server preference (1 or 2)
 * @param {string} lang       Language code (default "id")
 * @returns {Promise<{ videoUrl: string|null, subtitleUrl: string|null, title: string|null, episode: number, server: number }>}
 */
async function getVideoUrl(subdomain, id, slug, ep, sv = 1, lang = 'id', session) {
  if (VIDEO_SERVER_API_HOSTS[subdomain]) {
    for (const s of [sv, ...[1, 2, 3].filter(x => x !== sv)]) {
      const r = await getVideoUrlViaApi(subdomain, id, ep, s, lang);
      if (r.videoUrl) {
        return { ...r, server: s, episode: Number(ep) };
      }
    }
    logger.info({ subdomain, id, ep }, 'Direct API miss, falling back to FlareSolverr');
  }

  let result = { videoUrl: null, subtitleUrl: null, title: null };
  let bestServer = 0;

  for (const s of [1, 2, 3]) {
    if (bestServer) break;
    const url = buildWatchUrl(subdomain, id, slug, ep, s, lang);
    const r = await interceptVideoUrl(url, { session });
    if (r.videoUrl) {
      result = r;
      bestServer = s;
    }
    // Session kena challenge timeout → server lain (session sama) bakal timeout juga
    if (r.timeout) {
      result.timeout = true;
      break;
    }
  }

  result.server = bestServer || sv;
  result.episode = Number(ep);
  return result;
}

/**
 * Scrape the drama detail page to get an array of all episode info objects.
 * Falls back to a simple axios fetch + regex parse if Puppeteer is not needed.
 *
 * @param {string} subdomain  e.g. "stardusttv"
 * @param {string|number} id  Drama ID
 * @param {string} slug       Drama slug
 * @param {string} lang       Language code (default "id")
 * @returns {Promise<Array<{ ep: number, url: string }>>}
 */
async function getAllEpisodes(subdomain, id, slug, lang = 'id', session) {
  const detailUrl = buildDetailUrl(subdomain, id, slug, lang);

  let html;
  try {
    // Coba pakai session dulu jika ada (untuk bypass CF di netshort dkk), fallback sessionless
    try {
      html = await fetchPageHtml(detailUrl, session || null);
      // Jika balikan masih generik Cloudflare, coba lagi dengan session fresh
      if (html && html.includes('Just a moment') && !session) {
        html = await fetchPageHtml(detailUrl, null);
      }
    } catch {
      html = await fetchPageHtml(detailUrl, session || null);
    }
  } catch (err) {
    throw err;
  }

  // Extract metadata from og tags
  const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  const ogDesc = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
  const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);

  let rawTitle = ogTitle?.[1]?.replace(/ - .*$/, '').trim() || null;
  if (rawTitle) rawTitle = decodeHtmlEntities(rawTitle);
  // Filter judul generik (hasil Cloudflare / player fallback) — jangan pakai NetShort Player dkk
  const genericRe = /^(netshort|player|dramafren|watch|detail)$/i;
  if (rawTitle && (genericRe.test(rawTitle) || /player/i.test(rawTitle) && rawTitle.length < 30)) {
    rawTitle = null;
  }
  const meta = {
    title: rawTitle,
    synopsis: ogDesc?.[1]?.trim() || null,
    poster: ogImage?.[1] || null,
  };

  const episodes = [];

  // Strategy 1: look for watch links with ep= parameter
  const watchLinkRegex = /index\.php\?[^"']*page=watch[^"']*ep=(\d+)[^"']*/g;
  const seen = new Set();
  let match;

  while ((match = watchLinkRegex.exec(html)) !== null) {
    const urlEp = Number(match[1]);
    if (!seen.has(urlEp)) {
      seen.add(urlEp);
      episodes.push({
        urlEp,
        url: buildWatchUrl(subdomain, id, slug, urlEp, 1, lang),
      });
    }
  }

  // Normalize: if first episode is 0, add 1 for display
  const minEp = episodes.length ? Math.min(...episodes.map(e => e.urlEp)) : 0;
  const epOffset = minEp === 0 ? 1 : 0;

  episodes.forEach(e => { e.ep = e.urlEp + epOffset; });
  episodes.sort((a, b) => a.ep - b.ep);

  // Strategy 2: look for data attributes or JS arrays listing episode numbers
  if (episodes.length === 0) {
    const epNumRegex = /["']?ep["']?\s*[:=]\s*["']?(\d+)["']?/g;
    while ((match = epNumRegex.exec(html)) !== null) {
      const urlEp = Number(match[1]);
      if (!seen.has(urlEp) && urlEp < 10_000) {
        seen.add(urlEp);
        episodes.push({
          urlEp,
          ep: urlEp + (minEp === 0 ? 1 : 0),
          url: buildWatchUrl(subdomain, id, slug, urlEp, 1, lang),
        });
      }
    }
  }

  episodes.sort((a, b) => a.ep - b.ep);

  return { episodes, meta };
}

module.exports = { getVideoUrl, getAllEpisodes, buildWatchUrl, buildDetailUrl, destroySession };
