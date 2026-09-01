#!/usr/bin/env node
// scan-6.js — salinan logika scan.sh, domain dibatasi 6 subdomain (tanpa dramabite)
const fs = require('fs');
const axios = require('axios');

const keywords = ['cinta','hati','raja','ratu','aku','kamu','dos','mimpi','istri','suami','ayah','ibu','putri','selingkuh','dendam','bidadari','mawar','bulan','matahari'];

// 6 subdomain + lang
const domains = [
  ['flickreels','id'], ['shortmax','id'], ['stardusttv','id'],
  ['dramabox','in'], ['netshort','id'], ['reelshort','id'],
];

(async () => {
  const sr = await axios.post('http://127.0.0.1:8191/v1', { cmd: 'sessions.create' }, { timeout: 10000 });
  const session = sr.data?.session;
  console.log('Session:', session?.slice(0,8));

  for (const [sub, lang] of domains) {
    const allIds = new Map();
    for (const kw of keywords) {
      try {
        const url = `https://${sub}.dramafren.org/index.php?page=search_result&q=${kw}&lang=${lang}`;
        const resp = await axios.post('http://127.0.0.1:8191/v1', {
          cmd: 'request.get', url, session, maxTimeout: 20000,
        }, { timeout: 40000 });
        const html = resp.data?.solution?.response || '';

        // Match ALL detail links (with or without &lang, with or without &slug)
        const links = [...html.matchAll(/<a[^>]*href="([^"]*detail[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
        for (const link of links) {
          const href = link[1];
          const title = link[2].replace(/<[^>]+>/g, '').trim();
          const idMatch = href.match(/id=([^&]+)/);
          if (idMatch) {
            const id = idMatch[1];
            const langMatch = href.match(/lang=(\w+)/);
            const itemLang = langMatch ? langMatch[1] : 'id'; // default id jika tidak ada
            if (itemLang === lang && !allIds.has(id)) {
              allIds.set(id, title || '?');
            }
          }
        }
        process.stdout.write(`${sub.slice(0,4)}:${kw.slice(0,3)}=${links.length} `);
      } catch (e) {
        process.stdout.write(`${sub.slice(0,4)}:${kw.slice(0,3)}=ERR `);
      }
    }
    console.log(`\n${sub}: ${allIds.size} unique\n`);
    fs.writeFileSync(__dirname + '/' + sub + '.json', JSON.stringify([...allIds.entries()].map(([id, title]) => ({ id, title })), null, 2));
  }

  await axios.post('http://127.0.0.1:8191/v1', { cmd: 'sessions.destroy', session }, { timeout: 5000 });
  console.log('\nDone! Results in discovery/');
})();
