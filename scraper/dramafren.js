/**
 * dramafren.js
 * Scrapes video URLs from dramafren.org watch pages.
 * Uses FlareSolverr without sessions (sessionless = more reliable, slower).
 */

const axios = require('axios');
const { logger } = require('./logger');

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://127.0.0.1:8191';

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}

// Patterns that identify a video stream URL
const VIDEO_PATTERNS = [
  /\.mp4(\?|$)/i,
  /\.m3u8(\?|$)/i,
  /\/stream\//i,
  /\/hls[\?/]/i,
  /\/vod[\?/]/i,
  /cdn.*\.(mp4|m3u8)/i,
  /\/api\/.*\?id=/i,
  /\.mp4\?/i,
  /\/video\//i,
  /proxy_stream/i,
  /mime_type=video_/i,
  /awscdn\.netshort\.com/i,
];

// Patterns that identify subtitle/caption URLs
const SUBTITLE_PATTERNS = [
  /\.vtt(\?|$)/i,
  /\.srt(\?|$)/i,
  /subtitle/i,
  /caption/i,
  /texttrack/i,
  /\/api\/.*\?.*sub/i,
];

function isVideoUrl(url) {
  return VIDEO_PATTERNS.some((p) => p.test(url));
}

function isSubtitleUrl(url) {
  return SUBTITLE_PATTERNS.some((p) => p.test(url));
}

async function createSession() {
  try {
    const resp = await axios.post(`${FLARESOLVERR_URL}/v1`, {
      cmd: 'sessions.create',
    }, { timeout: 10000 });
    return resp.data?.session || null;
  } catch {
    return null;
  }
}

async function destroySession(session) {
  if (!session) return;
  try {
    await axios.post(`${FLARESOLVERR_URL}/v1`, {
      cmd: 'sessions.destroy',
      session,
    }, { timeout: 5000 });
  } catch {}
}

async function cleanupStaleSessions() {}

/**
 * Scrape video URL from a watch page via FlareSolverr (sessionless).
 * Retries once on failure.
 */
