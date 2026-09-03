# Proposal E4c — downloadSamehadakuFile Router ke handlers/download.js

**Date**: 2026-09-03
**Author**: opencode
**Status**: Proposal — belum dieksekusi, menunggu approve

## 1. Fungsi + Test Coverage

| Fungsi | Baris di main | Test scenario |
|--------|---------------|---------------|
| `downloadSamehadakuFile(chatId, episodeUrl, server, servers, sameInfo)` (1310-1328) | Router: `titleArg` = `title + S{season} + P{part}`; `backKb` = tombol `sam_ep`; server gofile→`handleGofileUrl(chatId, url, titleArg)`, pixeldrain→`handlePixeldrainUrl(chatId, url, titleArg)`, filedon→`handleFiledonUrl(chatId, url, titleArg)`; server tak dikenal→ pesan fallback + tombol kembali; resolve gagal→ pesan error + tombol kembali |

Test wajib mencakup **titleArg yang sudah diteruskan ke ketiga callee termasuk Filedon** (bukan cuma GoFile/Pixeldrain seperti sebelum fix 017ae21):
- `sameInfo = {title, season:2}` + server gofile → callee terima `titleArg = "… S2"`
- `sameInfo` + server pixeldrain → callee terima `titleArg`
- `sameInfo` + server filedon → callee terima `titleArg` (perubahan 017ae21)
- `servers[server]` null → pesan "tidak tersedia" + `backKb`
- server tak dikenal → pesan fallback + `backKb`

## 2. Cara Router Memanggil 6 Fungsi yang Sudah Pindah

Semua callee sudah di `scraper/handlers/download.js` (GoFile family dari E4a; Pixeldrain/Filedon/GDrive/UcDrive dari E4b). `bot.js` tinggal wrapper delegasi tipis (`handleGofileUrl` → `_downloadHandlers.handleGofileUrl`, dst).

**Router dipindah ke modul yang sama** (`handlers/download.js`), sehingga pemanggilan callee menjadi **panggilan fungsi lokal dalam modul yang sama** — bukan via `_ctx`, bukan via wrapper `bot.js`:
```js
// handlers/download.js
async function downloadSamehadakuFile(chatId, episodeUrl, server, servers, sameInfo) {
  ...
  if (isGofileUrl(url)) return await handleGofileUrl(chatId, url, titleArg);
  if (isPixeldrainUrl(url)) return await handlePixeldrainUrl(chatId, url, titleArg);
  if (isFiledonUrl(url)) return await handleFiledonUrl(chatId, url, titleArg);
  ...
}
```
Ini menghilangkan satu-satunya alasan wrapper delegasi GoFile/Pixeldrain/Filedon harus tetap ada untuk router — setelah E4c, wrapper di `bot.js` hanya dipakai call site non-router (message handler, `pendingDownloads`, title prompt callbacks).

**Dependensi router yang harus tersedia di modul:**
- `cacheUrl` (untuk `backKb`) — saat ini helper lokal di `bot.js` (slug/url cache, bukan parser). Opsi: pindah ke `lib/` sebagai E4c tambahan, atau teruskan via ctx. Diputuskan saat implementasi, dicatat di log.
- `bot.sendMessage` (3 pesan: tidak tersedia, fallback, error) → via `_ctx.bot` (pola E4a/E4b)
- `isGofileUrl`/`isPixeldrainUrl`/`isFiledonUrl` → import langsung dari modul resolver (stateless, pola E4b)
- `logger` → sudah di modul

## 3. Rollback Plan

- Branch `batch-e4c-router` terpisah dari `main` — 1 commit, merge setelah verifikasi.
- DB tidak disentuh. `bot.js` simpan wrapper delegasi `downloadSamehadakuFile` tipis (pola E4a/E4b) — jika wiring gagal, fallback ke kode lama 1 baris.
- Jika bermasalah: `git checkout main -- scraper/bot.js scraper/handlers/download.js` atau `git revert` 1 commit.

Tunggu approve sebelum mulai E4c.
