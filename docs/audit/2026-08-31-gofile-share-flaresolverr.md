# Fix GoFile share langsung via FlareSolverr

**Date**: 2026-08-31
**Author**: opencode

## Root Cause

`scraper/gofile.js:scrapeGofileSharePage` fallback untuk `https://gofile.io/d/qJJMOR6z` mencoba `curl` biasa dulu ke share page. Halaman share GoFile render JS — link `store*.gofile.io/download/...mp4` tidak ada di HTML mentah, hanya muncul setelah `fetch /contents/qJJMOR6z` di browser. `curl` biasa tidak menemukan regex `store.*gofile.io/download` → reject → `GoFile content gagal` (log 07:40:23 `curl -s -L ... https://gofile.io/d/qJJMOR6z`). `api.gofile.io` dari Replit timeout 10s → tidak pernah ke `scrapeGofileSharePage` yang benar.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/gofile.js` | `scrapeGofileSharePage` langsung via FlareSolverr `POST http://127.0.0.1:8191/v1 {cmd:"request.get", url:"https://gofile.io/d/<id>", maxTimeout:45000}` — hapus curl mentah. Regex `store.*gofile.io/download` di `solution.response`. |

## Verification

- `node --check scraper/gofile.js` → OK
- Skenario: kirim `https://gofile.io/d/qJJMOR6z` → `MaxTimeout 45s` FlareSolverr → `store-eu-par-6.../1080p-QMpAN3j-kuronime-ymintsgai19.mp4` (348 MB) tanpa `api.gofile.io` block. `extractSourcePattern` → `kuronime-ymintsgai` → `Yomi no Tsugai` (sudah fix `0nizdxx`).
