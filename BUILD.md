# Build Telegram Bot API 10.2

## Prerequisites
- g++ 14.2.1 (via Nix)
- cmake >= 3.10

## Clone & Init

```bash
git clone --recursive https://github.com/tdlib/telegram-bot-api.git
cd ~/workspace/telegram-bot-api
```

## Build

```bash
mkdir build
cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
cmake --build . --target telegram-bot-api -j4
```

## Verify

```bash
cd /home/runner/workspace/telegram-bot-api/build
./telegram-bot-api --version
# Expected: Bot API 10.2
```

## Restart Services

```bash
# Kill old local API
kill $(pgrep -f telegram-bot-api) 2>/dev/null

# Start new local API
source /run/replit/env/latest && \
setsid /home/runner/workspace/telegram-bot-api/build/telegram-bot-api \
  --api-id "$TELEGRAM_API_ID" \
  --api-hash "$TELEGRAM_API_HASH" \
  --http-port "$TELEGRAM_API_PORT" \
  --dir /tmp/tgapi-data \
  --temp-dir /tmp/tgapi-temp \
  --local --verbosity=2 > /dev/null 2>&1

# Restart bot
kill $(pgrep -f "node.*bot.js") 2>/dev/null
source /run/replit/env/latest && \
setsid node /home/runner/workspace/scraper/bot.js > /tmp/bot.log 2>&1
```

## Troubleshooting
- Build mati di ~55% = OOM. **WAJIB** pakai `-j1`.
- Kalau tetap mati: `cmake --build . --target telegram-bot-api -j1 CXXFLAGS="-O1 -g0"`
- Cek progress: `tail -f /tmp/build.log`
