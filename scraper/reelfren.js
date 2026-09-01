/**
 * reelfren.js
 * Scrapes video URLs from reelfren.dramafren.org (multi-provider aggregator).
 *
 * ReelFren aggregates drama from 16+ providers via a clean JSON API.
 * The API lives on api.dramafren.org (NOT reelfren.dramafren.org).
 * Instead of scraping HTML watch pages, we call /api/video directly.
 *
 * API flow:
 *   1. GET https://api.dramafren.org/api/video?provider={p}&id={id}&ep={ep}&lang={lang}&server={sv}&cv=v21
 *      - id = SHORT ID (without slug), e.g. "xvP6Va" not "xvP6Va-wukong-kembali"
 *   2. Response: { videoUrl, qualityList[], totalEpisodes, locked, sourceServer }
 *   3. videoUrl may be proxied: /api/proxy/{provider}?url={encoded_url}
 *   4. Follow proxy to get the actual mp4/m3u8 URL
 *
 * Known providers: happyshort, melolo, kalostv, sereal, pinedrama, dramanova,
 *   reelife, golddrama, cubetv, joyreels, bstation, vibeshort, wetv,
 *   storyreel, moviebox, movieboxshorts, freereels, anyreel, shorten, mydrama
 */

const axios = require('axios');
const { logger } = require('./logger');

const API_BASE = 'https://api.dramafren.org';
const WEB_BASE = 'https://reelfren.dramafren.org';
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191';

/**
 * Parse a ReelFren drama URL into its components.
 * Supported formats:
 *   https://reelfren.dramafren.org/drama/{provider}/{id}-{slug}?lang=id
 *   https://reelfren.dramafren.org/watch/{provider}/{id}-{slug}?ep=1&lang=id
 *
 * @returns {{ provider: string, id: string, fullId: string, slug: string, ep: number, lang: string } | null}
 */
function parseReelFrenUrl(text) {
  const m = text.match(/reelfren\.dramafren\.org\/(drama|watch)\/([^/]+)\/([^?&\s]+)/i);
  if (!m) return null;

  const provider = m[2];
  const idSlug = m[3];
  const url = new URL(text.includes('http') ? text : `https://reelfren.dramafren.org${m[0]}`);

  const dashIdx = idSlug.indexOf('-');
  const id = dashIdx > 0 ? idSlug.substring(0, dashIdx) : idSlug;
  const slug = dashIdx > 0 ? idSlug.substring(dashIdx + 1) : '';

  return {
    provider,
    id,
    fullId: idSlug,
    slug,
    ep: Number(url.searchParams.get('ep') || 1),
    lang: url.searchParams.get('lang') || 'id',
  };
}

/**
 * Create a FlareSolverr session.
 */
async function createSession() {
  try {
    const resp = await axios.post(`${FLARESOLVERR_URL}/v1`, { cmd: 'sessions.create' }, { timeout: 10000 });
    return resp.data?.session || null;
  } catch {
    return null;
  }
}

/**
 * Destroy a FlareSolverr session.
 */
async function destroySession(session) {
  if (!session) return;
  try {
    await axios.post(`${FLARESOLVERR_URL}/v1`, { cmd: 'sessions.destroy', session }, { timeout: 5000 });
  } catch {}
}

/**
 * Fetch a page via FlareSolverr (with Cloudflare bypass).
 * Returns the HTML response string.
 */
async function flareGet(url, session, timeoutMs = 30000) {
  const body = { cmd: 'request.get', url, maxTimeout: timeoutMs };
  if (session) body.session = session;
  const resp = await axios.post(`${FLARESOLVERR_URL}/v1`, body, { timeout: timeoutMs + 30000 });
  if (resp.data?.status !== 'ok') {
    throw new Error(resp.data?.message || 'FlareSolverr: not ok');
  }
  return resp.data.solution?.response || '';
}

/**
 * Resolve a proxied video URL to the actual mp4/m3u8 URL.
 * ReelFren proxies some video URLs through /api/proxy/{provider}?url={encoded}.
 * If the URL is not a proxy URL, return it as-is.
 */
