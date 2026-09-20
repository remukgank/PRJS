# Audit: ReelFren Metadata Fix + GDrivePlayer Samehadaku + iOS Remux

**Tanggal**: 2026-09-06  
**Commit**: `ddc5d7f`  
**Tag**: `v2.2.0`  
**Status**: LIVE (verified by user)

---

## Summary

Fix 3 masalah sekaligus: ReelFren metadata rusak, GDrivePlayer server tidak terhubung, iOS tidak bisa play video.

---

## Bug A: ReelFren Metadata (poster/synopsis kosong)

### Root Cause
`scrapeWatchPage()` hanya return `{title, totalEpisodes}` tanpa poster/synopsis. Fallback ke iqiyi/streamtape tidak enrich metadata.

### Fix
- `scrapeWatchPage()` sekarang extract poster+synopsis dari HTML/SSR
- `getAllEpisodesReelFren()` enrichment block: kalau poster/synopsis kosong atau title placeholder → scrape drama page langsung (skip repeated API 502s)

### Verification
- Functional test: iqiyi → poster YES + synopsis YES
- Live E2E: moboreels 120 ep, correct title throughout

---

## Bug B: ReelFren Placeholder Title (MoboReels 37637414)

### Root Cause
`getDramaMeta()` return placeholder title "MoboReels 37637414" dari API, bukan real title "Di Sisi Sang Penguasa".

### Fix
- `isReelFrenPlaceholderTitle()` detect placeholder (format: provider + angka)
- `getDramaMeta()` → detect placeholder → fallback ke `scrapeDramaPage()`

### Verification
- Functional test: moboreels → title "Di Sisi Sang Penguasa" + poster YES
- Live E2E Replit: confirmed

---

## Bug C: GDrivePlayer Server Not Wired

### Root Cause
`downloadSamehadakuFile()` di `download.js:834-836` hanya handle gofile/pixeldrain/filedon. GDrivePlayer falls ke "belum didukung" meskipun provider exist di `gdriveplayer.js`.

### Fix
- Import `isGdrivePlayerUrl`, `resolveGdrivePlayerFile`, `GPLAYER_UA`, `GPLAYER_REF`
- Branch baru di `downloadSamehadakuFile()` setelah filedon, sebelum "belum didukung"
- Download via `downloadWithAria2c` + header Referer/UA gdriveplayer + cookies
- Caption sesuai pola samehadaku (Judul / Episode / Provider)
- `sendAnimeMedia` + `upsertMedia`/`savePartFileId` ke library

### Verification
- `test-gdriveplayer-provider.js`: 14/14 pass
- Live E2E: Dragon Ball Heroes ep 1, 2, 8 → download sukses, file terkirim

---

## Bug D: iOS White Screen

### Root Cause
1. `gp.fileName` dari HTML gdriveplayer tanpa ekstensi → `outPath` tidak `.ts` → remux tidak ke-trigger
2. `remuxToMp4()` pakai `-c copy` → gagal silent kalau codec tidak kompatibel → fallback `.ts` asli → iOS tidak bisa play

### Fix
1. Force `.ts` extension: `const gpName = /\.ts$/i.test(gpBase) ? gpBase : \`${gpBase}.ts\``
2. `remuxToMp4()` 2-pass: stream copy dulu, gagal → re-encode h264+aac (`-c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -movflags +faststart`)

### Verification
- Log: `remux: mkv→mp4 done (copy)` → ext: `.mp4` → iOS play OK
- PC: streaming tanpa download dulu

---

## Bug E: Download Lambat (135KiB/80s)

### Root Cause
`resolveGdrivePlayerFile()` tidak capture cookies dari response → server throttle/blokir request tanpa cookie session.

### Fix
- Cookies di-capture dari `res.headers.getSetCookie()` → return sebagai `cookies` field
- Handler pass cookies ke aria2c: `'Cookie': gp.cookies`

### Verification
- Log: 33.2MB download selesai dalam ~18s (sebelum: 135KiB/80s)

---

## Files Changed

| File | Change |
|------|--------|
| `scraper/providers/reelfren.js` | Placeholder detection + enrichment block |
| `scraper/providers/gdriveplayer.js` | Cookie capture dari resolver |
| `scraper/handlers/download.js` | GDrivePlayer branch + remux + cookies |
| `scraper/downloader.js` | remuxToMp4 2-pass (copy → re-encode) |

---

## Test Results

- `test-gdriveplayer-provider.js`: 14/14 pass
- `test-saweria-cf.js`: 19/19 pass (existing)
- Live E2E: Dragon Ball Heroes ep 1, 2, 8 → gdriveplayer → iOS play OK

---

## Rollback

```bash
git revert ddc5d7f
```
