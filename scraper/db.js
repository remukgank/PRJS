try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}
try { require('dotenv').config(); } catch {}
const { Pool } = require('pg');
const { logger } = require('./logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  logger.error({ err: err.message }, 'Unexpected database pool error');
});

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS free_downloads (
        user_id BIGINT NOT NULL,
        download_date DATE NOT NULL DEFAULT CURRENT_DATE,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, download_date)
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS file_cache (
        url_hash  TEXT PRIMARY KEY,
        source    TEXT NOT NULL,
        file_id   TEXT NOT NULL,
        file_type TEXT NOT NULL,
        file_name TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS media (
        slug              VARCHAR PRIMARY KEY,
        nama              VARCHAR NOT NULL,
        total_eps         INTEGER,
        ep_min            INTEGER DEFAULT 1,
        source_url        VARCHAR,
        detail_checked_at TIMESTAMPTZ,
        created_at        TIMESTAMP DEFAULT NOW(),
        created_by        VARCHAR
      );
    `);
    await pool.query(`ALTER TABLE media ADD COLUMN IF NOT EXISTS ep_min INTEGER DEFAULT 1;`);
    await pool.query(`ALTER TABLE media ADD COLUMN IF NOT EXISTS source_url VARCHAR;`);
    await pool.query(`ALTER TABLE media ADD COLUMN IF NOT EXISTS detail_checked_at TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE media ADD COLUMN IF NOT EXISTS source_pattern VARCHAR;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS media_parts (
        media_slug  VARCHAR NOT NULL REFERENCES media(slug) ON DELETE CASCADE,
        part        INTEGER NOT NULL,
        added_at    TIMESTAMP DEFAULT NOW(),
        UNIQUE (media_slug, part)
      );
    `);
    await pool.query(`ALTER TABLE media_parts ADD COLUMN IF NOT EXISTS file_id TEXT;`);
    await pool.query(`ALTER TABLE media_parts ADD COLUMN IF NOT EXISTS file_size BIGINT;`);
    await pool.query(`ALTER TABLE media_parts ADD COLUMN IF NOT EXISTS file_name TEXT;`);
    await pool.query(`ALTER TABLE media_parts ADD COLUMN IF NOT EXISTS caption TEXT;`);
    await pool.query(`ALTER TABLE media ADD COLUMN IF NOT EXISTS poster_url TEXT;`);
    await pool.query(`ALTER TABLE media ADD COLUMN IF NOT EXISTS poster_file_id TEXT;`);
    await pool.query(`ALTER TABLE media ADD COLUMN IF NOT EXISTS synopsis TEXT;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vidara_uploads (
        drama_key   TEXT NOT NULL,
        ep          INTEGER NOT NULL,
        title       TEXT,
        filecode    TEXT NOT NULL,
        domain      TEXT NOT NULL DEFAULT 'vidara.so',
        uploaded_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (drama_key, ep)
      );
    `);
    logger.info('Database tables initialized');
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to initialize database');
  }
}

async function getCachedFileId(urlHash) {
  try {
    const result = await pool.query(
      'SELECT file_id, file_type, file_name FROM file_cache WHERE url_hash = $1',
      [urlHash]
    );
    return result.rows[0] || null;
  } catch (err) {
    logger.error({ err: err.message, urlHash }, 'Failed to get cached file');
    return null;
  }
}

async function setCachedFileId(urlHash, source, fileId, fileType, fileName) {
  try {
    await pool.query(
      `INSERT INTO file_cache (url_hash, source, file_id, file_type, file_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (url_hash)
       DO UPDATE SET file_id = $3, file_type = $4, file_name = $5`,
      [urlHash, source, fileId, fileType, fileName]
    );
  } catch (err) {
    logger.error({ err: err.message, urlHash }, 'Failed to set cached file');
  }
}

async function getFreeDownloadCount(userId) {
  try {
    const result = await pool.query(
      'SELECT count FROM free_downloads WHERE user_id = $1 AND download_date = CURRENT_DATE',
      [userId]
    );
    return result.rows[0]?.count || 0;
  } catch (err) {
    logger.error({ err: err.message, userId }, 'Failed to get free download count');
    return 0;
  }
}

async function incrementFreeDownload(userId) {
  try {
    const result = await pool.query(
      `INSERT INTO free_downloads (user_id, download_date, count)
       VALUES ($1, CURRENT_DATE, 1)
       ON CONFLICT (user_id, download_date)
       DO UPDATE SET count = free_downloads.count + 1
       RETURNING count`,
      [userId]
    );
    return result.rows[0].count;
  } catch (err) {
    logger.error({ err: err.message, userId }, 'Failed to increment free download');
    return 0;
  }
}

async function cleanupOldDownloads() {
  try {
    await pool.query(
      'DELETE FROM free_downloads WHERE download_date < CURRENT_DATE - INTERVAL \'7 days\''
    );
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to cleanup old downloads');
  }
}

// ─── Library helpers ──────────────────────────────────────────────────────────

async function savePartFileId(slug, part, fileId, fileSize, fileName, caption = null) {
  try {
    await pool.query(
      `INSERT INTO media_parts (media_slug, part, file_id, file_size, file_name, caption)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (media_slug, part)
       DO UPDATE SET file_id = $3, file_size = $4, file_name = $5, caption = $6`,
      [slug, part, fileId, fileSize, fileName, caption]
    );
  } catch (err) {
    // Jika FK violation karena media belum ada, buat placeholder dulu lalu retry
    if (err.message && err.message.includes('violates foreign key')) {
      try {
        await pool.query(
          `INSERT INTO media (slug, nama) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING`,
          [slug, slug]
        );
        await pool.query(
          `INSERT INTO media_parts (media_slug, part, file_id, file_size, file_name, caption)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (media_slug, part)
           DO UPDATE SET file_id = $3, file_size = $4, file_name = $5, caption = $6`,
          [slug, part, fileId, fileSize, fileName, caption]
        );
        return;
      } catch (e2) {
        logger.error({ err: e2.message, slug, part }, 'Failed to save part file_id (retry)');
        return;
      }
    }
    logger.error({ err: err.message, slug, part }, 'Failed to save part file_id');
  }
}

async function getSetting(key) {
  try {
    const r = await pool.query('SELECT value FROM bot_settings WHERE key = $1', [key]);
    return r.rows[0]?.value || null;
  } catch (err) {
    logger.error({ err: err.message, key }, 'Failed to get setting');
    return null;
  }
}

async function setSetting(key, value) {
  try {
    await pool.query(
      `INSERT INTO bot_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, value]
    );
  } catch (err) {
    logger.error({ err: err.message, key }, 'Failed to set setting');
  }
}

