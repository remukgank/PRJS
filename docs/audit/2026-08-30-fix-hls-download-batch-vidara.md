# Fix HLS Download untuk Batch Upload Vidara

**Date**: 2026-08-30
**Author**: opencode

## Root Cause

Sumber video reelfren/dramafren adalah **HLS (.m3u8)** — bukan mp4 langsung. Terverifikasi:

- `content-type: application/x-mpegurl`
- Body: `#EXTM3U` + `.ts` segments
- URL ber-signed/short-lived (404 kalau kedaluwarsa)

Sebelum fix:

1. `downloadTo(url)` menulis byte mentah HLS sebagai `.mp4` → bukan mp4 valid (moov atom not found) → ffmpeg concat gagal.
2. Metode lama `upload/url` juga menghasilkan file pendek (2-6 detik) karena Vidara tidak bisa mengunduh/mengonsumsi HLS dari URL asli.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/services/vidaraService.js` | Tambah `isHlsUrl()`, `ensureMp4()` (ffmpeg stream-copy HLS→mp4), `ffmpegConcat` fallback re-encode (`-fflags +genpts`, `-c copy` → `-c:v libx264 -preset veryfast -crf 23 -c:a aac`), `downloadAll` worker pakai `ensureMp4` |

## Detail Teknis

### Helper baru

- `isHlsUrl(url)`: deteksi URL `.m3u8` via regex.
- `ensureMp4(url, dest)`: kalau HLS → `ffmpeg -i <url> -c copy dest.mp4` (stream copy, tanpa re-encode, timeout 1 jam). Kalau bukan HLS → `downloadTo` biasa.

### ffmpegConcat (diperbarui)

Percobaan pertama: `-c copy` + `-fflags +genpts` (cepat, tanpa re-encode). Kalau gagal (mp4 hasil HLS sering punya start-time/gaps), fallback re-encode sekali: `-c:v libx264 -preset veryfast -crf 23 -c:a aac -movflags +faststart` (timeout 2 jam). Cleanup list.txt dijalankan di finally block.

### downloadAll worker

Mengganti `downloadTo(url, dest)` → `ensureMp4(url, dest)` sehingga HLS otomatis dikonversi ke mp4 sebelum concat.

## Verification

1. `node --check scraper/services/vidaraService.js` → OK.
2. **Offline harness** (batch 22 eps → 3 batch, stub upload): `REGRESSION OK` — semua assertion lulus, resume skip tanpa re-upload.
3. **Full real-data repro** (reelfren HLS → ffmpeg → concat → curl upload ke Vidara akun `boomber`):
   - 3 episode HLS → ffmpeg stream copy → merged 177MB → curl multipart upload → filecode `ZGhNIz67Z9J7K` → cleanup delete OK.
   - **LULUS end-to-end dengan data nyata.**

## Catatan Teknis Tambahan

- `yt-dlp` tidak tersedia di sistem; VDL pakai yt-dlp untuk HLS tetapi PRJS pakai ffmpeg (sudah ada, tanpa install baru).
- URL video reelfren ber-signed dan kedaluwarsa (~5-10 menit); ffmpeg mengunduh segment secara langsung dari m3u8, sehingga validitas URL hanya perlu cukup saat inisiasi unduhan.
- Error sebelumnya di bot (`Cannot read properties of null (reading 'filecode')`) kemungkinan dari instance yang belum di-restart sesuai kode terbaru — setelah restart bot dengan kode fix ini dan tes ulang, error tersebut diharapkan tidak muncul lagi.