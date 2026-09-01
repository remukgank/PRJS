# Changelog

## Features
- **2026-06-29**: Add RichProgress class — download progress with rich message table format, progress bar, status icons
- **2026-06-29**: Integrate RichProgress into merge10 download flow — visual table with per-episode status

## Fixes
- **2026-06-29**: Add Strategy 4 — parse `videoServers` JSON from script tags (some subdomains use this pattern)
- **2026-06-29**: Better error handling — show failed episodes when all eps in chunk fail
- **2026-06-29**: Add pino logging to `logs/app.log`
- **2026-06-29**: Rebuild telegram-bot-api binary (8.2 → 10.1) — fix glibc 2.33 vs 2.40 segfault
- **2026-06-29**: Update start-local-api.sh to use local build first
- **2026-06-29**: Fix video URL extraction — decode base64 `hash64` from `availableQualities` (reelshort pattern)
- **2026-06-29**: Remove FlareSolverr session management — sessionless requests more reliable (session causes timeout on CF challenge)
- **2026-06-28**: Fix duplicate `buildWatchUrl` & `buildDetailUrl` in index.js
- **2026-06-28**: Sync 19 subdomains in bot.js (was 11)

## Bugs
- **2026-06-29**: telegram-bot-api binary segfault — rebuilt with current glibc (2.40)
- **2026-06-29**: FlareSolverr session-based requests timeout with "Error solving the challenge" — fixed by removing sessions
- **2026-06-29**: Reelshort video URLs not found in HTML — fixed by decoding base64 hash64
- **2026-06-29**: Silent skip when all episodes in chunk fail — now shows error message