function resolveProxyUrl(videoUrl) {
  if (!videoUrl) return null;

  // Check if it's a proxy URL
  const proxyMatch = videoUrl.match(/^\/api\/proxy\/([^?]+)\?url=(.+)$/);
  if (proxyMatch) {
    try {
      return decodeURIComponent(proxyMatch[2]);
    } catch {
      return videoUrl;
    }
  }

  return videoUrl;
}

/**
 * Get video data for a single episode via the ReelFren API.
 *
 * @param {string} provider  Provider name (e.g. "happyshort")
 * @param {string} fullId    Full drama ID (e.g. "341100-pertemuan-pertama-cinta-sejati")
 *                           Only the short ID part is sent to the API.
 * @param {number} ep        Episode number
 * @param {string} lang      Language code
 * @param {number} server    Server number (1-4)
 * @param {object} [opts]    Options
 * @param {string} [opts.session]  FlareSolverr session (optional — API usually doesn't need it)
 * @param {boolean} [opts.resolveProxy]  Whether to resolve proxy URLs (default true)
 * @returns {Promise<{ videoUrl: string|null, title: string|null, episode: number, totalEpisodes: number, locked: boolean, server: number }>}
 */
async function getReelFrenVideo(provider, fullId, ep, lang = 'id', server = 1, opts = {}) {
  // API needs the SHORT ID (without slug)
  const shortId = String(fullId).split('-')[0];
  const params = new URLSearchParams({
    provider,
    id: shortId,
    ep: String(ep),
    lang,
    server: String(server),
    cv: 'v21',
  });
  const apiUrl = `${API_BASE}/api/video?${params}`;

  let data;
  try {
    // Try direct axios first (API is not behind Cloudflare challenge)
    const resp = await axios.get(apiUrl, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
        'Origin': 'https://reelfren.dramafren.org',
      },
      timeout: 20000,
    });
    data = resp.data;
  } catch (err) {
    // Fallback: try via FlareSolverr (some providers may need it)
    try {
      const html = await flareGet(apiUrl, opts.session, 20000);
      const jsonMatch = html.match(/<pre>([\s\S]*?)<\/pre>/);
      if (jsonMatch) data = JSON.parse(jsonMatch[1]);
      else if (html.trim().startsWith('{')) data = JSON.parse(html);
    } catch (err2) {
      logger.warn({ provider, fullId, ep, err: err.message, err2: err2.message }, 'ReelFren API request failed');
      return { videoUrl: null, title: null, episode: ep, totalEpisodes: 0, locked: false, server };
    }
  }

  if (!data || typeof data !== 'object') {
    logger.warn({ provider, fullId, ep }, 'ReelFren API: invalid response');
    return { videoUrl: null, title: null, episode: ep, totalEpisodes: 0, locked: false, server };
  }

  let videoUrl = data.videoUrl || null;
  if (videoUrl && opts.resolveProxy !== false) {
    videoUrl = resolveProxyUrl(videoUrl);
  }

  // Also extract subtitle URL if present
  let subtitleUrl = null;
  if (data.subtitles?.length) {
    subtitleUrl = data.subtitles[0].url;
    if (subtitleUrl && opts.resolveProxy !== false) {
      subtitleUrl = resolveProxyUrl(subtitleUrl);
    }
  }

  return {
    videoUrl,
    subtitleUrl,
    title: data.title || null,
    episode: data.episodeNumber || ep,
    totalEpisodes: data.totalEpisodes || 0,
    locked: data.locked || false,
    server: data.sourceServer ? Number(data.sourceServer) : server,
  };
}

/**
 * Get video data for a single episode, trying multiple servers.
 *
 * @param {string} provider
 * @param {string} fullId
 * @param {number} ep
 * @param {string} lang
 * @param {object} [opts]
 * @returns {Promise<{ videoUrl: string|null, ... }>}
 */
