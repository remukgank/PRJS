# Implementasi 9Router di Replit Ini

9Router adalah AI router/proxy yang nyediain endpoint OpenAI-compatible
(`/v1/chat/completions`, `/v1/models`). Berfungsi sebagai middleware antara
Hermes Agent dan provider AI (Kiro AI).

```
Hermes → 9Router (localhost:20128) → Kiro AI (Claude)
                          ↓
                      fallback → OpenGateway (tencent/hy3)
```

---

## 1. Struktur

```
/home/runner/workspace/9router/
├── .env                       # Config: PORT, JWT_SECRET, INITIAL_PASSWORD
├── next.config.mjs            # Next.js config (output: standalone)
├── custom-server.js           # Wrapper buat extract IP asli dari socket
├── start.sh                   # Docker start script
├── src/                       # Source code
├── .next/                     # Build output (next build --webpack)
├── node_modules/
├── data/db/data.sqlite        # Database SQLite (API keys, providers, routing)
├── package.json
│   scripts: { build, start, dev }
└── ecosystem.config.js        # PM2 config (tapi gak dipake di sini)
```

---

## 2. Cara Jalan

9Router di-start via postBuild (`scripts/hermes-postbuild.sh`):

```bash
cd /home/runner/workspace/9router
PORT=20128 HOSTNAME=0.0.0.0 \
NEXT_PUBLIC_BASE_URL=http://localhost:20128 \
NODE_ENV=production \
nohup node_modules/.bin/next start > 9router.log 2>&1 &
```

- `PORT=20128` di-export langsung **sebelum** start (bukan dari `.env`)
- `nohup` + `&` biar proses tetap jalan setelah postBuild selesai
- Log: `9router.log`
- Cek hidup: `curl -sf http://localhost:20128/v1/models`

### Kenapa gak bisa `node .next/standalone/server.js`

Karena standalone server **tidak** baca `.env`. Harus pake `next start` yang
otomatis load `process.env` dari `.env`, `.env.local`, `.env.production`.

### `.env` file

```env
PORT=20128
JWT_SECRET=hermes-9router-replit-a7b3c9d4e2f1
INITIAL_PASSWORD=hermes123
DATA_DIR=/home/runner/workspace/9router/data
NODE_ENV=production
NEXT_PUBLIC_BASE_URL=http://localhost:20128
```

`PORT` di `.env` cuma kepake kalo start via `next start` (default 3000 kalo
gak ada). Tapi di postBuild, `PORT` di-export langsung biar pasti.

---

## 3. Provider & Routing

### Provider terdaftar

| Provider | Auth | Model Prefix |
|----------|------|-------------|
| `kiro` | OAuth | `kr/` |
| (Kiro AI - Claude Sonnet 4.5, Haiku, DeepSeek, GLM, MiniMax, Qwen) | | |

### Model ID tersedia

Prefix `kr/` cocok dengan provider `kiro`:

- `kr/claude-sonnet-4.5` — Claude Sonnet 4.5 (vision + reasoning)
- `kr/claude-sonnet-4.5-thinking`
- `kr/claude-sonnet-4.5-agentic` — + tools
- `kr/claude-sonnet-4.5-thinking-agentic` — dipake Hermes
- `kr/claude-haiku-4.5`
- `kr/deepseek-3.2`
- `kr/glm-5`
- `kr/minimax-m2.5`
- `kr/qwen3-coder-next`
- `kr/auto` — auto-pick by 9Router

Cek via API:
```bash
curl -s http://localhost:20128/v1/models \
  -H "Authorization: Bearer sk-cd40d61598ebe30a-gvjwdr-911b677d" | jq '.data[].id'
```

---

## 4. API Key

9Router generate API Key otomatis pas pertama kali jalan:

```
sk-cd40d61598ebe30a-gvjwdr-911b677d
```

Disimpan di database:
```sql
sqlite3 data/db/data.sqlite "SELECT key, name, isActive FROM apiKeys;"
```

Key ini dipake Hermes di `config.yaml`:
```yaml
model:
  provider: custom
  base_url: http://localhost:20128/v1
  api_key: sk-cd40d61598ebe30a-gvjwdr-911b677d
```

---

## 5. Web UI

Akses: `http://localhost:20128`

Login: password `hermes123` (dari `INITIAL_PASSWORD` di `.env`)

Fitur UI:
- **Provider Connections** — daftar, tambah, edit provider AI
- **Combo** — routing: API key → provider → model
- **API Keys** — manage API key
- **Usage** — monitor pemakaian
- **Settings** — config global

---

## 6. Database

File: `data/db/data.sqlite`

| Table | Fungsi |
|-------|--------|
| `providerConnections` | Provider AI (auth type, token, status) |
| `apiKeys` | API key untuk client |
| `combos` | Routing key → provider → model |
| `usageHistory` | Log request |
| `usageDaily` | Aggregasi harian |
| `settings` | Config global |
| `kv` | Key-value store |

---

## 7. OAuth Token Kiro AI

9Router handle OAuth login ke Kiro AI. Token disimpan di kolom `data` tabel
`providerConnections`:

```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "expiresAt": "2026-07-14T06:22:04.079Z",
  "expiresIn": 3600,
  "testStatus": "active"
}
```

Token di-refresh otomatis tiap 3600 detik pake refreshToken.

Cek status token:
```bash
python3 -c "
import sqlite3, json
db = sqlite3.connect('/home/runner/workspace/9router/data/db/data.sqlite')
cur = db.cursor()
cur.execute('SELECT data FROM providerConnections WHERE provider=\"kiro\"')
d = json.loads(cur.fetchone()[0])
print(f'Status: {d[\"testStatus\"]}')
print(f'Expires: {d[\"expiresAt\"]}')
"
```

---

## 8. Perintah Penting

```bash
# Build
cd /home/runner/workspace/9router
npm install
npm run build    # next build --webpack

# Start
cd /home/runner/workspace/9router
PORT=20128 npx next start

# Test
curl http://localhost:20128/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-cd40d61598ebe30a-gvjwdr-911b677d" \
  -d '{"model":"kr/claude-sonnet-4.5-thinking-agentic","messages":[{"role":"user","content":"Halo"}]}'

# Cek model
curl -s http://localhost:20128/v1/models \
  -H "Authorization: Bearer sk-cd40d61598ebe30a-gvjwdr-911b677d" | jq .

# Log
tail -f /home/runner/workspace/9router/9router.log

# Akses web UI: http://localhost:20128 (password: hermes123)
```
