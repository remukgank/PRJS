# PRJS — Scraper + Telegram Bot

Scraper Node.js + Telegram bot untuk download konten dan kirim ke **Telegram** & **Vidara**. Mendukung drama pendek multi-provider, anime, dan file hosting.

## Supported Sources

| Kategori | Provider |
|----------|----------|
| **Reelfren** (34 provider) | `melolo`, `sereal`, `pinedrama`, `shorten`, `happyshort`, `vigloo`, `rapidtv`, `raptdrama`, `cubetv`, `joyreels`, `anyreel`, `minitv`, `bstation`, `golddrama`, `reelife`, `reelshort`, `dramawave`, `dramanova`, `kalostv`, `vibeshort`, `freereels`, `wetv`, `storyreel`, `moviebox`, `movieboxshorts`, `bonustv`, `moboreels`, `netshort`, `mydrama`, `flareflow`, `playlet`, `shortmax`, `flextv`, `dramabox` |
| **Dramafren** | `stardusttv`, `shortmax`, `flickreels`, `dramawave`, `reelshort`, dll |
| **Anime** | `samehadaku` (via `v2.samehadaku.how`, Worker relay) |
| **File hosting** | `gofile.io`, `pixeldrain.com`, `filedon.co`, `mega.nz`, `drive.google.com`, `uc-share.com` |

## Architecture

```
scraper/
├── bot.js                 # Telegram bot (~3700 baris: router, callback, library, VIP, AI)
│   ├── safeHandler wrapper (H1/M4)
│   ├── handleGofileUrl / handlePixeldrainUrl / handleFiledonUrl / handleMegaUrl / handleGdriveUrl
│   └── library, VIP, AI, Vidara integration
├── providers/             # Modul per sumber (Batch F)
│   ├── reelfren.js        # Multi-provider aggregator (api.dramafren.org + probe/fallback kualitas)
│   ├── samehadaku.js      # Anime via Cloudflare Worker relay
│   ├── gofile.js / pixeldrain.js / filedon.js / mega.js / gdrive.js / ucdrive.js
│   └── dramafren.js       # Session rotation & FlareSolverr
├── handlers/              # Handler per domain (ctx injection, tanpa require ../bot)
│   ├── download.js        # GoFile/Pixeldrain/Filedon/Mega/GDrive/UC (Batch E4)
│   ├── vidara.js          # Aksi Vidara + Telegram (Batch E5b)
│   ├── library.js / admin.js
├── lib/                   # Util murni (parser, telegram sender, progress, urlCache, titleDetect)
├── services/
│   ├── vidaraService.js   # Upload ke Vidara (batch, HLS, retry ensureMp4)
│   ├── vipService.js      # VIP membership
│   ├── vipPackages.js     # Pricing
│   └── saweriaService.js  # Donasi Saweria + QR
├── utils/
│   └── rateLimiter.js
├── vidara.js / vidara-uploader.js
├── db.js                  # PostgreSQL (Neon) — media, media_parts, file_cache, dll
├── downloader.js          # aria2c + ffmpeg (download, merge, remux)
└── tests/                 # Smoke & subdomain tests (Batch F)
```

**Data flow:** `Telegram link → parse URL → Worker/API → download (aria2c) → upload Telegram (Local API, 2GB) / Vidara → save library (PostgreSQL)`

## Setup

### 1. Install
```bash
cd scraper && npm install
```

### 2. FlareSolverr (Cloudflare bypass)
```bash
bash scraper/start-flaresolverr.sh   # native, fallback docker restart flaresolverr
# port 8191 → external 3002
```

### 3. Local Bot API Server (opsional, untuk >50MB)
```bash
bash scraper/start-local-api.sh   # port 9091 → external 9000
```

### 4. Environment Variables (28 vars, critical: `TELEGRAM_BOT_TOKEN`, `DATABASE_URL`, `ADMIN_USER_IDS`)

| Variable | Required | Deskripsi |
|----------|----------|-----------|
| `TELEGRAM_BOT_TOKEN` | Yes | Token bot |
| `DATABASE_URL` | Yes | Neon PostgreSQL |
| `ADMIN_USER_IDS` | Yes | ID admin (comma-separated) |
| `TELEGRAM_API_PORT` | No | Local API port (2GB upload) |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | No | Untuk Local API |
| `FLARESOLVERR_URL` | No | Default `http://127.0.0.1:8191` |
| `GOFILE_TOKEN` | No | GoFile account token |
| `GOFILE_WORKER_URL` | No | Cloudflare Worker relay (samehadaku) |
| `RF_GROUP_ID` / `RF_GROUP_ENABLED` | No | Forum topic mirror per provider |
| `VIDARA_DOMAIN` / `VIDARA_API` | No | Vidara upload |
| `SAWERIA_USERNAME` / `SAWERIA_USER_ID` | No | Donasi |
| `AI_CHAT_*` | No | Rate limit AI chat |

Lihat `scraper/bot.js` (env: TOKEN, DATABASE_URL, ADMIN_USER_IDS) untuk daftar lengkap.

### 5. Run
```bash
node scraper/bot.js
# atau via pm2: pm2 start scraper/bot.js --name bot
# atau via Replit workflow: PRJS → Telegram Bot
```

## Usage

### Telegram Bot
| Command | Deskripsi |
|---------|-----------|
| `/start` | Menu utama |
| `/cari <nama>` | Cari di library |
| Kirim link drama/anime | Tampilkan episode + opsi download |
| Kirim link file hosting | Download & kirim file |

**Inline keyboards:** Katalog, Cari, Library parts, VIP, Admin panel, dll. Callback data `act:*`, `lib_menu:*`, `sam_*`, dll.

### Library
- Kategori: Drama (`reelfren_*`, `stardusttv`) vs Anime (`anime:*`)
- Simpan per part/episode ke `media` + `media_parts` (PostgreSQL)

## Development

### Test
```bash
npm test          # smoke test (scraper/tests/test.js)
npm run test:all  # test all subdomains
node --check scraper/bot.js   # syntax check
```

### Audit Log
- Format: `docs/audit/YYYY-MM-DD-judul-singkat.md` (lihat `.opencode/skills/audit-workflow/SKILL.md`)
- Batch flow: **propose → approve → implement → test (`node --check` + functional) → log → restart → commit**

### Batch History (2026-09)
- Batch A: `safeHandler` top-level try/catch (H1/M4)
- Batch B: `findMediaByPattern` case-insensitive (H3)
- Batch C: dedup helper `detectTitleFromFilename` (H2)
- Batch D: README update + cleanup legacy files