async function getVideoUrlReelFren(provider, fullId, ep, lang = 'id', opts = {}) {
  for (const server of [1, 2, 3, 4]) {
    const result = await getReelFrenVideo(provider, fullId, ep, lang, server, opts);
    if (result.videoUrl) return result;
    // Backend 502 → stop trying other servers
    if (!result.videoUrl && !result.totalEpisodes && !result.locked) break;
  }
  return { videoUrl: null, title: null, episode: ep, totalEpisodes: 0, locked: false, server: 1 };
}

/**
 * Fetch drama metadata via the API (api.dramafren.org/api/detail) — no Cloudflare,
 * no FlareSolverr needed. Returns title, cover, intro, episode list.
 *
 * @returns {Promise<{ title: string|null, synopsis: string|null, poster: string|null, totalEpisodes: number, videos: Array }>}
 */
async function getDramaDetail(provider, fullId, lang = 'id', opts = {}) {
  const shortId = String(fullId).split('-')[0];
  const params = new URLSearchParams({ provider, id: shortId, lang });
  const apiUrl = `${API_BASE}/api/detail?${params}`;

  // Retry untuk 502/503/429 (transient), plus fallback via FlareSolverr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await axios.get(apiUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
          'Origin': 'https://reelfren.dramafren.org',
        },
        timeout: 20000,
        validateStatus: (s) => s < 500, // 502/503 jangan throw langsung, handle retry di bawah
      });
      if (resp.status >= 500) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const d = resp.data;
      if (!d || typeof d !== 'object') {
        return { title: null, synopsis: null, poster: null, totalEpisodes: 0, videos: [] };
      }
      return {
        title: d.title || null,
        synopsis: d.intro || null,
        poster: d.cover || null,
        totalEpisodes: Number(d.episodes) || 0,
        videos: Array.isArray(d.videos) ? d.videos : [],
      };
    } catch (err) {
      const isRetryable = /502|503|429|timeout|ECONN/.test(err.message) || err.code === 'ECONNRESET';
      if (isRetryable && attempt < 3) {
        const delay = attempt * 2000;
        logger.warn({ provider, fullId, attempt, err: err.message }, `Detail API retry ${attempt}/3`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      // Fallback via FlareSolverr sebelum menyerah (API kadang butuh bypass CF)
      try {
        const html = await flareGet(apiUrl, opts.session, 20000);
        const jsonMatch = html.match(/<pre>([\s\S]*?)<\/pre>/);
        let d;
        if (jsonMatch) d = JSON.parse(jsonMatch[1]);
        else if (html.trim().startsWith('{')) d = JSON.parse(html);
        if (d && typeof d === 'object') {
          return {
            title: d.title || null,
            synopsis: d.intro || null,
            poster: d.cover || null,
            totalEpisodes: Number(d.episodes) || 0,
            videos: Array.isArray(d.videos) ? d.videos : [],
          };
        }
      } catch {}
      logger.warn({ provider, fullId, err: err.message }, 'Detail API request failed');
      return { title: null, synopsis: null, poster: null, totalEpisodes: 0, videos: [] };
    }
  }
  return { title: null, synopsis: null, poster: null, totalEpisodes: 0, videos: [] };
}

/**
 * Fetch drama page metadata (title, synopsis, poster) — API-first,
 * falls back to FlareSolverr drama page scrape (kept for resilience).
 *
 * @returns {Promise<{ title: string|null, synopsis: string|null, poster: string|null }>}
 */
async function getDramaMeta(provider, fullId, lang = 'id', opts = {}) {
  const detail = await getDramaDetail(provider, fullId, lang, opts);
  if (detail.title) return detail;
  return scrapeDramaPage(provider, fullId, lang, opts);
}

/**
 * Fetch drama page metadata via FlareSolverr (fallback when API detail fails).
 * The drama page (https://reelfren.dramafren.org/drama/{provider}/{fullId})
 * has:
 *   - poster: <div class="detail-poster"><img src="...">
 *   - title:  <h1>...</h1> (in .detail-copy)
 *   - synopsis: <p>...</p> (in .detail-copy)
 * plus og:title / og:description / og:image tags as fallback.
 *
 * @returns {Promise<{ title: string|null, synopsis: string|null, poster: string|null }>}
 */
