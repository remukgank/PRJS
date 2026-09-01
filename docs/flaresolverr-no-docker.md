# FlareSolverr Tanpa Docker + ReelFren API + StardustTV Fix

Tanggal: 2026-08-19. Konteks: Replit mematikan Docker (`REPLIT_DISABLE_DOCKER=1` di `/run/replit/env/latest`), semua workflow berbasis docker gagal start (termasuk FlareSolverr). Padahal subdomain lama (shortmax, netshort, dll) 100% Cloudflare-protected — tanpa FlareSolverr semuanya mati.

## 1. FlareSolverr 3.5.0 Tanpa Docker

### Kenapa 3.5.0 (bukan 3.3.21 dari pip)
- `pip install flaresolverr` cuma kasih **3.3.21rc4** → gagal solve challenge ("Timeout after 75s").
- Rilis **3.5.0** (2026-05-26) punya **turnstile captcha solver** → "Challenge solved!".
- 3.5.0 cuma ada di GitHub source, bukan PyPI.

### Komponen (semua dari Nix store, path tercatat di `.solver/paths.env`)
| Komponen | Path |
|---|---|
| Chromium | `/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium-browser` |
| Xvfb | `/nix/store/sx3d9r61bi7xpg1vjiyvbay99634i282-xorg-server-21.1.18/bin` |
| glib | `/nix/store/y3nxdc2x8hwivppzgx5hkrhacsh87l21-glib-2.84.3/lib` |
| nss | `/nix/store/2jsrwgic869zynqljiqa4g7dqzpwm2yd-nss-3.101.2/lib` |
| nspr | `/nix/store/gpb87pb8s826aggy1s3f352alp40dkj8-nspr-4.36/lib` |
| libxcb | `/nix/store/2y2hhlki6macaj9j1409q1j6i33l6igf-libxcb-1.17.0/lib` |
| undetected_chromedriver | `~/.local/share/undetected_chromedriver/undetected_chromedriver` (di-download uc sendiri) |

**PENTING**: binary `undetected_chromedriver` butuh 5 lib yang tidak ada di sistem → suplai via `LD_LIBRARY_PATH` (glib, nspr, nss, libxcb). Tanpa ini error `Status code was: 127`.

**PENTING**: `src/package.json` tidak ikut di-copy dari repo → buat manual `{"name":"flaresolverr","version":"3.5.0"}` di `.solver/src/`, kalau tidak crash `FileNotFoundError` saat cek versi.

### Setup (sekali saja)
```bash
bash scripts/setup-flaresolverr.sh
```
Ini: nix build chromium/xvfb/glib/nss/nspr/libxcb + pip (pypi.org, bukan package-firewall Replit yang 403) install deps + undetected-chromedriver ke `.solver/pkg`, tulis `.solver/paths.env`.

### Start
```bash
bash scraper/start-flaresolverr.sh   # dipanggil workflow "FlareSolverr" di .replit
```
- Cek `127.0.0.1:8191` — kalau sudah jalan, exit (tail -f).
- Kalau belum: jalankan `python3 -m flaresolverr` dari `.solver/src` + log ke `.solver/flaresolverr.log`.
- **Catatan**: `nohup ... &` dari script shell Replit bisa mati kalau proses di-kill shell induk — pakai `(setsid ... &)` saat manual.

### Test Cepat
```bash
curl -s -X POST http://127.0.0.1:8191/v1 -H 'Content-Type: application/json' \
  -d '{"cmd":"request.get","url":"https://shortmax.dramafren.org/index.php?page=watch&id=861383&ep=1&sv=1&lang=id","maxTimeout":60000}'
# → status ok, "Challenge solved!", videoUrl di HTML
```

## 2. ReelFren API — Tanpa Cloudflare Sama Sekali

`reelfren.dramafren.org` (Next.js) web-nya kena Cloudflare, TAPI API-nya di host terpisah yang **tidak** kena:

```
https://api.dramafren.org
```

| Endpoint | Fungsi |
|---|---|
| `/api/video?provider=&id=&ep=&lang=&server=&cv=v21` | URL video per episode |
| `/api/detail?provider=&id=&lang=` | **title, cover (poster), intro (sinopsis), episodes, videos[]** |
| `/api/home?lang=id` | katalog ~1241 drama, 22 provider |

Headers: `Accept: application/json`, `Origin: https://reelfren.dramafren.org`, UA Chrome. **Provider diluar daftar ReelFren → `{"error":"Parameter video tidak valid."}`**. Provider API tidak bisa: shortmax, netshort, stardusttv, dll.

