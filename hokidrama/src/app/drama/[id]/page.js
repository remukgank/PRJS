import { getDramaById, getVidaraEpisodes } from '../../../lib/data'
import { notFound } from 'next/navigation'

export default async function DramaPage({ params, searchParams }) {
  const { id } = await params
  const sp = await searchParams
  const source = sp?.source || ''
  const epFilecode = sp?.ep || ''

  const drama = await getDramaById(id)
  if (!drama) notFound()

  const v = await getVidaraEpisodes(drama.source, drama.id)
  const hasVidara = v.found && v.episodes.length > 0
  const currentEp = epFilecode
    ? v.episodes.find(e => e.filecode === epFilecode)
    : v.episodes?.[0]
  const currentFc = currentEp?.filecode || null

  return (
    <div>
      <div className="page-header">
        <a href={source ? `/${source}` : '/'} style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
          ← Kembali
        </a>
        <h1 style={{ marginTop: 8 }}>{drama.title}</h1>
        <p>
          {drama.source} · ID: {drama.id}
          {hasVidara ? ` · ${v.episodes.length} eps di Vidara` : ''}
        </p>
      </div>

      {hasVidara && (
        <div style={{
          background: '#1e293b', border: '1px solid #475569', borderRadius: 10,
          padding: 24,
        }}>
          <h3 style={{ marginBottom: 16, fontSize: '1.1rem' }}>
            🎬 {currentEp ? `Ep ${currentEp.episode}` : 'Pemutar Video'}
          </h3>
          {currentEp?.embedUrl ? (
            <div className="player-wrapper">
              <iframe
                src={currentEp.embedUrl}
                allow="autoplay; fullscreen"
                allowFullScreen
                title={`${drama.title} Ep ${currentEp?.episode}`}
              />
            </div>
          ) : (
            <div className="player-wrapper" style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexDirection: 'column', gap: 12, minHeight: 300, background: '#0f172a',
            }}>
              <div style={{ fontSize: '2rem', opacity: 0.3 }}>🎬</div>
              <div style={{ color: '#94a3b8' }}>Pilih episode</div>
            </div>
          )}
          <div className="episode-list">
            {v.episodes.map(ep => {
              const epUrl = `/drama/${drama.id}?source=${drama.source}${ep.episode ? `&ep=${ep.filecode}` : ''}`
              const isActive = ep.filecode === currentFc
              return (
                <a key={ep.filecode} href={epUrl}
                  className={`ep${isActive ? ' active' : ''}`}>
                  Ep {ep.episode}
                </a>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
