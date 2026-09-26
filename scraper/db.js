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
      CREATE TABLE IF NOT EXISTS deeplinks (
        code       TEXT PRIMARY KEY,
        media_slug TEXT NOT NULL,
        part       INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (media_slug, part)
      );
    `);
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vidoy_uploads (
        media_key   TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT 'drama',
        part        INTEGER NOT NULL DEFAULT 0,
        ep_start    INTEGER,
        ep_end      INTEGER,
        title       TEXT,
        folder_id   TEXT,
        folder_url  TEXT,
        link        TEXT,
        dashboard   TEXT,
        tg_chat_id    BIGINT,
        tg_message_id BIGINT,
        provider      TEXT,
        caption       TEXT,
        link_checked_at TIMESTAMPTZ,
        link_alive     BOOLEAN,
        uploaded_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (media_key, kind, part)
      );
    `);
    // Migrasi ringan untuk tabel yang sudah ada sebelum kolom pointer pesan ditambahkan
    await pool.query('ALTER TABLE vidoy_uploads ADD COLUMN IF NOT EXISTS tg_chat_id BIGINT');
    await pool.query('ALTER TABLE vidoy_uploads ADD COLUMN IF NOT EXISTS tg_message_id BIGINT');
    await pool.query('ALTER TABLE vidoy_uploads ADD COLUMN IF NOT EXISTS link_checked_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE vidoy_uploads ADD COLUMN IF NOT EXISTS link_alive BOOLEAN');
    await pool.query('ALTER TABLE vidoy_uploads ADD COLUMN IF NOT EXISTS provider TEXT');
    await pool.query('ALTER TABLE vidoy_uploads ADD COLUMN IF NOT EXISTS caption TEXT');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS livechat_route (
        admin_msg_id BIGINT PRIMARY KEY,
        user_chat_id BIGINT NOT NULL,
        user_msg_id  BIGINT,
        user_name    TEXT,
        ts           TIMESTAMPTZ DEFAULT NOW()
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

async function saveLiveChatRoute(adminMsgId, userChatId, userMsgId, userName) {
  try {
    await pool.query(
      `INSERT INTO livechat_route (admin_msg_id, user_chat_id, user_msg_id, user_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (admin_msg_id) DO UPDATE SET user_chat_id = $2, user_msg_id = $3, user_name = $4`,
      [adminMsgId, userChatId, userMsgId, userName]
    );
    return true;
  } catch (err) {
    logger.error({ err: err.message, adminMsgId }, 'Failed to save live chat route');
    return false;
  }
}

async function getLiveChatRoute(adminMsgId) {
  try {
    const r = await pool.query('SELECT * FROM livechat_route WHERE admin_msg_id = $1', [adminMsgId]);
    return r.rows[0] || null;
  } catch (err) {
    logger.error({ err: err.message, adminMsgId }, 'Failed to get live chat route');
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

// ─── Vidoy uploads (link per batch / per episode) ───────────────────────────

async function saveVidoyUpload(rec) {
  const {
    mediaKey, kind = 'drama', part = 0, epStart = null, epEnd = null,
    title = null, folderId = null, folderUrl = null, link = null, dashboard = null,
    tgChatId = null, tgMessageId = null, provider = null, caption = null,
  } = rec || {};
  if (!mediaKey || !link) return;
  try {
    await pool.query(
      `INSERT INTO vidoy_uploads (media_key, kind, part, ep_start, ep_end, title, folder_id, folder_url, link, dashboard, tg_chat_id, tg_message_id, provider, caption)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (media_key, kind, part) DO UPDATE SET
         ep_start = $4, ep_end = $5, title = $6, folder_id = $7, folder_url = $8,
         link = $9, dashboard = $10, uploaded_at = NOW(),
         tg_chat_id = COALESCE($11, vidoy_uploads.tg_chat_id),
         tg_message_id = COALESCE($12, vidoy_uploads.tg_message_id),
         provider = COALESCE($13, vidoy_uploads.provider),
         caption = COALESCE($14, vidoy_uploads.caption)`,
      [mediaKey, kind, Number(part) || 0, epStart, epEnd, title, folderId, folderUrl, link, dashboard, tgChatId, tgMessageId, provider, caption]
    );
  } catch (err) {
    logger.error({ err: err.message, mediaKey, kind, part }, 'Failed to save vidoy upload');
  }
}

// Pesan Telegram dihapus user → pointer dibersihkan agar part bisa dikirim ulang.
async function clearVidoyTelegramPointer(mediaKey, kind, part) {
  try {
    await pool.query(
      `UPDATE vidoy_uploads SET tg_chat_id = NULL, tg_message_id = NULL
        WHERE media_key = $1 AND kind = $2 AND part = $3`,
      [mediaKey, kind, Number(part) || 0]
    );
  } catch (err) {
    logger.error({ err: err.message, mediaKey, kind, part }, 'Failed to clear vidoy telegram pointer');
  }
}

// Link publik episode yang sudah ada di Vidoy (null bila belum).
async function getVidoyLink(mediaKey, kind = 'anime', part) {
  try {
    const r = await pool.query(
      'SELECT link FROM vidoy_uploads WHERE media_key = $1 AND kind = $2 AND part = $3 AND link IS NOT NULL',
      [String(mediaKey), kind, Number(part) || 0]
    );
    return r.rows[0] ? r.rows[0].link : null;
  } catch (err) {
    logger.error({ err: err.message, mediaKey, kind, part }, 'Failed to get vidoy link');
    return null;
  }
}

// Pointer pesan Telegram per part library (dipakai !dell untuk menghapus pesan).
async function setPartTelegramPointer(slug, part, chatId, messageId) {
  try {
    await pool.query(
      `UPDATE media_parts SET tg_chat_id = $3, tg_message_id = $4
        WHERE media_slug = $1 AND part = $2`,
      [slug, Number(part) || 0, chatId, messageId]
    );
  } catch (err) {
    logger.error({ err: err.message, slug, part }, 'Failed to set part telegram pointer');
  }
}

// Pointer pesan yang tersimpan: part = null → semua part.
async function listPartTelegramPointers(slug, part = null) {
  try {
    const r = part === null || part === undefined
      ? await pool.query(
        'SELECT part, tg_chat_id, tg_message_id FROM media_parts WHERE media_slug = $1 AND tg_chat_id IS NOT NULL AND tg_message_id IS NOT NULL ORDER BY part',
        [slug])
      : await pool.query(
        'SELECT part, tg_chat_id, tg_message_id FROM media_parts WHERE media_slug = $1 AND part = $2 AND tg_chat_id IS NOT NULL AND tg_message_id IS NOT NULL',
        [slug, Number(part) || 0]);
    return r.rows;
  } catch (err) {
    logger.error({ err: err.message, slug }, 'Failed to list part telegram pointers');
    return [];
  }
}

// Pointer pesan Telegram milik satu judul di vidoy_uploads (link tidak diubah).
async function listVidoyTelegramPointers(mediaKey, kind) {
  try {
    const r = await pool.query(
      `SELECT part, tg_chat_id, tg_message_id FROM vidoy_uploads
        WHERE media_key = $1 AND kind = $2 AND tg_chat_id IS NOT NULL AND tg_message_id IS NOT NULL
        ORDER BY part`,
      [String(mediaKey), kind]
    );
    return r.rows;
  } catch (err) {
    logger.error({ err: err.message, mediaKey, kind }, 'Failed to list vidoy telegram pointers');
    return [];
  }
}

// Kosongkan pointer Telegram untuk satu judul TANPA menghapus link Vidoy
// (ATURAN KERAS: link di Vidoy tidak boleh hilang/terduplikasi).
async function clearVidoyTelegramPointers(mediaKey, kind) {
  try {
    const r = await pool.query(
      `UPDATE vidoy_uploads SET tg_chat_id = NULL, tg_message_id = NULL
        WHERE media_key = $1 AND kind = $2 AND tg_message_id IS NOT NULL`,
      [String(mediaKey), kind]
    );
    return r.rowCount || 0;
  } catch (err) {
    logger.error({ err: err.message, mediaKey, kind }, 'Failed to clear vidoy telegram pointers');
    return 0;
  }
}

async function setVidoyTelegramPointer(mediaKey, kind, part, chatId, messageId) {
  try {
    await pool.query(
      `UPDATE vidoy_uploads SET tg_chat_id = $4, tg_message_id = $5
        WHERE media_key = $1 AND kind = $2 AND part = $3`,
      [mediaKey, kind, Number(part) || 0, chatId, messageId]
    );
  } catch (err) {
    logger.error({ err: err.message, mediaKey, kind, part }, 'Failed to set vidoy telegram pointer');
  }
}

async function updateVidoyLink(mediaKey, kind, part, link, alive) {
  const r = await pool.query(
    `UPDATE vidoy_uploads SET link = $4, link_alive = $5, link_checked_at = NOW()
      WHERE media_key = $1 AND kind = $2 AND part = $3
      RETURNING media_key, kind, part, link, title, ep_start, ep_end, provider, caption, tg_chat_id, tg_message_id`,
    [mediaKey, kind, Number(part) || 0, link, alive === null || alive === undefined ? null : !!alive]
  );
  return r.rows[0] || null;
}

async function listRecentVidoyUploads(limit = 20) {
  try {
    const r = await pool.query(
      `SELECT media_key, kind, part, ep_start, ep_end, title, link, dashboard,
              link_alive, link_checked_at, tg_chat_id, tg_message_id, provider, caption, uploaded_at
         FROM vidoy_uploads ORDER BY uploaded_at DESC LIMIT $1`,
      [Number(limit) || 20]
    );
    return r.rows;
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to list recent vidoy uploads');
    return [];
  }
}

async function listVidoyUploads(mediaKey, kind = 'drama') {
  try {
    const r = await pool.query(
      // tg_chat_id/tg_message_id WAJIB ikut: animeDoneMap memakainya untuk
      // menentukan episode yang sudah terkirim ke Telegram. Tanpa kolom ini
      // hasTg selalu false → episode terkirim ulang (duplikat).
      `SELECT kind, part, ep_start, ep_end, title, folder_url, link, dashboard, provider, caption,
              tg_chat_id, tg_message_id, uploaded_at
         FROM vidoy_uploads WHERE media_key = $1 AND kind = $2 ORDER BY part`,
      [mediaKey, kind]
    );
    return r.rows;
  } catch (err) {
    logger.error({ err: err.message, mediaKey, kind }, 'Failed to list vidoy uploads');
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

// ─── Deeplink web→bot (?start=dl_<code>) ─────────────────────────────────────
// Kode pendek stabil (DB, bukan cache memori) agar link web tidak basi.
async function resolveDeeplink(code) {
  try {
    const r = await pool.query(
      'SELECT media_slug, part FROM deeplinks WHERE code = $1',
      [String(code || '').slice(0, 16)]
    );
    return r.rows[0] || null;
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to resolve deeplink');
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
    // Parts ikut dihapus — kalau tidak, episode tetap ditandai "sudah ada" di
    // picker walau judulnya sudah dihapus. (fomo-drama juga delete keduanya.)
    await pool.query('DELETE FROM media_parts WHERE media_slug = $1', [slug]);
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
  getCachedFileId,
  setCachedFileId,
  savePartFileId,
  getSetting,
  setSetting,
  saveLiveChatRoute,
  getLiveChatRoute,
  saveVidaraUpload,
  saveVidoyUpload,
  listVidoyUploads,
  setVidoyTelegramPointer,
  clearVidoyTelegramPointer,
  getVidoyLink,
  setPartTelegramPointer,
  listPartTelegramPointers,
  clearVidoyTelegramPointers,
  listVidoyTelegramPointers,
  updateVidoyLink,
  listRecentVidoyUploads,
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
  resolveDeeplink,
  upsertMedia,
  deletePart,
  deleteMedia,
  findMediaByName,
  listAllLibrary,
  getMediaBySlug,
  findMediaByPattern,
};
