import { getAllDramas, getSources, searchDramas } from '../lib/data'
import DramaCard from '../components/DramaCard'

export default async function HomePage({ searchParams }) {
  const params = await searchParams
  const query = params?.q || ''
  const [dramas, sources, totalDramas] = await Promise.all([
    query ? searchDramas(query) : getAllDramas(),
    getSources(),
    getAllDramas(),
  ])
  const total = totalDramas.length
  const featured = !query && dramas.length > 0 ? dramas[0] : null

  return (
    <>
      {featured && (
        <a href={`/drama/${featured.id}?source=${featured.source}`} className="hero">
          {featured.poster && (
            <img src={featured.poster} alt="" aria-hidden="true" className="hero-backdrop" loading="eager" />
          )}
          <div className="hero-shade" />
          <div className="hero-body">
            <span className="chip hero-kicker">✨ Terbaru</span>
            <h2>{featured.title}</h2>
            <p>{featured.source} · {featured.eps} episode</p>
            <span className="chip hero-cta"><span aria-hidden="true">▶</span> Tonton Sekarang</span>
          </div>
        </a>
      )}

      <div className="page-header">
        <h1>{query ? `Hasil: "${query}"` : 'Semua Drama'}</h1>
        <p>{dramas.length} drama dari {sources.length} sumber · Total {total} drama</p>
      </div>

      {sources.length > 0 && !query && (
        <div className="source-grid">
          {sources.map(s => (
            <a key={s.key} href={`/${s.key}`} className="source-card">
              <span style={{ fontSize: '1.2rem' }}>{s.icon}</span>
              <div>
                <div className="source-name">{s.label}</div>
                <div className="source-count">{s.count} drama</div>
              </div>
            </a>
          ))}
        </div>
      )}

      {dramas.length === 0 ? (
        <div className="empty-state">
          <h2>Drama tidak ditemukan</h2>
          <p>Coba keyword lain</p>
        </div>
      ) : (
        <div className="drama-grid">
          {dramas.map(d => <DramaCard key={`${d.source}-${d.id}`} drama={d} />)}
        </div>
      )}
    </>
  )
}
