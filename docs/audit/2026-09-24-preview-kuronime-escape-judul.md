# Fix preview kuronime: escape judul/episode (anti 400 parse entities)

**Date**: 2026-09-24
**Author**: opencode
**Proposal**: disetujui user ("Ya approve sekalian kamu tangani commit terpisah")

## Root Cause

Preview download kuronime (`bot.js`, jalur `kur_dl`) menyusun caption:

```js
`➧ Judul :- <b>${kurInfo?.title || '?'}</b>\n` +
`➧ Episode :- ${kurInfo?.episode || '?'}\n`
```

lalu mengirimnya dengan `editMessageText(..., { parse_mode: 'HTML' })`. Nilai
judul **tidak di-escape**, padahal `parse_mode: HTML` membuat Telegram
mem-parse entitas. Judul ber-karakter `&`, `<`, atau `>` (mis. "Tom & Jerry
<Film>") memicu `400 Bad Request: can't parse entities`; karena pemanggilnya
`.catch(() => {})`, error ditelan dan preview **macet** di "🔍 Mengambil link
server...". Bug ini dilaporkan (bukan diperbaiki) saat fix movie samehadaku, lalu
disetujui user untuk ditangani sebagai commit terpisah.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` | Baris 3480–3481: `kurInfo?.title` & `kurInfo?.episode` dibungkus `escHtml(...)` (helper sudah ada di file yang sama, dipakai juga preview samehadaku) |
| `scraper/tests/test-caption-html-escape.js` (baru) | 6 test: judul `&`/`<>` ter-escape & isi `<b>` bebas `&`/`<` mentah; judul normal tak over-escape; `kurInfo` null → `?` tanpa crash; episode `"1 <b>x</b>"` ter-escape; anti-drift `escHtml(kurInfo?…` ada di bot.js; preview samehadaku tetap escHtml |

Tidak ada perubahan Worker/API/DB.

## Detail Teknis

- Cross-check docs resmi Bot API 10.3: `editMessageText` menerima
  `parse_mode` (`HTML` valid) → diperlakukan sebagai HTML; `text` 1–4096
  (preview pendek). `sendVideo.caption` 0–1024; caption kuronime dikirim
  sebagai **teks biasa** (`handlers/download.js`, tanpa `parse_mode`) sehingga
  karakter `&` aman di sana — jadi tidak perlu escape ganda.
- `escHtml` (bot.js) menutupi `& < > "` sesuai kebutuhan parse mode HTML.
- Tidak ada regresi: preview samehadaku (fix sebelumnya) tetap memakai
  `escHtml` (dijaga test anti-drift).

## Verification

- `node --check scraper/bot.js` **CLEAN**; `node --check` file lain
  (`gofile-worker.js` ESM, `handlers/download.js`, `db.js`, test) **CLEAN**.
- `test-caption-html-escape.js`: **6 pass, 0 fail**.
- Regresi suite tetap hijau (movie 13, parse-ep1 14, ep1-slug 22, slugtail 28,
  picker 7, libmenu 14, livechat 4, filename 9, anime-router 18, dll).

## Deploy

- Hanya menyentuh `scraper/bot.js` → **restart bot** (tanya dulu / pm2).
- Setelah restart & tes: commit terpisah (sesuai permintaan) lalu push & tag.

## Catatan (di luar scope — menunggu proposal)

- Titik lain di `bot.js` mengirim `parse_mode: 'HTML'` dengan nilai yang belum
  di-escape: `dramaTitle` (1551/1587/1649/1687/2401/2429), `detectedTitle`
  (2775/2808/2837/2873/3720), `fileName`/nama file di dalam `<code>`
  (2775/2808/2837/2873), `dl.part` (2429). Semuanya risking 400 bila berisi
  `&`/`<`. Dilaporkan, belum di-fix — perlu proposal terpisah (saran: escape
  terpusat saat komposisi caption).