async function scrapeDramaPage(provider, fullId, lang = 'id', opts = {}) {
  const dramaUrl = `${WEB_BASE}/drama/${provider}/${fullId}?lang=${lang}`;

  let html;
  try {
    html = await flareGet(dramaUrl, opts.session, 40000);
  } catch (err) {
    logger.warn({ provider, fullId, err: err.message }, 'Drama page fetch failed');
    return { title: null, synopsis: null, poster: null };
  }

  // Primary: DOM selectors from the detail page
  const posterImg = html.match(/<div class="detail-poster[^"]*">\s*<img[^>]*src="([^"]+)"/i);
  const titleH1 = html.match(/<div class="detail-copy[^"]*">[\s\S]*?<h1>([^<]+)<\/h1>/i);
  const synopsisP = html.match(/<div class="detail-copy[^"]*">[\s\S]*?<p>([\s\S]*?)<\/p>/i);

  // Fallback: og tags
  const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  const ogDesc = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
  const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);

  const decode = (s) => s
    ? s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
    : null;

  return {
    title: decode(titleH1?.[1] || ogTitle?.[1])?.replace(/\s*\|.*$/, '').trim() || null,
    synopsis: decode(synopsisP?.[1] || ogDesc?.[1]) || null,
    poster: posterImg?.[1] || ogImage?.[1] || null,
  };
}

/**
 * Get all episodes for a drama by calling /api/video for ep=1 and reading totalEpisodes.
 * Then returns episode metadata without fetching each video URL.
 *
 * Falls back to /api/detail if /api/video returns 502 (both are Cloudflare-free).
 * FlareSolverr scrape only as last resort.
 *
 * @returns {{ episodes: Array<{ ep: number, vid?: string }>, meta: { title: string|null, synopsis: string|null, poster: string|null, totalEpisodes: number } }}
 */
async function getAllEpisodesReelFren(provider, fullId, lang = 'id', opts = {}) {
  const result = await getReelFrenVideo(provider, fullId, 1, lang, 1, opts);

  let episodes = [];
  let totalEpisodes = result.totalEpisodes;

  if (result.totalEpisodes) {
    for (let ep = 1; ep <= result.totalEpisodes; ep++) {
      episodes.push({ ep, urlEp: ep, url: `${WEB_BASE}/watch/${provider}/${fullId}?ep=${ep}&lang=${lang}` });
    }
    // Cross-check dengan detail API jika total curiga kecil — cegah bug 1 episode padahal 50 (shortmax 854393)
    if (totalEpisodes && totalEpisodes <= 5) {
      try {
        const detailCheck = await getDramaDetail(provider, fullId, lang, opts);
        const detailTotal = detailCheck.totalEpisodes || detailCheck.videos.length || 0;
        if (detailTotal > totalEpisodes) {
          logger.info({ provider, fullId, videoTotal: totalEpisodes, detailTotal }, 'Detail has more episodes, using detail');
          episodes = detailCheck.videos.length ? detailCheck.videos.map(v => ({
            ep: v.episode,
            urlEp: v.episode,
            vid: v.vid,
            url: `${WEB_BASE}/watch/${provider}/${fullId}?ep=${v.episode}&lang=${lang}`,
          })) : Array.from({ length: detailTotal }, (_, i) => ({ ep: i + 1, urlEp: i + 1, url: `${WEB_BASE}/watch/${provider}/${fullId}?ep=${i + 1}&lang=${lang}` }));
          totalEpisodes = detailTotal;
        }
      } catch {}
    }
  } else {
    // Fallback: /api/detail (no Cloudflare) — gives videos array with episode list
    logger.info({ provider, fullId }, 'Falling back to /api/detail for episode list');
    const detail = await getDramaDetail(provider, fullId, lang, opts);
    if (detail.videos.length) {
      episodes = detail.videos.map(v => ({
        ep: v.episode,
        urlEp: v.episode,
        vid: v.vid,
        url: `${WEB_BASE}/watch/${provider}/${fullId}?ep=${v.episode}&lang=${lang}`,
      }));
      totalEpisodes = detail.totalEpisodes || episodes.length;
    } else {
      // Last resort: scrape watch page via FlareSolverr
      logger.info({ provider, fullId }, 'Falling back to watch page scrape');
      const fallback = await scrapeWatchPage(provider, fullId, lang, opts);
      episodes = fallback.episodes;
      totalEpisodes = fallback.meta.totalEpisodes;
    }
  }

  // Enrich with drama page metadata (title, synopsis, poster) — API-first
  const dramaMeta = await getDramaMeta(provider, fullId, lang, opts);

  return {
    episodes,
    meta: {
      title: dramaMeta.title || result.title || null,
      synopsis: dramaMeta.synopsis || null,
      poster: dramaMeta.poster || null,
      totalEpisodes: totalEpisodes || episodes.length,
    },
  };
}