Update `scraper/reelfren.js` (commit `9738b95`):
- `getDramaDetail()` — meta via `/api/detail` (API-first, cepat 0.2-1s)
- `getDramaMeta()` — API dulu, FlareSolverr jadi last resort
- `getAllEpisodesReelFren()` — fallback episode list pakai `/api/detail` (bukan watch page)

`discovery/scan-reelfren.js` juga sudah di-rewrite ke API (`/api/home` + `/api/detail` per item) — tidak perlu FlareSolverr.

## 3. StardustTV Format Baru

**Bukan mati** — backend pindah format (2026-08):

- Detail page tetap: `index.php?page=detail&id={id}&slug={slug}&lang={lang}` (96 eps, title bagus)
- Watch page BARU: bukan lagi `hash64`/`availableQualities`/`videoServers`, tapi:
  ```js
  const encryptedSrc = "aHR0cHM6Ly9hY2RuLXYuc3RhcmR1c3QtdHYuY29tL3Byb2Qv..."
  const videoSrc = decodeURIComponent(escape(atob(encryptedSrc)));  // base64 → m3u8
  ```
- CDN video: `https://acdn-v.stardust-tv.com/prod/{dramaId}/{ep}/{hash}.m3u8` — langsung HTTP 200, bisa di-download.
- Subtitle: `index.php?action=proxy_sub&url=...subtitle.stardust-tv.com/...`
- ID lama (15277, 21189, dll) sudah tidak valid → selalu halaman kosong 11339 bytes ("Stardust Player - Watch Free Dramas" tanpa konten). Ambil ID baru dari homepage/detail.
- `scraper/dramafren.js` Strategy 0: regex `const encryptedSrc\s*=\s*"([A-Za-z0-9+/=]+)"` → base64 decode.

## 4. Status Subdomain (2026-08-19, via FlareSolverr 3.5.0)

| Subdomain | Status |
|---|---|
| shortmax | ✅ 13s |
| netshort | ✅ 15s |
| flickreels | ✅ 13s |
| dramabox | ✅ 14s (lang=in) |
| reelshort | ✅ 13s |
| stardusttv | ✅ 13s (ID baru) |
| ReelFren 10 provider | ✅ API langsung (cubetv, happyshort, melolo, kalostv, pinedrama, sereal, reelife, vibeshort, wetv, moviebox) |
| ReelFren 6 provider | ❌ backend down (golddrama, dramanova, joyreels, bstation, storyreel, movieboxshorts) |

## 4b. Shortmax Video Server API (Tanpa FlareSolverr!)

Watch page shortmax mengisi `videoServers` via AJAX (HTML statis kosong → scraper balapan dengan JS → URL sampah/stale → ffmpeg "Invalid data found"). Solusinya: panggil langsung endpoint JSON-nya (TANPA Cloudflare, fresh signed URL tiap request):

```
https://cdn-shortmaxv3.dramafren.org/index.php?action=video_server&server=server1&id={id}&ep={ep}&lang=id
```

Host cadangan: `cdn-shortmax.dramafren.org`. Response: `{ok, server: {available, playUrl, proxyUrl, qualities[]}}` — pakai quality tertinggi dari `qualities`, fallback `playUrl`, lalu `proxyUrl`. API-nya flaky (~1 dari 4 panggilan kosong) → retry 3x.

Diimplementasi di `scraper/index.js` (`getVideoUrlViaApi`) — dipanggil sebelum alur FlareSolverr, hanya untuk subdomain di `VIDEO_SERVER_API_HOSTS`. Hasil: ep resolve 0.1-4s (dulu ~13s), episode yang tadinya gagal sekarang OK.

Subdomain lain (netshort, dll) infrastrukturnya beda — belum dicek.

**FlareSolverr supervisor**: `start-flaresolverr.sh` sekarang pakai loop `while true` — kalau proses crash saat solve paralel, auto-restart 3 detik.

## 5. Pitfall Operasional

- `.solver/` di-gitignore (44MB deps). Kalau workspace di-restart, store path nix masih ada — tinggal `bash scraper/start-flaresolverr.sh`.
- Pip via `--index-url https://pypi.org/simple` — package-firewall Replit (`.local`) kasih 403 untuk beberapa paket.
- `pkill -f flaresolverr` bisa membunuh shell sendiri (pattern match) — pakai `ps aux | grep ... | awk '{print $2}' | xargs kill`.
- Bot sekarang punya mode soft: kalau FlareSolverr mati, tetap lanjut (warn) — set `FLARESOLVERR_REQUIRED=true` untuk strict.
