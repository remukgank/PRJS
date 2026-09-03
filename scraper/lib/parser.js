function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').trim();
}

function truncateText(t, max = 64) {
  if (t.length <= max) return t;
  let cut = t.slice(0, max - 1);
  // Jangan biarkan high surrogate menggantung di akhir (emoji 🎌/🎬 = 2 code unit)
  // — kalau terpotong di tengah, hasilnya bukan valid UTF-8 → Telegram reject.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1);
  return cut + '…';
}

function cleanCaption(name) {
  let s = name.replace(/\.(mp4|mkv|mov|avi|webm|mp3|aac|ogg|m4a|wav)$/i, '');
  s = s.replace(/^[a-zA-Z0-9]{6,10}[-_]/, '');
  s = s.replace(/[-_.]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.split(' ').filter(w => {
    if (w.length < 6 || w.length > 10) return true;
    // Hapus mixed case (e.g. "rjfBour" - random hash)
    if (/[a-z]/.test(w) && /[A-Z]/.test(w)) return false;
    // Hapus all lowercase length 6-10 (e.g. "kuronime" - source name)
    if (/^[a-z]+$/.test(w)) return false;
    return true;
  }).join(' ');
  // Parse pola kuronime "juduls{season}{episode}[v{n}]" → "judul s{season} Ep {episode}"
  s = s.replace(/\b([a-z]{4,})s(\d)(\d{1,2})(?:v\d)?\b/g, (m, t, season, ep) => `${t} s${season} Ep ${String(Number(ep))}`);
  // Parse pola kuronime part "juduls{season}prt{part}{episode}" → "judul Season {season} Part {part} Episode {episode}"
  s = s.replace(/\b([a-z]{4,})s(\d)prt(\d{1,2})(\d{2})\b/g, (m, t, season, part, ep) => `${t} Season ${season} Part ${part} Episode ${String(Number(ep))}`);
  // Parse pola kuronime tanpa season "judul{episode}" → "judul Episode {episode}"
  s = s.replace(/\b([a-z]{4,})(\d{2})\b/g, (m, t, ep) => `${t} Episode ${String(Number(ep))}`);
  // Handle "Ep15" → "Ep 15"
  s = s.replace(/\b(ep)(\d{1,3})$/gi, '$1 $2');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function parseKuronimeSeasonEpisode(fileName) {
  const base = fileName.replace(/\.(mp4|mkv|mov|avi|webm|mp3|aac|ogg|m4a|wav)$/i, '');
  let m = base.match(/([a-z]{3,})s(\d)(\d{1,2})(?:v\d)?$/i);
  if (m) return { titleSlug: m[1], season: Number(m[2]), episode: Number(m[3]) };
  return null;
}

function extractPartFromFilename(fileName) {
  const kur = parseKuronimeSeasonEpisode(fileName);
  if (kur) return kur.episode;
  let raw = fileName.replace(/\.(mp4|mkv|mov|avi|webm|mp3|aac|ogg|m4a|wav)$/i, '');
  // "tnsrantssdk12-end" → hapus -end biar episode 12 kebaca (bukan 1)
  raw = raw.replace(/-end$/i, '');
  const base = raw;
  // Kuronime: "kjny02unc" → episode 2
  let m = base.match(/\b([a-z]{3,})(\d{2})unc/i);
  if (m) return Number(m[2]);
  m = base.match(/\b[Ee][Pp]\s*(\d{1,3})\b/);
  if (m) return Number(m[1]);
  m = base.match(/\b[Ee]pisode\s*(\d{1,3})\b/);
  if (m) return Number(m[1]);
  m = base.match(/\b[Ee]\s*(\d{1,3})\b/);
  if (m) return Number(m[1]);
  m = base.match(/\b[Pp]art\s*(\d{1,3})\b/);
  if (m) return Number(m[1]);
  m = base.match(/(\d{1,3})\s*$/);
  if (m) return Number(m[1]);
  return 1;
}

function sanitizeSlug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function extractSourcePattern(fileName) {
  // "1080p-0nizdxx-kuronime-ymintsgai06.mp4" → "kuronime-ymintsgai"
  // "1080p-nIVJp5U-kuronime-blcktrch04.mp4" → "kuronime-blcktrch"
  // "1080p-bBeCgqA-kuronime-tssdks401.mp4" → "kuronime-tssdk" (strip s+ep)
  // "1080p-?-kuronime-tnsrantssdk12-end.mp4" → "kuronime-tnsrantssdk" (strip episode + -end)
  // "TsSDKMGnoKh-FULLHD-SAMEHADAKU.CARE.mp4" → "TsSDKMGnoKh" (Google Drive filename Samehadaku)
  const base = fileName.replace(/\.(mp4|mkv|mov|avi|webm|mp3|aac|ogg|m4a|wav)$/i, '');
  // Google Drive Samehadaku: <SHORT>-FULLHD-SAMEHADAKU... → pakai <SHORT> langsung
  if (/SAMEHADAKU/i.test(base)) {
    const sm = base.match(/^([A-Za-z0-9]{3,20})-(?:FULLHD|HD|S\d|P\d|M|\d+)-/i);
    if (sm && sm[1].length >= 3) return sm[1];
    const sm3 = base.match(/^([A-Za-z0-9]{3,20})-\d+[a-z]?-/i);
    if (sm3 && sm3[1].length >= 3) return sm3[1];
    return null;
  }
  // Normalize season+episode suffix: tssdks401 → tssdk, ssounfrrens201 → ssounfrren, ymintsgai21 → ymintsgai
  // Handle "-end" suffix (episode terakhir kuronime): tnsrantssdk12-end → tnsrantssdk
  let normalized = base;
  normalized = normalized.replace(/-end$/i, '');               // strip -end
  normalized = normalized.replace(/([a-z]{3,})s\d\d{1,2}$/i, '$1');
  normalized = normalized.replace(/([a-z]{3,})\d{2,3}$/i, '$1');
  // Kuronime uncensored: "kjny02unc"/"kjny03unc" → "kjny" (strip {ep}unc)
  // Supaya semua episode 1 judul punya source_pattern yang sama (auto-detect karya manual sekali).
  // (Catatan: "kjny01unc01" sudah ter-strip oleh \d{2,3}$ di atas jadi "kjny01unc", lalu kena regex ini.)
  normalized = normalized.replace(/([a-z]{2,})\d{1,3}unc$/i, '$1');
  const noEp = normalized.replace(/-$/, '');
  const parts = noEp.split('-');
  const filtered = parts.filter((p, i) => {
    if (/^\d{3,4}p$/i.test(p)) return false; // resolution (1080p/720p)
    if (i >= 1 && /^[a-zA-Z0-9]{5,8}$/.test(p) && /[a-z]/.test(p) && /[A-Z]/.test(p)) return false; // random hash mixed case (bBeCgqA)
    if (i >= 1 && /^[a-z0-9]{5,8}$/.test(p) && /\d/.test(p) && /[a-z]/.test(p)) return false; // random hash lowercase+digit (0nizdxx)
    if (i >= 1 && /^[A-Z0-9]{5,8}$/.test(p) && /\d/.test(p)) return false; // random hash UPPER+digit (N39X3YF, 8DQOJmA)
    if (i >= 1 && /^[A-Z]{5,8}$/.test(p)) return false; // random hash UPPER-only (XXXXXXXX, KABULK9)
    return true;
  });
  const pattern = filtered.join('-');
  return pattern.length >= 5 ? pattern : null;
}

function extractProvider(fileName) {
  // "1080p-nIVJp5U-kuronime-blcktrch04.mp4" → "kuronime"
  const base = fileName.replace(/\.(mp4|mkv|mov|avi|webm|mp3|aac|ogg|m4a|wav)$/i, '');
  const parts = base.split('-');
  for (const p of parts) {
    // Skip resolution, random hash (mixed case alphanumeric), episode numbers
    if (/^\d{3,4}p$/i.test(p)) continue;
    if (/^[a-zA-Z0-9]{5,8}$/.test(p) && /[a-z]/.test(p) && /[A-Z]/.test(p)) continue;
    if (/^\d+$/.test(p)) continue;
    if (/^[a-zA-Z]{3,}$/.test(p)) return p.toLowerCase();
  }
  return 'unknown';
}

/**
 * Parse Google Drive filename gaya Samehadaku:
 *   TSSDK-S2-P2-1-FULLHD-SAMEHADAKU.VIP.mp4 → { short:"tssdk", season:2, part:2, episode:1, provider:"samehadaku" }
 *   TSSDK-S2-1-FULLHD-...                      → { short:"tssdk", season:2, part:null, episode:1 }
 *   TSSDK-1-FULLHD-...                         → { short:"tssdk", season:null, part:null, episode:1 }
 */
function parseSamehadakuFilename(fileName) {
  const base = String(fileName || '').trim();
  // Detect provider samehadaku
  if (!/samehadaku/i.test(base)) return null;
  const epFrom = (s) => { const m = String(s || '').match(/^\d+/); return m ? Number(m[0]) : null; };
  let ep = null, season = null, part = null;
  // episode bisa "5", "5v2", "12v3", "12END", "12End" → ambil angka murni (END = episode terakhir, strip akhir)
  let m = base.match(/-S(\d+)-P(\d+)-(\d+)(?:v\d+|END|End|end)?-/i);
  if (m) {
    season = Number(m[1]); part = Number(m[2]); ep = epFrom(m[3]);
  } else {
    m = base.match(/-S(\d+)-(\d+)(?:v\d+)?-/i);
    if (m) { season = Number(m[1]); ep = epFrom(m[2]); }
    else {
      m = base.match(/^([A-Z0-9]+)-(\d+)(?:v\d+)?-/i);
      if (m) ep = epFrom(m[2]);
    }
  }
  if (ep == null) return null;
  const shortRaw = (base.match(/^([A-Za-z0-9]+)-/) || [])[1] || '';
  return {
    short: shortRaw.toLowerCase(),
    season,
    part,
    episode: ep,
    provider: 'samehadaku',
  };
}

module.exports = {
  stripHtml,
  truncateText,
  cleanCaption,
  parseKuronimeSeasonEpisode,
  extractPartFromFilename,
  sanitizeSlug,
  extractSourcePattern,
  extractProvider,
  parseSamehadakuFilename,
};
