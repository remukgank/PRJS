#!/usr/bin/env node
// scan-reelfren.js — Scrape drama list from reelfren.dramafren.org (multi-provider aggregator)
// Uses the public API (api.dramafren.org/api/home + /api/detail) — no Cloudflare, no FlareSolverr.
const fs = require('fs');
const axios = require('axios');

const API_BASE = 'https://api.dramafren.org';

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Origin': 'https://reelfren.dramafren.org',
};

(async () => {
  // Fetch home feed — api/home returns a large drama catalog
  console.log('Fetching api/home...');
  const resp = await axios.get(`${API_BASE}/api/home?lang=id&page=1`, { headers, timeout: 30000 });
  const items = resp.data?.data || [];
  console.log(`Got ${items.length} dramas`);

  // Fetch details for each drama to get full id (id-slug) + intro
  const allDramas = new Map(); // key: "provider:full_id" -> {provider, id, full_id, slug, title, synopsis, poster, url}
  let i = 0;
  for (const item of items) {
    i++;
    const provider = item.provider;
    const id = item.id;
    if (!provider || !id) continue;
    const key = `${provider}:${id}`;
    if (allDramas.has(key)) continue;

    let detail = {};
    try {
      const dr = await axios.get(`${API_BASE}/api/detail`, { params: { provider, id, lang: 'id' }, headers, timeout: 15000 });
      detail = dr.data || {};
    } catch (e) {
      process.stdout.write('.');
      continue;
    }

    const title = detail.title || item.title || '';
    const fullId = `${id}${title ? '-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : ''}`;

    allDramas.set(key, {
      provider,
      id,
      full_id: fullId,
      slug: fullId.split('-').slice(1).join('-'),
      title,
      synopsis: detail.intro || null,
      poster: detail.cover || item.cover || null,
      episodes: Number(detail.episodes) || 0,
      url: `https://reelfren.dramafren.org/drama/${provider}/${fullId}?lang=id`,
    });
    process.stdout.write(`\r  ${i}/${items.length} ${provider}:${id.slice(0, 12)}...`);
  }
  console.log('\n');

  const dramas = [...allDramas.values()];
  console.log(`Total unique dramas: ${dramas.length}`);

  // Group by provider
  const byProvider = {};
  for (const d of dramas) {
    if (!byProvider[d.provider]) byProvider[d.provider] = [];
    byProvider[d.provider].push(d);
  }

  console.log('\nProviders:');
  for (const [p, items] of Object.entries(byProvider).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${p}: ${items.length} dramas`);
  }

  // Save full dataset
  fs.writeFileSync(`${__dirname}/reelfren.json`, JSON.stringify(dramas, null, 2));

  // Save per-provider datasets
  for (const [p, items] of Object.entries(byProvider)) {
    fs.writeFileSync(`${__dirname}/reelfren_${p}.json`, JSON.stringify(items, null, 2));
  }

  // Test /api/video for each provider (check which backends are alive)
  console.log('\n=== Backend health check ===');
  const providers = Object.keys(byProvider).sort();
  for (const provider of providers) {
    const sample = byProvider[provider][0];
    const params = new URLSearchParams({
      provider,
      id: sample.full_id.split('-')[0],
      ep: '1',
      lang: 'id',
      server: '1',
      cv: 'v21',
    });
    try {
      const resp = await axios.get(`${API_BASE}/api/video?${params}`, { headers, timeout: 20000 });
      const data = resp.data;
      const status = data.videoUrl ? 'OK' : (data.locked ? 'LOCKED' : 'NO_VIDEO');
      console.log(`  ✓ ${provider}: ${status} eps=${data.totalEpisodes || '?'}`);
    } catch (e) {
      const code = e.response?.status;
      console.log(`  ✗ ${provider}: ${code || e.code} ${code === 502 ? 'Backend Down' : ''}`);
    }
  }

  console.log('\nDone! Results in discovery/reelfren*.json');
})();
