import { getDramaById, getVidaraEpisodes, getTelegramParts } from '../../../lib/data'
import { notFound } from 'next/navigation'

export default async function DramaPage({ params, searchParams }) {
  const { id } = await params
  const sp = await searchParams
  const source = sp?.source || ''
  const epFilecode = sp?.ep || ''
  const tgIdx = sp?.tgpart !== undefined && sp?.tgpart !== '' ? Number(sp.tgpart) : null

  const drama = await getDramaById(id)
  if (!drama) notFound()

  const [v, t] = await Promise.all([
    getVidaraEpisodes(drama.source, drama.id),
    getTelegramParts(drama.source, drama.id),
  ])
  const hasVidara = v.found && v.episodes.length > 0
  const hasTg = t.found && t.parts.length > 0
  const currentEp = epFilecode
    ? v.episodes.find(e => e.filecode === epFilecode)
    : v.episodes?.[0]
  const currentFc = currentEp?.filecode || null
  // Mode player: vidara (default) atau telegram (kalau tgpart dipilih)
  const tgMode = sp?.tgpart !== undefined && sp?.tgpart !== ''
  const tgPart = tgMode && t.parts?.[tgIdx] ? t.parts[tgIdx] : null

  return (
    <div>
      <div className="page-header">
        <a href={source ? `/${source}` : '/'} style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
          ← Kembali
        </a>
        <div style={{ display: 'flex', gap: 16, marginTop: 8, alignItems: 'center' }}>
          {drama.poster && (
            <img src={drama.poster} alt="" style={{ width: 72, height: 108, objectFit: 'cover', borderRadius: 8, border: '1px solid #475569' }} />
          )}
          <div>
            <h1 style={{ margin: 0 }}>{drama.title}</h1>
            <p>
              {drama.source} · ID: {drama.id}
              {hasVidara ? ` · ${v.episodes.length} eps di Vidara` : ''}
              {hasTg ? ` · ${t.parts.length} part di Telegram` : ''}
            </p>
          </div>
        </div>
      </div>

      {(hasVidara || hasTg) && (
        <div style={{
          background: '#1e293b', border: '1px solid #475569', borderRadius: 10,
          padding: 24,
        }}>
          <h3 style={{ marginBottom: 16, fontSize: '1.1rem' }}>
            {tgPart
              ? `🎬 ${tgPart.fileName || `Part ${tgPart.part}`}`
              : currentEp ? `🎬 Ep ${currentEp.episode}` : '🎬 Pilih tontonan'}
          </h3>
          {tgPart ? (
            <div className="player-wrapper" style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexDirection: 'column', gap: 12, minHeight: 200, background: '#0f172a',
            }}>
              <div style={{ fontSize: '2rem', opacity: 0.3 }}>📦</div>
              <div style={{ color: '#e2e8f0', fontWeight: 600 }}>{tgPart.fileName || `Part ${tgPart.part}`}</div>
              <div style={{ color: '#94a3b8', fontSize: '0.85rem' }}>
                {tgPart.sizeMb ? `${tgPart.sizeMb} MB · ` : ''}tersimpan di Telegram
              </div>
              {tgPart.tgUrl && (
                <a href={tgPart.tgUrl} target="_blank" rel="noopener noreferrer" className="chip hero-cta" style={{ textDecoration: 'none' }}>
                  <span aria-hidden="true">✈️</span> Tonton di Telegram
                </a>
              )}
            </div>
          ) : currentEp?.embedUrl ? (
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

          {hasVidara && (
            <>
              <h4 style={{ marginTop: 20, marginBottom: 8, fontSize: '0.9rem', color: '#94a3b8' }}>
                Vidara ({v.episodes.length} episode)
              </h4>
              <div className="episode-list">
                {v.episodes.map(ep => {
                  const epUrl = `/drama/${drama.id}?source=${drama.source}${ep.episode ? `&ep=${ep.filecode}` : ''}`
                  const isActive = !tgMode && ep.filecode === currentFc
                  return (
                    <a key={ep.filecode} href={epUrl}
                      className={`ep${isActive ? ' active' : ''}`}>
                      Ep {ep.episode}
                    </a>
                  )
                })}
              </div>
            </>
          )}

          {hasTg && (
            <>
              <h4 style={{ marginTop: 20, marginBottom: 8, fontSize: '0.9rem', color: '#94a3b8' }}>
                Telegram ({t.parts.length} part — termasuk hasil merge)
              </h4>
              <div className="episode-list">
                {t.parts.map((p, i) => {
                  const tgUrl = `/drama/${drama.id}?source=${drama.source}&tgpart=${i}`
                  const isActive = tgMode && i === tgIdx
                  return (
                    <a key={`${p.fileId}-${i}`} href={tgUrl}
                      className={`ep${isActive ? ' active' : ''}`}>
                      {String(p.part).match(/^\d+$/) ? `Part ${p.part}` : p.part}{p.sizeMb ? ` · ${p.sizeMb} MB` : ''}
                    </a>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}

      {!hasVidara && !hasTg && (
        <div className="empty-state">
          <h2>Belum ada video</h2>
          <p>Belum ada episode di Vidara maupun Telegram untuk drama ini.</p>
        </div>
      )}
    </div>
  )
}
