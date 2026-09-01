import { pool } from './db'

// Provider display config (icon/label) — reuse existing map, but list comes from DB now.
const SOURCE_MAP = {
  flickreels: { lang: 'id', label: 'FlickReels', icon: '🎬' },
  shortmax: { lang: 'id', label: 'ShortMax', icon: '📺' },
  reelshort: { lang: null, label: 'ReelShort', icon: '🎥' },
  netshort: { lang: 'id', label: 'NetShort', icon: '📱' },
  stardusttv: { lang: 'id', label: 'StardustTV', icon: '⭐' },
  dramabite: { lang: 'id', label: 'DramaBite', icon: '🍿' },
  dramabox: { lang: 'in', label: 'DramaBox', icon: '📦' },
  cubetv: { lang: 'id', label: 'CubeTV', icon: '📺' },
  moretv: { lang: 'id', label: 'MoreTV', icon: '📺' },
  'reelfren_reelshort': { lang: null, label: 'ReelShort', icon: '🎥' },
  reelfren_short4s: { lang: null, label: 'ReelShort', icon: '🎥' },
}

function parseKey(key) {
  // drama_key stores "<provider>:<id>" (id may contain a slug with dashes)
  const i = key.indexOf(':')
  if (i === -1) return null
  return { source: key.slice(0, i), id: key.slice(i + 1) }
}

async function queryAllDramas() {
  const { rows } = await pool.query(`
    SELECT v.drama_key,
           MAX(v.title) AS title,
           COUNT(*) AS eps,
           MIN(v.domain) AS domain,
           MIN(v.uploaded_at) AS first_at,
           MIN(m.poster_url) AS poster
    FROM vidara_uploads v
    LEFT JOIN media m
      ON m.slug = v.drama_key
      OR m.slug = 'reelfren_' || v.drama_key
    GROUP BY v.drama_key
    ORDER BY MAX(v.uploaded_at) DESC
  `)
  const seen = {}
  const dramas = []
  for (const r of rows) {
    const p = parseKey(r.drama_key)
    if (!p) continue
    if (seen[p.id]) continue // avoid duplicate id across providers
    seen[p.id] = true
    dramas.push({ id: p.id, title: r.title || p.id, source: p.source, eps: Number(r.eps), poster: r.poster || null })
  }
  return dramas
}

export async function getAllDramas() {
  try {
    return await queryAllDramas()
  } catch (e) {
    console.error('[data] getAllDramas:', e.message)
    return []
  }
}

export async function getDramasBySource(source) {
  const all = await getAllDramas()
  return all.filter(d => d.source === source)
}

export async function getDramaById(id) {
  const all = await getAllDramas()
  return all.find(d => d.id === id) || null
}

export async function getSources() {
  const all = await getAllDramas()
  const counts = {}
  for (const d of all) counts[d.source] = (counts[d.source] || 0) + 1
  return Object.entries(counts).map(([key, count]) => {
    const cfg = SOURCE_MAP[key] || {}
    return { key, label: cfg.label || key, icon: cfg.icon || '🎬', count }
  }).sort((a, b) => b.count - a.count)
}

export async function searchDramas(q) {
  const query = (q || '').toLowerCase()
  const all = await getAllDramas()
  return all.filter(d =>
    d.title.toLowerCase().includes(query) ||
    d.source.toLowerCase().includes(query)
  )
}

function normalizeDomain(domain) {
  return (domain || process.env.VIDARA_DOMAIN || 'vidara.so').replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

// Domain aktif dari menu 🌐 Domain Vidara (bot_settings.vidara_active_domain).
// null artinya default/fallback.
let _activeDomainPromise = null
async function getActiveVidaraDomain() {
  if (!_activeDomainPromise) {
    _activeDomainPromise = (async () => {
      try {
        const { rows } = await pool.query(
          `SELECT value FROM bot_settings WHERE key = 'vidara_active_domain' LIMIT 1`
        )
        return rows[0]?.value || null
      } catch (e) {
        console.error('[data] getActiveVidaraDomain:', e.message)
        return null
      }
    })().finally(() => { _activeDomainPromise = null })
  }
  return _activeDomainPromise
}

export async function getVidaraEpisodes(source, id) {
  const dramaKey = `${source}:${id}`
  try {
    const [activeDomain, res] = await Promise.all([
      getActiveVidaraDomain(),
      pool.query(
        `SELECT ep, filecode, domain, title
         FROM vidara_uploads
         WHERE drama_key = $1
         ORDER BY ep`,
        [dramaKey]
      ),
    ])
    if (res.rows.length === 0) return { found: false }
    // Prioritas domain: aktif (menu 🌐) > domain per-row > env/default.
    const domain = normalizeDomain(activeDomain || res.rows[0].domain)
    const episodes = res.rows.map(r => ({
      episode: Number(r.ep) || r.ep,
      filecode: r.filecode,
      embedUrl: `https://${domain}/e/${r.filecode}`,
    }))
    return { found: true, episodes, info: { title: res.rows[0].title || id } }
  } catch (e) {
    console.error('[data] getVidaraEpisodes:', e.message)
    return { found: false }
  }
}