/**
 * Scrape the watch page to extract episode metadata from the SSR-embedded JSON.
 * This works even when /api/video returns 502, but does NOT give video URLs
 * (those are loaded client-side via /api/video).
 */
async function scrapeWatchPage(provider, fullId, lang = 'id', opts = {}) {
  const watchUrl = `${WEB_BASE}/watch/${provider}/${fullId}?ep=1&lang=${lang}`;

  let html;
  try {
    html = await flareGet(watchUrl, opts.session, 40000);
  } catch (err) {
    logger.warn({ provider, fullId, err: err.message }, 'Watch page fetch failed');
    return { episodes: [], meta: { title: null, totalEpisodes: 0 } };
  }

  // Unescape HTML entities + escaped JSON in Next.js SSR data
  const u = html.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\\?"}/g, '"}').replace(/\\"/g, '"').replace(/\\\//g, '/');

  // Extract title from <title> tag
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const title = titleMatch?.[1]?.replace(/\s*\|.*$/, '').trim() || null;

  // Extract totalEpisodes from initialVideo config
  const totalMatch = u.match(/"totalEpisodes":(\d+)/);
  const totalEpisodes = totalMatch ? parseInt(totalMatch[1]) : 0;

  // Extract videos array from SSR data
  let videos = [];
  const videosIdx = u.indexOf('"videos":[');
  if (videosIdx !== -1) {
    const arrStart = u.indexOf('[', videosIdx);
    let depth = 0;
    let arrEnd = arrStart;
    for (let i = arrStart; i < Math.min(arrStart + 100000, u.length); i++) {
      if (u[i] === '[') depth++;
      else if (u[i] === ']') depth--;
      if (depth === 0) { arrEnd = i + 1; break; }
    }
    try {
      videos = JSON.parse(u.substring(arrStart, arrEnd));
    } catch {
      logger.warn({ provider, fullId }, 'Failed to parse videos array from SSR');
    }
  }

  const episodes = videos.map(v => ({
    ep: v.episode,
    urlEp: v.episode,
    vid: v.vid,
    available: v.available,
    duration: v.duration,
    url: `${WEB_BASE}/watch/${provider}/${fullId}?ep=${v.episode}&lang=${lang}`,
  }));

  return {
    episodes: episodes.length ? episodes : (totalEpisodes
      ? Array.from({ length: totalEpisodes }, (_, i) => ({
          ep: i + 1,
          urlEp: i + 1,
          url: `${WEB_BASE}/watch/${provider}/${fullId}?ep=${i + 1}&lang=${lang}`,
        }))
      : []),
    meta: { title, totalEpisodes: totalEpisodes || episodes.length },
  };
}

module.exports = {
  parseReelFrenUrl,
  getReelFrenVideo,
  getVideoUrlReelFren,
  getAllEpisodesReelFren,
  scrapeWatchPage,
  createSession,
  destroySession,
  resolveProxyUrl,
};
