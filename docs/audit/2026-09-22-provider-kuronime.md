# Provider Kuronime ala Samehadaku (batch + satuan, caption seragam)

**Date**: 2026-09-22
**Author**: opencode

## Root Cause

Belum ada provider kuronime: URL kuronime.sbs tidak dikenali bot, padahal scraper hanya support gofile/pixeldrain (kuronime punya keduanya di tiap quality, beda dengan samehadaku yang banyak host). Rantai resolve kuronime sudah ditrace: halaman episode → `var _0xa100d42aa` → `POST animeku.org/api/v9/sources` → mirror AES (`3&!Z0M,VIZ;dZW==`) → `download.{v1080p,v720p,...}`.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/providers/kuronime.js` (baru) | is/parse URL, list episode, resolve mirror + AES (node:crypto, tanpa dep baru), pick best (quality v1080p dulu, server gofile→pixeldrain), adapter prescan |
| `scraper/handlers/download.js` | `downloadKuronimeFile` (thin, gofile/pixeldrain, caption seragam via leaf) + export |
| `scraper/lib/samKeyboard.js` | `buildPicker` tambah opsi `prefix` (default `sam`; kuronime pakai `kur`) |
| `scraper/bot.js` | require provider, cache+lock kuronime, picker builder, branch URL, callback `kur_ep/kur_dl/kur_go/kur_all/kur_page/kur_back` |
| `scraper/tests/test-kuronime.js` (baru) | 6 offline + 2 live (guard `KURONIME_LIVE=1`) |

## Detail Teknis

- Caption seragam tanpa edit leaf: `customTitle` = judul anime → cabang generik leaf menghasilkan `➧ Judul / ➧ Episode :- N / ➧ Provider :- kuronime` (part dari nama file, terverifikasi `extractPartFromFilename → 46`, `extractProvider → kuronime`). Library slug `anime:<slug-judul>` identik picker ↔ download.
- Batch `kur_all` = loop sekuensial + `RichProgress` + lock + skip-done + prescan (`scanSupportedServers` + adapter `resolveKuronimeBest`), reuse konstanta SAM_* (pace/window/concurrency). Tanpa chunk/merge (seperti sam).
- Single: URL episode / tombol Ep → server quality terbaik → preview → download; tombol kembali ke list.
- Batasan: passphrase AES bisa rotate (error jelas `Kuronime decrypt gagal`); IP Replit diblokir CF kuronime (resolve hanya jalan dari IP lolos).

## Verification

- `node --check` ke-4 file ubahan: OK
- `test-kuronime.js`: 8/8 pass (termasuk LIVE list + resolve ep46 best=v1080p)
- Regresi: `test-sam-picker-pagination.js` 7 pass, `test-download-sam-batch.js` OK
- pm2 restart: `Bot running` + `Polling started` (cloud mode sementara)
- Functional test (user, admin only): kirim URL anime kuronime → picker Ep → Ep 46 → server → preview → download; kirim URL anime → `Download Semua` → tabel batch jalan per-ep

## Fix desain tabel batch (approved user)

- Judul `📥 Batch ...` → `Batch ...` (renderer `RichProgress.render` sudah prepend 📥; dobel hanya di kur — sam_all punya dobel sama, DILAPORKAN, tidak diubah).
- Semua baris antre langsung diisi detail `server (quality)` dari hasil prescan → format seragam `⏳ Ep N — gofile (v1080p)`; renderer hanya ganti icon (📥/✅/❌).
- Scope: blok `kur_all` di `scraper/bot.js` saja. `node --check` OK, pm2 restart 05:51 polling jalan.

## Hasil tes batch pertama (05:36, cloud mode): ok=0 fail=9

- Bukan bug kode: bot sedang bypass cloud API (limit 50MB), file kuronime 131–223MB → semua ditolak size-check. Download manual via aria2c + curl+auth terbukti jalan (200).
- Fix: balik `TELEGRAM_API_PORT=9091` + restart (boot 05:39 `Local API siap`, limit 2GB). Tes ulang batch oleh user, hands-off (tanpa curl getUpdates manual agar long-poll tidak terganggu).
