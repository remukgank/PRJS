# PM2 Sementara Bot (install + run lokal WSL)

**Date**: 2026-09-22
**Author**: opencode

## Root Cause

Bukan bug kode, melainkan run sementara di luar Replit. Tiga hambatan install/run lokal:
1. `scraper/package-lock.json` berisi URL `http://package-firewall.replit.local/npm/...` (cache firewall Replit) → `npm install` biasa gagal `ENOTFOUND`.
2. Install pertama salah sasaran ke root (bukan `scraper/`) → `dotenv` hilang → bot exit loop `TELEGRAM_BOT_TOKEN tidak ditemukan`.
3. `scraper/package.json` tidak mencantumkan `megajs` dan `qrcode` (hanya ada di root `package.json`) → `MODULE_NOT_FOUND` saat boot. Di Replit tertutup karena root + scraper sama-sama ter-install (resolusi parent dir).

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/node_modules/` (baru, gitignored) | `npm install --package-lock=false` deps scraper (dotenv, axios, pg, dsb.) |
| `node_modules/` root (baru, gitignored) | `npm install --package-lock=false` deps root (megajs, qrcode, ecc-universal) |
| proses pm2 `prjs-bot` | `pm2 start scraper/bot.js --name prjs-bot` sementara; `pm2 save` TIDAK dijalankan |
| (tidak ada file tracked yang diubah) | `git status` bersih kecuali `.env` untracked bawaan |

## Detail Teknis

- `npm install --replace-registry-host=always` tidak cukup: path lockfile `/npm/<pkg>/...` khas firewall → 404 di registry publik. Solusi tanpa ubah file: `--package-lock=false` (abaikan lockfile, resolve fresh dari `https://registry.npmjs.org/`).
- `bot.js:7` load `.env` root via `__dirname` → jalan dari cwd mana pun; token OK (49 char).
- Boot: FlareSolverr `127.0.0.1:8191` tidak ada → mode non-strict, lanjut request langsung. Local API `9091` → `Local API siap`. Hasil akhir: `Bot running`, `Polling started`.
- Temuan di luar scope (DILAPORKAN, tidak di-fix): `checkDiskSpace` (bot.js:851) hardcode `df ... /home/runner/workspace` → `Unhandled rejection` tiap cek di luar Replit, proses tetap hidup. Kandidat fix: pakai path dinamis/env.

## Verification

- `node --check` `scraper/bot.js`: OK
- `pm2 list`: `prjs-bot` online, restart count stabil (tidak nambah setelah boot sukses)
- `pm2 logs`: `Bot running` + `Polling started, waiting for messages...`
- Test manual (user): kirim `/start` ke bot via Telegram → harus dibalas; observe `pm2 logs prjs-bot`
- Cleanup sementara: `pm2 delete prjs-bot` (belum di-save, reboot = hilang sendiri)

## Follow-up: bot tidak merespon (fix Local API)

- Gejala: proses online + `Polling started` tapi `/start` tak dibalas.
- Trace: `getWebhookInfo` → webhook kosong, `pending_update_count` 65. `getUpdates` via local API → `409 Conflict: terminated by other getUpdates request`; via cloud → OK + 29 update. Hanya 1 proses `bot.js` (pid 2148). Artinya local API lama (pid 161, start 11:07, bukan dari sesi ini) tidak meneruskan update cloud ke bot.
- Fix (approved user): kill pid 161 → start ulang `telegram-bot-api` flags sama (port 9091, dir `/home/hokireceh/telegram-bot-api-data`, log `/tmp/tgapi-9091.log`, pid baru 2652) → `pm2 restart prjs-bot`.
- Verifikasi: boot 04:26 `Local API siap` + `Bot running` + `Polling started`; pending 65 → 31 (bot melahap backlog via local API); poll manual ke local API → 409 = long-poll bot aktif (sehat).
- Catatan: `409` saat curl manual adalah perilaku normal (satu long-poll aktif), bukan error.

## Follow-up: FlareSolverr via Docker

