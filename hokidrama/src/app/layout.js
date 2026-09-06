import { getSources } from '../lib/data'

export const metadata = {
  title: 'DramaShort - Nonton Drama Pendek',
  description: 'Koleksi drama pendek Indonesia dari berbagai sumber',
  openGraph: { title: 'DramaShort', description: 'Koleksi drama pendek Indonesia', siteName: 'DramaShort', type: 'website' },
  metadataBase: new URL('https://dramashort.fun'),
}

export default function RootLayout({ children }) {
  return (
    <html lang="id">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎬</text></svg>" />
        <style>{`
          :root {
            --bg: #0f172a;
            --bg2: #1e293b;
            --bg3: #334155;
            --text: #e2e8f0;
            --text2: #94a3b8;
            --accent: #3b82f6;
            --accent-hover: #2563eb;
            --border: #475569;
          }
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            background: var(--bg);
            color: var(--text);
            font-family: 'Segoe UI', system-ui, sans-serif;
            min-height: 100vh;
          }
          a { color: var(--accent); text-decoration: none; }
          a:hover { color: var(--accent-hover); }
          .navbar {
            background: var(--bg2);
            border-bottom: 1px solid var(--border);
            padding: 12px 24px;
            display: flex;
            align-items: center;
            gap: 20px;
            flex-wrap: wrap;
          }
          .navbar .brand {
            font-size: 1.4rem;
            font-weight: 700;
            color: var(--text);
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .navbar .nav-links {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
          }
          .navbar .nav-links a {
            padding: 4px 12px;
            border-radius: 6px;
            font-size: 0.85rem;
            color: var(--text2);
            transition: all 0.2s;
          }
          .navbar .nav-links a:hover {
            background: var(--bg3);
            color: var(--text);
          }
          .search-bar {
            margin-left: auto;
            display: flex;
            gap: 6px;
          }
          .search-bar input {
            background: var(--bg3);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 6px 12px;
            color: var(--text);
            font-size: 0.85rem;
            width: 200px;
          }
          .search-bar input:focus {
            outline: none;
            border-color: var(--accent);
          }
          .search-bar button {
            background: var(--accent);
            border: none;
            border-radius: 6px;
            padding: 6px 12px;
            color: white;
            cursor: pointer;
            font-size: 0.85rem;
          }
          .search-bar button:hover {
            background: var(--accent-hover);
          }
          .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
          }
          .grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 16px;
          }
          .card {
            background: var(--bg2);
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 16px;
            transition: all 0.2s;
          }
          .card:hover {
            border-color: var(--accent);
            transform: translateY(-2px);
          }
          .card .title {
            font-size: 0.95rem;
            font-weight: 600;
            margin-bottom: 6px;
            color: var(--text);
          }
          .card .meta {
            font-size: 0.8rem;
            color: var(--text2);
            display: flex;
            gap: 8px;
            align-items: center;
          }
          .card .meta .badge {
            background: var(--bg3);
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 0.75rem;
          }
          .card .meta .badge.episodes {
            background: var(--accent);
            color: white;
          }
          .page-header {
            margin-bottom: 24px;
          }
          .page-header h1 {
            font-size: 1.8rem;
            margin-bottom: 4px;
          }
          .page-header p {
            color: var(--text2);
            font-size: 0.9rem;
          }
          .player-wrapper {
            position: relative;
            width: 100%;
            max-width: 800px;
            margin: 0 auto;
            aspect-ratio: 16/9;
            background: #000;
            border-radius: 10px;
            overflow: hidden;
          }
          .player-wrapper iframe {
            width: 100%;
            height: 100%;
            border: none;
          }
          .episode-list {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 16px;
          }
          .episode-list .ep {
            background: var(--bg3);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 6px 14px;
            font-size: 0.85rem;
            cursor: pointer;
            transition: all 0.2s;
          }
          .episode-list .ep:hover {
            background: var(--accent);
            border-color: var(--accent);
          }
          .episode-list .ep.active {
            background: var(--accent);
            border-color: var(--accent);
          }
          .source-grid {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            margin-bottom: 24px;
          }
          .source-card {
            background: var(--bg2);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 10px 16px;
            display: flex;
            align-items: center;
            gap: 8px;
            color: var(--text);
            font-size: 0.9rem;
            transition: all 0.2s;
          }
          .source-card:hover {
            border-color: var(--accent);
          }
          .source-name {
            font-weight: 600;
          }
          .source-count {
            font-size: 0.75rem;
            color: var(--text2);
          }
          .drama-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
            gap: 16px;
          }
          .drama-card a {
            display: block;
            background: var(--bg2);
            border: 1px solid var(--border);
            border-radius: 10px;
            overflow: hidden;
            color: var(--text);
            transition: all 0.2s;
          }
          .drama-card a:hover {
            border-color: var(--accent);
            transform: translateY(-2px);
            color: var(--text);
          }
          .poster-frame {
            position: relative;
            aspect-ratio: 2/3;
            background: var(--bg3);
            overflow: hidden;
          }
          .poster-frame img {
            width: 100%;
            height: 100%;
            object-fit: cover;
            display: block;
          }
          .poster-placeholder {
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .chip {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            background: var(--bg3);
            border-radius: 999px;
            padding: 3px 8px;
            font-size: 0.72rem;
            border: 1px solid var(--border);
          }
          .poster-badge {
            position: absolute;
            top: 8px;
            left: 8px;
            background: var(--accent);
            color: white;
            border: none;
          }
          .poster-provider {
            position: absolute;
            bottom: 8px;
            left: 8px;
            background: rgba(15, 23, 42, 0.85);
            color: var(--text2);
          }
          .drama-card-body {
            padding: 10px 12px 12px;
          }
          .drama-card-body h3 {
            font-size: 0.88rem;
            font-weight: 600;
            margin-bottom: 8px;
            line-height: 1.25;
            display: -webkit-box;
            -webkit-line-clamp: 2;
            -webkit-box-orient: vertical;
            overflow: hidden;
          }
          .drama-card-body .chip {
            color: var(--accent);
            border-color: var(--border);
          }
          .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: var(--text2);
          }
          .empty-state h2 { font-size: 1.5rem; margin-bottom: 8px; color: var(--text); }
          .hero {
            position: relative;
            display: block;
            border-radius: 14px;
            overflow: hidden;
            border: 1px solid var(--border);
            margin-bottom: 28px;
            min-height: 260px;
            background: var(--bg2);
            color: var(--text);
          }
          .hero-backdrop {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            opacity: 0.45;
          }
          .hero-shade {
            position: absolute;
            inset: 0;
            background: linear-gradient(90deg, rgba(15,23,42,0.95) 20%, rgba(15,23,42,0.55) 55%, rgba(15,23,42,0.15));
          }
          .hero-body {
            position: relative;
            padding: 36px 32px;
            max-width: 640px;
          }
          .hero-body h2 {
            font-size: 1.9rem;
            margin: 12px 0 8px;
            line-height: 1.2;
          }
          .hero-body p { color: var(--text2); margin-bottom: 16px; }
          .hero-kicker { background: var(--accent); color: white; border: none; }
          .hero-cta {
            background: var(--accent);
            color: white;
            border: none;
            padding: 8px 18px;
            font-size: 0.9rem;
          }
          .hero:hover { border-color: var(--accent); color: var(--text); }
          @media (max-width: 768px) {
            .navbar .search-bar { margin-left: 0; width: 100%; }
            .navbar .search-bar input { flex: 1; }
            .grid { grid-template-columns: 1fr; }
          }
        `}</style>
      </head>
      <body>
        <Navbar />
        <div className="container">{children}</div>
        <Footer />
      </body>
    </html>
  )
}

async function Navbar() {
  const sources = await getSources()
  return (
    <nav className="navbar">
      <a href="/" className="brand">🎬 DramaShort</a>
      <div className="nav-links">
        <a href="/">Home</a>
        {sources.map(s => (
          <a key={s.key} href={`/${s.key}`}>{s.label}</a>
        ))}
      </div>
      <SearchForm />
    </nav>
  )
}

function Footer() {
  return (
    <footer style={{ textAlign: 'center', padding: '24px 0 12px', color: '#94a3b8', fontSize: '0.8rem', borderTop: '1px solid #475569', marginTop: 24 }}>
      © 2026 DramaShort · dramashort.fun
    </footer>
  )
}

function SearchForm() {
  return (
    <form className="search-bar" action="/" method="GET">
      <input name="q" placeholder="Cari drama..." defaultValue="" />
      <button type="submit">Cari</button>
    </form>
  )
}
