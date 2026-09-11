# Fix domain reelfren.com tidak dikenali (2026-09-09)

## Insiden
Link `https://reelfren.com/drama/freereels/yFKBSvbyvs-...?lang=id` dari user
ditolak bot ("Link tidak dikenali") — ReelFren pindah/nambah domain baru
`reelfren.com`, regex `parseReelFrenUrl` (reelfren.js) hanya kenal
`reelfren.dramafren.org`.

## Fix (opsi A: reelfren.js + doc ini; bot.js baris pesan dipisah)
- `scraper/providers/reelfren.js:47`: regex
  `(?:reelfren\.dramafren\.org|reelfren\.com)` non-capturing (indeks grup
  tetap) + komentar. API (`api.dramafren.org`) tidak berubah.

## Verifikasi
- `node --check` + ESLint 0; parse unit 3 case (domain baru full-parse,
  domain lama identik, URL acak null) — independen OK.
- Live-path modul asli ke API real dengan URL yang ditolak: request sampai
  (HTTP 503 = sampai), fallback retry→detail→watch berjalan benar. Tanpa
  data karena backend freereels judul tsb down saat itu; kontrol judul
  sehat ikut 503 (outage window API-wide, bukan regresi).
- Bukti final 1-tap (kirim ulang link di grup) di tangan user.