- `.solver/` tidak ada + `nix` tidak tersedia → setup script Replit tidak bisa dipakai. Docker daemon tersedia → pakai image resmi.
- `docker run -d --name flaresolverr -p 8191:8191 flaresolverr/flaresolverr:latest` → v3.5.2, `sessions.list` OK.
- `pm2 restart prjs-bot` → boot 04:44: `FlareSolverr siap` + `Local API siap` + `Bot running` + `Polling started`.
- Cleanup sementara: `docker stop flaresolverr && docker rm flaresolverr` + `pm2 delete prjs-bot`.

## Fix: checkDiskSpace path Replit (approved user)

- `scraper/bot.js:860-872` — `/home/runner/workspace` hardcode → di luar Replit selalu throw tiap 10 menit.
- Fix: kandidat path `['/home/runner/workspace', __dirname, '/tmp', '/']`, pakai yang pertama ada; semua gagal / `df` gagal → `warn` sekali + return null (tidak throw). Perilaku di Replit identik (kandidat pertama ada).
- Scope file: hanya fungsi boot/interval ini. Dua titik `df` lain (bot.js:2347, 3895, cek sebelum download) DILAPORKAN, tidak diubah.
- Verifikasi: `node --check` OK, restart 04:54 → `Bot running` + `Polling started` tanpa `Unhandled rejection`.

## Trace kuronime.sbs dari WSL (Replit gagal buka)

| Langkah | Hasil |
|---|---|
| `GET /anime/dragon-ball-heroes/` | 200, 73KB, 1.4s, judul terbaca, tanpa CF challenge |
| Daftar episode | 18 link `/nonton-dragon-ball-heroes-episode-N/` |
| `GET ...-episode-46/` | 200, 74KB, 0.14s; player iframe `data-src=about:blank` (URL via JS) |
| Mirror statis di HTML | hanya 1: `mp4upload.com/ekapvnhz7mcd` (sisanya via JS/AJAX `mirror-container`, postID 141245) |
| Mirror mp4upload | 200 tapi isi `Not Found` → file mati (bukan blokir IP) |

Kesimpulan: IP WSL lolos Cloudflare kuronime; IP Replit yang diblokir. Sisa mirror butuh emulasi AJAX/JS (FlareSolverr) — belum ditrace.

## Trace mirror kuronime ep46 (gofile/pixeldrain 1080p/720p)

Rantai: hal episode → `var _0xa100d42aa` (base64) → `POST animeku.org/api/v9/sources {"id":...}` → `mirror` (base64 → JSON `{ct,iv,s}` AES-256-CBC, passphrase `3&!Z0M,VIZ;dZW==` dari string-table `pintar.js`, format CryptoJSAesJson) → peta `download.{v360p,v480p,v720p,v1080p}`.

| Quality | gofile | pixeldrain |
|---|---|---|
| v1080p | ✅ `gofile.io/d/fwqKN0` → `1080p-rMH3v5E-kuronime-dbh46.mp4` 212.7MB (resolve via `providers/gofile.js` scraper) | ✅ `pixeldrain.com/u/3uSvgYQr` → `1080p-n2D2bXy-kuronime-dbh46.mp4` 223MB |
| v720p | ✅ `gofile.io/d/4rLVI1` → `720p-xWEDvo6-kuronime-dbh46.mp4` 131.1MB | ❌ null (kosong utk ep ini) |

Catatan: filename pola `kuronime-dbh46` cocok dengan `parser.js` (extractSourcePattern). Mirror lain ep46: filelions/doodstream/mp4upload/krakenfiles.

## Download quality terbaik (v1080p pixeldrain)

- File: `scraper/downloads/1080p-n2D2bXy-kuronime-dbh46.mp4` (folder gitignored)
- 223.083.746 byte dalam 42 dtk (~5,2 MB/s), `code=200`
- SHA256 cocok persis dengan info API pixeldrain (`4033009b…1598`) → file utuh, rantai trace kuronime end-to-end valid dari WSL.
