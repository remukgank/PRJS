import { NextResponse } from 'next/server'

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || ''
// Local Bot API (tanpa batas 20MB cloud) bila tersedia, fallback cloud.
const LOCAL_BASE = (() => {
  const port = process.env.LOCAL_API_PORT || process.env.TELEGRAM_API_PORT || ''
  return port ? `http://127.0.0.1:${port}` : null
})()
const CLOUD_BASE = 'https://api.telegram.org'

// Proxy file Telegram untuk playback web: /api/file?file_id=<id>
// Token tidak pernah ke client — getFile + bytes di-stream server-side.
// Support Range (penting agar <video> bisa seek).
export async function GET(req) {
  const { searchParams } = new URL(req.url)
  const fileId = searchParams.get('file_id') || ''
  if (!TOKEN) return NextResponse.json({ error: 'bot token belum diset' }, { status: 500 })
  if (!/^[\w-]{10,200}$/.test(fileId)) {
    return NextResponse.json({ error: 'file_id tidak valid' }, { status: 400 })
  }

  const bases = LOCAL_BASE ? [LOCAL_BASE, CLOUD_BASE] : [CLOUD_BASE]
  const headers = {}
  const range = req.headers.get('range')
  if (range) headers['Range'] = range
  // Coba tiap base sampai dapat bytes (local: file temp bisa kedaluwarsa;
  // cloud: batas 20MB). getFile OK belum tentu file bisa diunduh.
  for (const base of bases) {
    try {
      const gf = await fetch(`${base}/bot${TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`)
      const gj = await gf.json().catch(() => null)
      const filePath = gj?.result?.file_path
      if (!gj?.ok || !filePath) continue
      const up = await fetch(`${base}/file/bot${TOKEN}/${filePath}`, { headers })
      if (!up.ok && up.status !== 206) continue
      const out = new Headers()
      const ct = up.headers.get('content-type')
      out.set('Content-Type', ct && ct !== 'application/octet-stream' ? ct : 'video/mp4')
      const cl = up.headers.get('content-length')
      if (cl) out.set('Content-Length', cl)
      const cr = up.headers.get('content-range')
      if (cr) out.set('Content-Range', cr)
      out.set('Accept-Ranges', 'bytes')
      out.set('Cache-Control', 'public, max-age=86400')
      return new NextResponse(up.body, { status: up.status, headers: out })
    } catch {}
  }
  return NextResponse.json({ error: 'file tidak bisa diunduh (terlalu besar untuk cloud / temp lokal kedaluwarsa)' }, { status: 502 })
}
