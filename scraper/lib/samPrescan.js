'use strict';

// samPrescan.js — pre-flight scan server batch Samehadaku (murni, tanpa IO Telegram).
// Sebelum unduh, resolve servers tiap episode secara paralel (concurrency tetap) lalu
// klasifikasi: viable = ep yang punya setidaknya satu host didukung (pickBestServerList).

async function scanSupportedServers(queue, resolveFn, { concurrency = 6 } = {}) {
  const scanned = new Map();
  const list = queue.slice();
  let wi = 0;
  async function worker() {
    while (wi < list.length) {
      const e = list[wi++];
      try {
        const rin = await resolveFn(e.url);
        scanned.set(e.ep, { servers: rin.servers || {}, quality: rin.quality || '' });
      } catch {
        scanned.set(e.ep, { servers: {}, quality: '' });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return scanned;
}

function viableFromScanned(queue, scanned, pickBestServerList) {
  const viable = [];
  for (const e of queue) {
    const servers = (scanned.get(e.ep) || { servers: {} }).servers || {};
    if (pickBestServerList(servers).length > 0) viable.push(e);
  }
  return viable;
}

module.exports = { scanSupportedServers, viableFromScanned };