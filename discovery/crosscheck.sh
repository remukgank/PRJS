#!/usr/bin/env node
const fs = require('fs');

const dir = __dirname;
const newFiles = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('_new'));

function extractIdsFromMd(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  return [...new Set([...content.matchAll(/id=([^&\s]+)/g)].map(m => m[1]))];
}

function extractReelFrenIds(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  // ReelFren tracking files use /drama/{provider}/{id}-{slug} format
  return [...new Set([...content.matchAll(/\/drama\/[^/]+\/([^\s?]+)/g)].map(m => m[1]))];
}

for (const nf of newFiles) {
  const sub = nf.replace('.json', '');
  let mdPath;
  let isReelFren = false;

  if (['flickreels', 'shortmax', 'reelshort', 'netshort', 'stardusttv'].includes(sub)) {
    mdPath = '/home/runner/workspace/scraper/' + sub + '.md';
  } else if (sub === 'dramabite') {
    mdPath = '/home/runner/workspace/dramabite.md';
  } else if (sub === 'dramabox') {
    mdPath = '/home/runner/workspace/drama_indonesia.txt';
  } else if (sub.startsWith('reelfren_')) {
    // ReelFren per-provider: reelfren_happyshort.json -> reelfren_happyshort.md
    const provider = sub.replace('reelfren_', '');
    mdPath = '/home/runner/workspace/scraper/reelfren_' + provider + '.md';
    isReelFren = true;
  } else if (sub === 'reelfren') {
    // Full ReelFren scan (all providers)
    mdPath = '/home/runner/workspace/scraper/reelfren.md';
    isReelFren = true;
  } else { continue; }

  const scanData = JSON.parse(fs.readFileSync(dir + '/' + nf, 'utf8'));
  const existing = isReelFren ? extractReelFrenIds(mdPath) : extractIdsFromMd(mdPath);
  const scannedIds = isReelFren
    ? new Set(scanData.map(d => d.full_id || d.id))
    : new Set(scanData.map(d => d.id));
  const newItems = scanData.filter(d => {
    const checkId = isReelFren ? (d.full_id || d.id) : d.id;
    return !existing.includes(checkId);
  });
  const missing = existing.filter(id => !scannedIds.has(id));

  console.log(sub + ':');
  console.log('  existing=' + existing.length + ' scan=' + scanData.length + ' new=' + newItems.length + ' missing=' + missing.length);
  if (newItems.length > 0) {
    newItems.slice(0, 5).forEach(d => console.log('    ' + (d.full_id || d.id) + ' - ' + d.title));
    fs.writeFileSync(dir + '/' + sub + '_new.json', JSON.stringify(newItems, null, 2));
  }
  if (missing.length > 10) console.log('  ⚠️  ' + missing.length + ' IDs di md tapi ga ke-scan (pagination?)');
}
