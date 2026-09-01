import { getDramasBySource, getSources } from '../../lib/data'
import DramaCard from '../../components/DramaCard'
import { notFound } from 'next/navigation'

export async function generateStaticParams() {
  const sources = await getSources()
  return sources.map(s => ({ source: s.key }))
}

export default async function SourcePage({ params }) {
  const { source } = await params
  const sources = await getSources()
  const src = sources.find(s => s.key === source)
  if (!src) notFound()

  const dramas = await getDramasBySource(source)

  return (
    <>
      <div className="page-header">
        <h1>{src.icon} {src.label}</h1>
        <p>{dramas.length} drama</p>
      </div>

      {dramas.length === 0 ? (
        <div className="empty-state">
          <h2>Belum ada drama</h2>
        </div>
      ) : (
        <div className="drama-grid">
          {dramas.map(d => <DramaCard key={`${d.source}-${d.id}`} drama={d} />)}
        </div>
      )}
    </>
  )
}
