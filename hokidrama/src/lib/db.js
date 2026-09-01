import { Pool } from 'pg'

const DATABASE_URL = process.env.DATABASE_URL || ''

// Same connection semantics as scraper/db.js: Neon pooler uses SSL.
const ssl = DATABASE_URL.includes('localhost') || DATABASE_URL === ''
  ? false
  : { rejectUnauthorized: false }

export const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
  ssl,
  connectionTimeoutMillis: 15000,
})

pool.on('error', (err) => {
  console.error('[db] pool error:', err.message)
})
