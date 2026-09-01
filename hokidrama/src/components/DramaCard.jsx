export default function DramaCard({ drama }) {
  const href = `/drama/${drama.id}?source=${drama.source}`
  return (
    <article className="drama-card">
      <a href={href}>
        <div className="poster-frame scanline">
          {drama.poster ? (
            <img src={drama.poster} alt={`Poster ${drama.title}`} loading="lazy" decoding="async" />
          ) : (
            <div className="poster-placeholder">
              <span style={{ fontSize: '2.5rem', opacity: 0.6 }}>🎬</span>
            </div>
          )}
          <span className="chip poster-badge">{drama.eps} eps</span>
          <span className="chip poster-provider">{drama.source}</span>
        </div>
        <div className="drama-card-body">
          <h3>{drama.title}</h3>
          <span className="chip">
            <span aria-hidden="true">▶</span> Tonton Sekarang
          </span>
        </div>
      </a>
    </article>
  )
}
