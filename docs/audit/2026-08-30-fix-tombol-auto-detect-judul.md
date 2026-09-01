# Fix Tombol Auto-detect Judul

**Date**: 2026-08-30
**Author**: opencode

## Root Cause

`handlePixeldrainUrl:2085` sudah auto-detect judul via `extractSourcePattern -> findMediaByPattern` (contoh: `kuronime-ymintsgai` -> `Yomi no Tsugai`), tapi prompt tombol `bot.js:3755` (`📥 Pixeldrain Download`) masih pakai `info.name` mentah (`1080p-FkTUf7B-kuronime-ymintsgai02.mp4`). Deteksi terjadi setelah user klik tombol, bukan sebelum render keyboard. Akibat: file ke-2/ke-3 dengan pattern sama tetap tampil mentah di tombol, baru caption setelah download yang benar.

Sama untuk Gofile `bot.js:3743`.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` | `titlePromptKeyboard(fileName, url)` -> `titlePromptKeyboard(fileName, url, detectedTitle)` label `📥 Download: ${detectedTitle || shortName}`; handler prompt `isGofileUrl:3731` + `isPixeldrainUrl:3752` cek `extractSourcePattern -> findMediaByPattern` sebelum kirim keyboard, tampilkan `📌 Terdeteksi: <b>Yomi no Tsugai</b>` + tombol pakai judul terdeteksi |

## Detail Teknis

- Pattern `kuronime-ymintsgai` diekstrak dari `extractSourcePattern` (filter resolusi/hash). Cocok ke `media.source_pattern = kuronime-ymintsgai` (slug `anime:yomi-no-tsugai`).
- Jika `matched` ada, tombol jadi `📥 Download: Yomi no Tsugai` (truncate 32 char). Fallback tetap `shortName` jika tidak ada pattern.

## Verification

- `node --check scraper/bot.js` -> OK
- Skenario fungsional: kirim `https://pixeldrain.com/u/ZXNBocxp` (atau link lain `...kuronime-ymintsgai03.mp4` dengan pattern sama) -> cek tombol tampil `Yomi no Tsugai` (bukan `1080p-...mp4`). Klik -> caption `➧ Judul :- Yomi no Tsugai` + simpan library `anime:yomi-no-tsugai` tetap konsisten.
