// utils/rateLimiter.js - adaptasi dari fomo-drama, untuk PRJS library view
const logger = require('../logger');

class RateLimiter {
  constructor() {
    this.limits = new Map(); // userId -> { endpoint -> [timestamps] }
    this.stats = new Map();
    this.endpointLimits = {
      default: 30,
      'lib_view': 1, // 1 video/menit untuk free user (streaming), VIP/admin unlimited
      'lib_list': 30,
      'lib_search': 30,
      '!list': 30,
    };
    setInterval(() => this.cleanup(), 5 * 60 * 1000).unref();
  }

  isLimited(userId, endpoint = 'default') {
    // Admin & VIP bypass
    try {
      const vipService = require('../services/vipService');
      if (vipService.isVipUserSync && vipService.isVipUserSync(String(userId))) return false;
    } catch {}
    // Fallback async check via isAdmin will be di caller, di sini cuma cek vip sync
    // Jika vip async, caller harus cek isAdmin dulu

    const limit = this.endpointLimits[endpoint] || this.endpointLimits.default;
    const now = Date.now();
    const windowMs = 60 * 1000;
    if (!this.limits.has(String(userId))) this.limits.set(String(userId), {});
    const userLimits = this.limits.get(String(userId));
    if (!userLimits[endpoint]) userLimits[endpoint] = [];
    userLimits[endpoint] = userLimits[endpoint].filter(ts => now - ts < windowMs);
    if (userLimits[endpoint].length >= limit) {
      this.recordViolation(userId, endpoint);
      return true;
    }
    userLimits[endpoint].push(now);
    this.recordAttempt(endpoint);
    return false;
  }

  recordAttempt(endpoint) {
    if (!this.stats.has(endpoint)) this.stats.set(endpoint, { total: 0, violations: 0 });
    this.stats.get(endpoint).total++;
  }

  recordViolation(userId, endpoint) {
    if (!this.stats.has(endpoint)) this.stats.set(endpoint, { total: 0, violations: 0 });
    this.stats.get(endpoint).violations++;
    try { logger.warn(`⏳ Rate limit ${userId} on ${endpoint}`); } catch {}
  }

  getRemaining(userId, endpoint = 'default') {
    const limit = this.endpointLimits[endpoint] || this.endpointLimits.default;
    const now = Date.now();
    const windowMs = 60 * 1000;
    if (!this.limits.has(String(userId))) return limit;
    const userLimits = this.limits.get(String(userId));
    if (!userLimits[endpoint]) return limit;
    userLimits[endpoint] = userLimits[endpoint].filter(ts => now - ts < windowMs);
    return Math.max(0, limit - userLimits[endpoint].length);
  }

  cleanup() {
    const now = Date.now();
    const windowMs = 60 * 1000;
    for (const [userId, userLimits] of this.limits) {
      for (const endpoint in userLimits) {
        userLimits[endpoint] = userLimits[endpoint].filter(ts => now - ts < windowMs);
        if (userLimits[endpoint].length === 0) delete userLimits[endpoint];
      }
      if (Object.keys(userLimits).length === 0) this.limits.delete(userId);
    }
    if (this.stats.size > 50) {
      const sorted = Array.from(this.stats.entries()).sort((a, b) => b[1].total - a[1].total);
      this.stats.clear();
      for (const [k, v] of sorted.slice(0, 50)) this.stats.set(k, v);
    }
  }
}

module.exports = new RateLimiter();