async function interceptVideoUrl(watchUrl, { timeoutMs = 60_000, _isRetry = false, session } = {}) {
  const result = { videoUrl: null, subtitleUrl: null, title: null, timeout: false };

  let resp;
  try {
    const body = {
      cmd: 'request.get',
      url: watchUrl,
      maxTimeout: timeoutMs,
    };
    if (session) body.session = session;
    resp = await axios.post(`${FLARESOLVERR_URL}/v1`, body, { timeout: timeoutMs + 30000 });
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    const isTimeout = status === 500 && /Timeout after|solving the challenge/i.test(body?.message || '');
    logger.warn({ err: err.message, status, url: watchUrl }, 'FlareSolverr request error');
    if (body) logger.warn({ responseBody: JSON.stringify(body).slice(0, 500) }, 'FlareSolverr response');
    if (!_isRetry) {
      const retry = await interceptVideoUrl(watchUrl, { timeoutMs, _isRetry: true });
      if (isTimeout && !retry.videoUrl) retry.timeout = true;
      return retry;
    }
    if (isTimeout) result.timeout = true;
    return result;
  }

  if (resp.data?.status !== 'ok') {
    const errMsg = resp.data?.message || 'unknown';
    const isTimeout = /Timeout after|solving the challenge/i.test(errMsg);
    logger.warn({ errMsg, url: watchUrl }, 'FlareSolverr status not ok');
    if (!_isRetry) {
      const retry = await interceptVideoUrl(watchUrl, { timeoutMs, _isRetry: true });
      if (isTimeout && !retry.videoUrl) retry.timeout = true;
      return retry;
    }
    if (isTimeout) result.timeout = true;
    return result;
  }

  const html = resp.data.solution?.response || '';

  // Extract title
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  result.title = titleMatch?.[1]?.replace(/ - .*$/, '').trim() || null;
  if (result.title) result.title = decodeHtmlEntities(result.title);

  // Strategy 0: Decode base64 encryptedSrc (stardusttv new player format)
  const encSrcMatch = html.match(/const encryptedSrc\s*=\s*"([A-Za-z0-9+/=]+)"/);
  if (encSrcMatch) {
    try {
      const decoded = Buffer.from(encSrcMatch[1], 'base64').toString('utf-8');
      if (isVideoUrl(decoded)) {
        result.videoUrl = decoded;
      }
    } catch {}
  }

  // Strategy 1: Decode base64 hash64 from availableQualities
  const hash64Match = html.match(/"hash64"\s*:\s*"([A-Za-z0-9+/=]+)"/);
  if (hash64Match) {
    try {
      const decoded = Buffer.from(hash64Match[1], 'base64').toString('utf-8');
      if (isVideoUrl(decoded)) {
        result.videoUrl = decoded;
      }
    } catch {}
  }

  // Strategy 1b: Parse availableQualities JSON — pilih resolusi tertinggi
  if (!result.videoUrl) {
    const aqMatch = html.match(/availableQualities\s*=\s*(\[[\s\S]*?\]);/);
    if (aqMatch) {
      try {
        const qualities = JSON.parse(aqMatch[1].replace(/\\\//g, '/'));
        let best = null, bestRes = 0;
        for (const q of qualities) {
          if (!q.url || !isVideoUrl(q.url)) continue;
          const res = parseInt((q.label || q.quality || '').match(/(\d+)/)?.[1], 10) || 0;
          if (res >= bestRes) { bestRes = res; best = q; }
        }
        if (best) result.videoUrl = best.url;
      } catch {}
    }
  }

  // Extract subtitle URL from HTML (always runs, independent of video strategy)
  const allUrls = html.match(/https?:\/\/[^"'\s<>]+/g) || [];
  for (const url of allUrls) {
    if (!result.subtitleUrl && isSubtitleUrl(url)) {
      result.subtitleUrl = url;
      break;
    }
  }

  // Strategy 2: Extract video URLs from HTML source
  if (!result.videoUrl) {
    for (const url of allUrls) {
      if (isVideoUrl(url)) {
        result.videoUrl = url;
        break;
      }
    }
  }

  // Strategy 3: Check for video element src
  // <video src> is definitively a video URL — skip isVideoUrl() check, just decode entities
  if (!result.videoUrl) {
    const videoMatch = html.match(/<video[^>]*\ssrc=["']([^"']+)["']/i) ||
                       html.match(/<video[^>]*\sdata-src=["']([^"']+)["']/i);
    if (videoMatch && videoMatch[1] && !videoMatch[1].startsWith('blob:')) {
      result.videoUrl = videoMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    }
  }

  // Strategy 4: Parse videoServers JSON from script tag
  if (!result.videoUrl) {
    const vsMatch = html.match(/videoServers\s*=\s*(\[[\s\S]*?\]);/);
    if (vsMatch) {
      try {
        const servers = JSON.parse(vsMatch[1].replace(/\\\//g, '/'));
        for (const server of servers) {
          if (server.playUrl && isVideoUrl(server.playUrl)) {
            result.videoUrl = server.playUrl;
            break;
          }
          if (server.fallbackUrl && isVideoUrl(server.fallbackUrl)) {
            result.videoUrl = server.fallbackUrl;
            break;
          }
          if (server.proxyUrl && isVideoUrl(server.proxyUrl)) {
            result.videoUrl = server.proxyUrl;
            break;
          }
          if (server.qualities?.length) {
            let best = null, bestRes = 0;
            for (const q of server.qualities) {
              if (!q.url || !isVideoUrl(q.url)) continue;
              const res = parseInt((q.label || q.quality || '').match(/(\d+)/)?.[1], 10) || 0;
              if (res >= bestRes) { bestRes = res; best = q; }
            }
            if (best) { result.videoUrl = best.url; break; }
          }
        }
      } catch {}
    }
  }

  // Extract subtitle from videoServers (even if videoUrl already found)
  if (!result.subtitleUrl) {
    const vsMatch = html.match(/videoServers\s*=\s*(\[[\s\S]*?\]);/);
    if (vsMatch) {
      try {
        const servers = JSON.parse(vsMatch[1].replace(/\\\//g, '/'));
        for (const server of servers) {
          if (server.subtitleUrl) {
            result.subtitleUrl = server.subtitleUrl;
            break;
          }
          if (server.caption) {
            result.subtitleUrl = typeof server.caption === 'string' ? server.caption : server.caption.url;
            if (result.subtitleUrl) break;
          }
          if (server.captions?.length) {
            for (const c of server.captions) {
              const url = c.url || c;
              if (url && typeof url === 'string') {
                result.subtitleUrl = url;
                break;
              }
            }
            if (result.subtitleUrl) break;
          }
        }
      } catch {}
    }
  }

  // Decode HTML entities in URLs (e.g. &amp; → &) from any strategy
  if (result.videoUrl) {
    result.videoUrl = result.videoUrl
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');
  }
  if (result.subtitleUrl) {
    result.subtitleUrl = result.subtitleUrl
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  // Kalau session gagal dapet video, retry tanpa session (session bisa rusak)
  if (!result.videoUrl && session && !_isRetry) {
    const retry = await interceptVideoUrl(watchUrl, { timeoutMs, _isRetry: true, session: null });
    if (retry.videoUrl) result.videoUrl = retry.videoUrl;
    if (!result.subtitleUrl && retry.subtitleUrl) result.subtitleUrl = retry.subtitleUrl;
    if (retry.timeout) result.timeout = true;
  }

  return result;
}

module.exports = { interceptVideoUrl, createSession, destroySession, cleanupStaleSessions, decodeHtmlEntities };
