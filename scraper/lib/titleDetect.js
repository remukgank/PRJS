const { extractSourcePattern, parseSamehadakuFilename } = require('./parser');
const { findMediaByPattern } = require('../db');
const { logger } = require('../logger');

// Helper terpusat — dedup 4 handler (GoFile direct/share, Pixeldrain, GDrive)
// Penuhi syarat Batch C: .catch dibedakan jadi warn vs not-found, loop provider cross-check identik, log tetap jalan
async function detectTitleFromFilename(fileName) {
  const pattern = extractSourcePattern(fileName);
  if (pattern) {
    try {
      const m = await findMediaByPattern(pattern);
      if (m) {
        logger.info({ pattern, matched: m.nama }, 'Auto-detected via pattern');
        return { title: m.nama, pattern, source: 'pattern' };
      }
      logger.info({ pattern, matched: null, fileName }, 'Pattern match result - no match');
    } catch (err) {
      logger.warn({ pattern, err: err.message }, 'findMediaByPattern error (pattern) — beda dari not-found');
    }
  }
  const gdSame = parseSamehadakuFilename(fileName);
  if (gdSame?.short) {
    for (const prov of ['kuronime', 'samehadaku']) {
      const tryPat = `${prov}-${gdSame.short}`;
      try {
        const m = await findMediaByPattern(tryPat);
        if (m) {
          logger.info({ pattern: tryPat, matched: m.nama }, 'Auto-detected via samehadaku short');
          return { title: m.nama, pattern: tryPat, source: 'samehadaku-short' };
        }
      } catch (err) {
        logger.warn({ pattern: tryPat, err: err.message }, 'findMediaByPattern error (samehadaku-short) — beda dari not-found');
      }
    }
    logger.info({ short: gdSame.short, fileName }, 'Samehadaku short fallback - no match');
  }
  return { title: null, pattern: null, source: null };
}

module.exports = { detectTitleFromFilename };
