// services/vipService.js - adaptasi fomo-drama untuk PRJS
const { pool } = require('../db');
const { logger } = require('../logger');

const cache = new Map(); // userId -> { expireAt, username }
let loaded = false;

async function loadVipCache() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vip_users (
        user_id VARCHAR PRIMARY KEY,
        username VARCHAR,
        expire_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id BIGSERIAL PRIMARY KEY,
        order_id VARCHAR UNIQUE,
        user_id VARCHAR,
        username VARCHAR,
        amount NUMERIC,
        method VARCHAR,
        vip_days INTEGER,
        status VARCHAR DEFAULT 'pending',
        message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        processed_at TIMESTAMPTZ
      );
    `);
    const r = await pool.query('SELECT user_id, username, expire_at FROM vip_users WHERE expire_at > NOW()');
    cache.clear();
    for (const row of r.rows) {
      cache.set(String(row.user_id), { expireAt: new Date(row.expire_at), username: row.username });
    }
    loaded = true;
  } catch (e) {
    logger.warn({ err: e.message }, 'vipService load cache failed');
  }
}
loadVipCache();
setInterval(loadVipCache, 5 * 60 * 1000).unref();

function isVipUserSync(userId) {
  const v = cache.get(String(userId));
  if (!v) return false;
  return v.expireAt > new Date();
}

async function isVipUser(userId) {
  if (isVipUserSync(userId)) return true;
  try {
    const r = await pool.query('SELECT expire_at FROM vip_users WHERE user_id = $1 AND expire_at > NOW()', [String(userId)]);
    return r.rows.length > 0;
  } catch { return false; }
}

// Tambah/ekstensi masa VIP. Stacking: extend dari expire aktif bila masih berlaku,
// bukan dari hari ini (pola fomo-drama addVipUser).
async function addVipUser(userId, days, meta = {}) {
  const userIdStr = String(userId);
  const nowMs = Date.now();
  let baseMs = nowMs;
  try {
    const r = await pool.query('SELECT expire_at FROM vip_users WHERE user_id = $1', [userIdStr]);
    if (r.rows.length > 0 && new Date(r.rows[0].expire_at).getTime() > nowMs) {
      baseMs = new Date(r.rows[0].expire_at).getTime();
    }
  } catch (e) {
    logger.warn({ err: e.message }, 'addVipUser read failed, start from now');
  }
  const expireAt = new Date(baseMs + days * 24 * 3600 * 1000);
  await pool.query(
    `INSERT INTO vip_users (user_id, username, expire_at) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET expire_at = $3, username = $2`,
    [userIdStr, meta.username || null, expireAt]
  );
  cache.set(userIdStr, { expireAt, username: meta.username });
  return { expireAt };
}

// Catat pembayaran ke tabel payments (audit trail)
async function recordPayment({ orderId, userId, username, amount, method, vipDays, status = 'approved', message }) {
  if (!orderId || !userId) throw new Error('orderId & userId wajib');
  const r = await pool.query(
    `INSERT INTO payments (order_id, user_id, username, amount, method, vip_days, status, message, created_at, processed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
     ON CONFLICT (order_id) DO UPDATE SET status = EXCLUDED.status, processed_at = NOW()`,
    [orderId, String(userId), username || null, amount || null, method || null, vipDays || null, status, message || null]
  );
  return r;
}

function getVipInfo(userId) {
  const v = cache.get(String(userId));
  if (!v) return null;
  if (v.expireAt <= new Date()) return null;
  const daysLeft = Math.ceil((v.expireAt - new Date()) / 86400000);
  return { expireDate: v.expireAt.toLocaleDateString('id-ID'), daysLeft, expireAt: v.expireAt };
}

module.exports = { isVipUserSync, isVipUser, addVipUser, recordPayment, getVipInfo, loadVipCache };