// ─── Vidara links + domain rotation (landing) ────────────────────────────────

async function saveVidaraUpload(dramaKey, ep, filecode, domain = 'vidara.so', title = null) {
  try {
    await pool.query(
      `INSERT INTO vidara_uploads (drama_key, ep, filecode, domain, title)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (drama_key, ep) DO UPDATE SET
         filecode = $3, domain = $4, title = $5, uploaded_at = NOW()`,
      [dramaKey, ep, filecode, domain, title]
    );
  } catch (err) {
    logger.error({ err: err.message, dramaKey, ep }, 'Failed to save vidara upload');
  }
}

async function getVidaraUpload(dramaKey, ep) {
  try {
    const r = await pool.query(
      'SELECT filecode, domain, title FROM vidara_uploads WHERE drama_key = $1 AND ep = $2',
      [dramaKey, ep]
    );
    return r.rows[0] || null;
  } catch (err) {
    logger.error({ err: err.message, dramaKey, ep }, 'Failed to get vidara upload');
    return null;
  }
}

async function listVidaraUploads(dramaKey) {
  try {
    const r = await pool.query(
      'SELECT ep, filecode, domain FROM vidara_uploads WHERE drama_key = $1 ORDER BY ep',
      [dramaKey]
    );
    return r.rows;
  } catch (err) {
    logger.error({ err: err.message, dramaKey }, 'Failed to list vidara uploads');
    return [];
  }
}

