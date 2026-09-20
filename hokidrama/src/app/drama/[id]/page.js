import { getDramaById, getVidaraEpisodes } from '../../../lib/data'
import { notFound } from 'next/navigation'

export default async function DramaPage({ params, searchParams }) {
  const { id } = await params
  const sp = await searchParams
  const epFilecode = sp?.ep || ''
  const fromQuery = sp?.q || ''

  const drama = await getDramaById(id)
  if (!drama) notFound()

  // Web hanya menampilkan yang ada di Vidara. Tanpa episode = 404.
  const v = await getVidaraEpisodes(drama.source, drama.id)
  if (!v.found || !v.episodes || v.episodes.length === 0) notFound()

  // 1 tombol per file merge (group by filecode), bukan 1 tombol per row.
  const parts = v.parts && v.parts.length > 0 ? v.parts : v.episodes.map(e => ({
    filecode: e.filecode,
    embedUrl: e.embedUrl,
    epStart: e.episode,
    epEnd: e.episode,
    count: 1,
    label: `Ep ${e.episode}`,
  }))
  const totalEps = parts.reduce((n, g) => n + (g.count || 1), 0)
  const current = epFilecode
    ? parts.find(g => g.filecode === epFilecode)
    : parts?.[0]
  const currentFc = current?.filecode || null
  // Kembali: ke hasil search kalau datang dari search, kalau tidak ke /<source> dari DB.
  const backHref = fromQuery ? `/?q=${encodeURIComponent(fromQuery)}` : `/${drama.source}`
  const qSuffix = fromQuery ? `&q=${encodeURIComponent(fromQuery)}` : ''

  return (
    <div>
      <div className="page-header">
        <a href={backHref} style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
          ← Kembali
        </a>
        <div style={{ display: 'flex', gap: 16, marginTop: 8, alignItems: 'center' }}>
          {drama.poster && (
            <img src={drama.poster} alt="" style={{ width: 72, height: 108, objectFit: 'cover', borderRadius: 8, border: '1px solid #475569' }} />
          )}
          <div>
            <h1 style={{ margin: 0 }}>{drama.title}</h1>
            <p>
              {drama.source} · {parts.length} video · {totalEps} episode
            </p>
          </div>
        </div>
      </div>

      <div style={{
        background: '#1e293b', border: '1px solid #475569', borderRadius: 10,
        padding: 24,
      }}>
        <h3 style={{ marginBottom: 16, fontSize: '1.1rem' }}>
          {current ? `🎬 ${current.label}` : '🎬 Pilih video'}
        </h3>
        {current?.embedUrl ? (
          <div className="player-wrapper">
            <iframe
              src={current.embedUrl}
              allow="autoplay; fullscreen"
              allowFullScreen
              title={`${drama.title} ${current?.label || ''}`}
            />
          </div>
        ) : (
          <div className="player-wrapper" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexDirection: 'column', gap: 12, minHeight: 300, background: '#0f172a',
          }}>
            <div style={{ fontSize: '2rem', opacity: 0.3 }}>🎬</div>
            <div style={{ color: '#94a3b8' }}>Pilih video</div>
          </div>
        )}

        <h4 style={{ marginTop: 20, marginBottom: 8, fontSize: '0.9rem', color: '#94a3b8' }}>
          Semua Video ({parts.length} video · {totalEps} episode)
        </h4>
        <div className="episode-list">
          {parts.map(g => {
            const partUrl = `/drama/${drama.id}?source=${drama.source}&ep=${g.filecode}${qSuffix}`
            const isActive = g.filecode === currentFc
            return (
              <a key={g.filecode} href={partUrl}
                className={`ep${isActive ? ' active' : ''}`}>
                {g.label}
              </a>
            )
          })}
        </div>
      </div>
    </div>
  )
}
