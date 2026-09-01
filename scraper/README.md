# Dramafren Scraper + Telegram Bot

Node.js scraper + Telegram bot untuk mengekstrak dan download video dari **dramafren.org** dan semua subdomain-nya.

## Supported Subdomains

`shortmax`, `flickreels`, `goodshort`, `dramawave`, `dramabox`, `starshort`, `dramapops`, `stardusttv`, `microdrama`, `reelshort`, `flextv`, `dramabite`, `netshort`, `kalostv`, `tvseries`, `moboreels`, `idrama`, `reelfren`, `shortwave`

## Setup

### 1. Install dependencies

```bash
cd scraper
npm install
```

### 2. Start FlareSolverr (Cloudflare bypass)

```bash
docker run -d --name flaresolverr -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest
```

### 3. Start Local Bot API Server (optional, for >50MB upload)

```bash
bash scraper/start-local-api.sh
```

### 4. Set environment variables

```bash
export TELEGRAM_BOT_TOKEN="your-bot-token"
export TELEGRAM_API_PORT=9091        # optional: Local Bot API port
export TELEGRAM_API_ID="your-api-id" # for local API
export TELEGRAM_API_HASH="your-hash" # for local API
```

### 5. Run the bot

```bash
node scraper/bot.js
```

## Usage

### As Module

```js
const { getVideoUrl, getAllEpisodes } = require('./index');

// Get video URL for one episode (auto fallback to sv=2)
const result = await getVideoUrl('goodshort', '31001380498', '', 1, 1, 'id');
// { title, episode, server, videoUrl, subtitleUrl }

// Get all episodes with metadata
const { episodes, meta } = await getAllEpisodes('goodshort', '31001380498', '', 'id');
// episodes: [{ ep: 1, urlEp: 0, url: "..." }, ...]
// meta: { title, synopsis, poster }
```

### Telegram Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Show help |
| Send drama link | Show episodes + download options |
| Send watch link | Scrape video URL directly |

### Test

```bash
npm test          # smoke test
npm run test:all  # test all subdomains
```

## Architecture

```
scraper/
├── bot.js              # Telegram bot (progress tracker, HTML mode)
├── index.js            # Public API (getVideoUrl, getAllEpisodes)
├── downloader.js       # ffmpeg download + merge (iOS compatible)
├── dramafren.js        # FlareSolverr session scraper
├── start-local-api.sh  # Local Bot API Server launcher
├── test.js             # Smoke test
├── test-all-subdomains.js  # Test all subdomains
└── package.json
```

## Key Features

| Feature | Implementation |
|---------|---------------|
| Cloudflare bypass | FlareSolverr Docker (sessionless) |
| Video URL intercept | Multi-strategy: decode base64 hash64, parse `videoServers` JSON, direct URL, video element src |
| iOS compatibility | `-c copy` download, metadata (width/height/duration) via sendVideo |
| Anti-duplicate | Skip download/merge if file already exists |
| Progress tracker | Spinner animation + timer in Telegram |
| Episode parsing | Handle ep=0 (goodshort) and ep=1 (standard) patterns |
| Download location | `~/workspace/downloads/` |

## Speed

| Operation | Time |
|-----------|------|
| Get episodes (non-CF) | ~400ms |
| Get episodes (CF) | ~18s (first), ~1.5s (subsequent) |
| Download episode | ~3-35s (depends on CDN) |
| Merge 10 episodes | ~3-5s |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token |
| `TELEGRAM_API_PORT` | No | Local Bot API port (enables 2GB upload) |
| `TELEGRAM_API_ID` | No | Telegram API ID (for local API) |
| `TELEGRAM_API_HASH` | No | Telegram API hash (for local API) |
| `FLARESOLVERR_URL` | No | FlareSolverr URL (default: http://127.0.0.1:8191) |
| `FFMPEG_PATH` | No | Custom ffmpeg path |
