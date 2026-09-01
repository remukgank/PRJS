#!/usr/bin/env node
const fs = require('fs');

const dir = __dirname;
const newFiles = fs.readdirSync(dir).filter(f => f.endsWith('_new.json'));

function sortItems(arr, isHex) {
  if (isHex) return arr.sort((a, b) => a.id.localeCompare(b.id));
  return arr.sort((a, b) => {
    const diff = BigInt(a.id) - BigInt(b.id);
    return diff < 0n ? -1 : diff > 0n ? 1 : 0;
  });
}

function cleanTitle(raw) {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/🔥\s*\d+/g, '')
    .replace(/Eps:\s*\d+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*(Balas Dendam|Plot Twist|Kerajaan &amp; Bangsawan|Manis|Naga|Penuh Semangat|Salah Paham|​​)\s*/g, ' ')
    .trim()
    .replace(/^[\s,]+|[\s,]+$/g, '');
}

function slugify(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

const fileMap = {
  flickreels: '/home/runner/workspace/scraper/flickreels.md',
  shortmax: '/home/runner/workspace/scraper/shortmax.md',
  reelshort: '/home/runner/workspace/scraper/reelshort.md',
  netshort: '/home/runner/workspace/scraper/netshort.md',
  stardusttv: '/home/runner/workspace/scraper/stardusttv.md',
  dramabite: '/home/runner/workspace/dramabite.md',
  dramabox: '/home/runner/workspace/drama_indonesia.txt',
};

// ReelFren providers use a separate tracking file per provider
const reelfrenDir = '/home/runner/workspace/scraper';

for (const nf of newFiles) {
  const sub = nf.replace('_new.json', '');

  // Handle ReelFren providers (reelfren_happyshort_new.json -> happyshort)
  const isReelFren = sub.startsWith('reelfren_');
  const provider = isReelFren ? sub.replace('reelfren_', '') : sub;

  let filePath;
  if (isReelFren) {
    filePath = `${reelfrenDir}/reelfren_${provider}.md`;
  } else {
    filePath = fileMap[sub];
  }

  // Create tracking file if it doesn't exist (ReelFren)
  if (!fs.existsSync(filePath)) {
    if (isReelFren) {
      // Create initial tracking file
      const header = `# Daftar Drama di reelfren.dramafren.org (${provider})\n\n**Total: 0 drama**\n\n| # | Judul | Link |\n|---|-------|------|\n`;
      fs.writeFileSync(filePath, header);
      console.log(`${sub}: created new tracking file`);
    } else {
      console.log(sub + ': skip');
      continue;
    }
  }

  const newItems = JSON.parse(fs.readFileSync(dir + '/' + nf, 'utf8'));
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n');

  const existingIds = new Set();
  let lastNum = 0;
  for (const line of lines) {
    // Table format: | N | Title | URL |
    const tableM = line.match(/^\|\s*(\d+)\s*\|/);
    // Numbered list format: N. URL
    const listM = line.match(/^(\d+)\.\s/);
    const m = tableM || listM;
    if (m) {
      lastNum = Math.max(lastNum, parseInt(m[1]));
      // For ReelFren, extract full_id from /drama/{provider}/{full_id}
      const reelfrenIdMatch = line.match(/\/drama\/[^/]+\/([^\s?]+)/);
      const idMatch = reelfrenIdMatch || line.match(/id=([^&\s]+)/);
      if (idMatch) existingIds.add(idMatch[1]);
    }
  }

  const trulyNew = newItems.filter(d => {
    const checkId = isReelFren ? (d.full_id || d.id) : d.id;
    return !existingIds.has(checkId);
  });
  if (!trulyNew.length) { console.log(sub + ': no new'); continue; }

  const sorted = sortItems(trulyNew, sub === 'reelshort');
  let num = lastNum;
  const rows = sorted.map(d => {
    num++;
    const title = cleanTitle(d.title).replace(/&/g, '&amp;');
    if (isReelFren) {
      const fullId = d.full_id || d.id;
      const url = `https://reelfren.dramafren.org/drama/${provider}/${fullId}?lang=id`;
      return `| ${num} | ${title} | ${url} |`;
    }
    if (sub === 'dramabox') {
      const slug = slugify(cleanTitle(d.title));
      const url = `https://${sub}.dramafren.org/index.php?page=detail&id=${d.id}&lang=in&slug=${slug}`;
      return `${num}. ${url}`;
    }
    let url = `https://${sub}.dramafren.org/index.php?page=detail&id=${d.id}`;
    if (sub === 'reelshort') { /* no lang */ }
    else url += '&lang=id';
    return `| ${num} | ${title} | ${url} |`;
  });

  const newTotal = lastNum + trulyNew.length;
  let updated;
  if (sub === 'dramabox') {
    updated = content.replace(/Daftar \d+ Drama/, `Daftar ${newTotal} Drama`);
    updated = updated.trimEnd() + '\n' + rows.join('\n') + '\n';
  } else {
    updated = content.replace(/\*\*Total: \d+ drama\*\*/, `**Total: ${newTotal} drama**`);
    updated = updated.trimEnd() + '\n' + rows.join('\n') + '\n';
  }

  fs.writeFileSync(filePath, updated);
  console.log(`${sub}: +${trulyNew.length} (#${lastNum + 1}-#${num}) total=${newTotal}`);
}