async function getVidaraDomains() {
  const raw = await getSetting('vidara_domains');
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

async function setVidaraDomains(domains) {
  await setSetting('vidara_domains', JSON.stringify([...new Set(domains.filter(Boolean))]));
}

async function getVidaraActiveDomain() {
  const d = await getSetting('vidara_active_domain');
  return d || (await getVidaraDomains())[0] || null;
}

async function setVidaraActiveDomain(domain) {
  await setSetting('vidara_active_domain', domain);
}

function buildVidaraBase(domain) {
  return `https://${domain || 'vidara.so'}/e`;
}

async function searchDrama(query) {
  try {
    const r = await pool.query(
      `SELECT m.slug, m.nama, m.total_eps, COUNT(mp.part) FILTER (WHERE mp.file_id IS NOT NULL) AS lib_parts
       FROM media m
       LEFT JOIN media_parts mp ON mp.media_slug = m.slug
       WHERE m.nama ILIKE $1
       GROUP BY m.slug
       ORDER BY m.nama
       LIMIT 15`,
      [`%${query}%`]
    );
    return r.rows;
  } catch (err) {
    logger.error({ err: err.message, query }, 'Failed to search drama');
    return [];
  }
}

async function listPartsWithFile(slug) {
  try {
    const r = await pool.query(
      'SELECT part, file_name FROM media_parts WHERE media_slug = $1 AND file_id IS NOT NULL ORDER BY part',
      [slug]
    );
    return r.rows;
  } catch (err) {
    logger.error({ err: err.message, slug }, 'Failed to list parts');
    return [];
  }
}

async function getPartFileId(slug, part) {
  try {
    const r = await pool.query(
      'SELECT file_id, file_size, file_name, caption FROM media_parts WHERE media_slug = $1 AND part = $2 AND file_id IS NOT NULL',
      [slug, part]
    );
    return r.rows[0] || null;
  } catch (err) {
    logger.error({ err: err.message, slug, part }, 'Failed to get part file_id');
    return null;
  }
}

async function upsertMedia(slug, nama, totalEps, sourceUrl, sourcePattern = null, posterUrl = null, posterFileId = null, synopsis = null) {
  try {
    await pool.query(
      `INSERT INTO media (slug, nama, total_eps, source_url, created_by, source_pattern, poster_url, poster_file_id, synopsis) VALUES ($1, $2, $3, $4, 'bot', $5, $6, $7, $8)
       ON CONFLICT (slug) DO UPDATE SET
         nama = $2,
         total_eps = GREATEST(COALESCE(media.total_eps, 0), COALESCE($3, 0)),
         source_url = COALESCE(media.source_url, $4),
         source_pattern = COALESCE($5, media.source_pattern),
         poster_url = COALESCE($6, media.poster_url),
         poster_file_id = COALESCE($7, media.poster_file_id),
         synopsis = COALESCE($8, media.synopsis)`,
      [slug, nama, totalEps ?? null, sourceUrl ?? null, sourcePattern, posterUrl, posterFileId, synopsis]
    );
  } catch (err) {
    logger.error({ err: err.message, slug }, 'Failed to upsert media');
  }
}

async function deletePart(slug, part) {
  try {
    const r = await pool.query(
      'DELETE FROM media_parts WHERE media_slug = $1 AND part = $2 RETURNING file_id',
      [slug, part]
    );
    return r.rowCount > 0;
  } catch (err) {
    logger.error({ err: err.message, slug, part }, 'Failed to delete part');
    return false;
  }
}

async function deleteMedia(slug) {
  try {
    await pool.query('DELETE FROM media WHERE slug = $1', [slug]);
    return true;
  } catch (err) {
    logger.error({ err: err.message, slug }, 'Failed to delete media');
    return false;
  }
}

async function findMediaByName(query) {
  try {
    const r = await pool.query(
      `SELECT slug, nama FROM media WHERE nama ILIKE $1 LIMIT 5`,
      [`%${query}%`]
    );
    return r.rows;
  } catch (err) {
    logger.error({ err: err.message, query }, 'Failed to find media');
    return [];
  }
}

async function getMediaBySlug(slug) {
  try {
    const r = await pool.query('SELECT slug, nama, total_eps, poster_url, poster_file_id, synopsis, source_url FROM media WHERE slug = $1', [slug]);
    return r.rows[0] || null;
  } catch (err) {
    logger.error({ err: err.message, slug }, 'Failed to get media by slug');
    return null;
  }
}

async function findMediaByPattern(pattern) {
  try {
    const r = await pool.query(
      'SELECT slug, nama, source_pattern FROM media WHERE LOWER(source_pattern) = LOWER($1) LIMIT 1',
      [pattern]
    );
    return r.rows[0] || null;
  } catch (err) {
    logger.error({ err: err.message, pattern }, 'Failed to find media by pattern');
    return null;
  }
}

async function listAllLibrary() {
  try {
    const r = await pool.query(`
      SELECT m.slug, m.nama, m.total_eps,
        COUNT(mp.part) AS total_parts,
        COUNT(mp.part) FILTER (WHERE mp.file_id IS NOT NULL) AS lib_parts
      FROM media m
      LEFT JOIN media_parts mp ON mp.media_slug = m.slug
      GROUP BY m.slug, m.nama, m.total_eps
      HAVING COUNT(mp.part) FILTER (WHERE mp.file_id IS NOT NULL) > 0
      ORDER BY m.nama
    `);
    return r.rows;
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to list all library');
    return [];
  }
}

module.exports = {
  pool,
  initDatabase,
  getFreeDownloadCount,
  incrementFreeDownload,
  cleanupOldDownloads,
  getCachedFileId,
  setCachedFileId,
  savePartFileId,
  getSetting,
  setSetting,
  saveVidaraUpload,
  getVidaraUpload,
  listVidaraUploads,
  getVidaraDomains,
  setVidaraDomains,
  getVidaraActiveDomain,
  setVidaraActiveDomain,
  buildVidaraBase,
  searchDrama,
  listPartsWithFile,
  getPartFileId,
  upsertMedia,
  deletePart,
  deleteMedia,
  findMediaByName,
  listAllLibrary,
  getMediaBySlug,
  findMediaByPattern,
};
