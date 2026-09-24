# Judul & tipe Movie untuk halaman film Samehadaku

**Date**: 2026-09-24
**Author**: opencode
**Depends on**: v2.2.2 (dukung halaman film `-episode-movie`)
**Proposal**: disetujui user

## Root Cause

v2.2.2 membuat halaman film **terjangkau** (bot dapat tombol server), tapi metadata
di preview & caption masih kosong:

```
➧ Judul :- ?
➧ Episode :- ?
➧ Provider :- samehadaku
➧ Server :- gofile (FULLHD)
```

Penyebabnya: `bot.js` (jalur `sam_dl` & `sam_go`) memanggil
`parseSamehadakuEpisode(episodeUrl)`. Untuk URL film `/anime/<slug>/` fungsi itu
**null** (tak ada pola `-episode-<ANGKA>`), sehingga `sameInfo` kosong →
judul/episode fallback `'?'`. NamaJudul sebenarnya **ada di halaman** (`<h1
class="entry-title">Assassination Classroom the Movie: Our Time Sub Indo</h1>`)
taplak Worker tidak mengambilnya.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `gofile-worker.js` | Helper baru `decodeEntities` & `extractPageTitle` (sumber: `<h1 entry-title>` → `og:title` → `<title>`; decode entity; buang suffix `" – Samehadaku"`); respons `via:"single"` kini kirim `title` + `movie:true`; respons episode biasa juga kirim `title` |
| `scraper/bot.js` | `sam_dl`: judul preview fallback ke `pageTitle` dari Worker; `via==='single'` → baris `➧ Tipe :- Movie`; judul di-escape `escHtml` (parse_mode HTML). `sam_go`: synthesize `sameInfoG` movie-aware (`{title, movie:true, slug, provider:'samehadaku'}`) dari judul Worker + slug URL, agar caption final & tombol "Kembali ke list episode" benar |
| `scraper/handlers/download.js` | Caption samehadaku: cabang `sami.movie` → `Judul` + `➧ Tipe :- Movie` (tanpa baris Episode) |
| `scraper/tests/test-samehadaku-movie-link.js` | Diperluas 6 → **13 test**: muat helper Worker asli (anti-drift), judul dari `<h1>/<title>` + decode entity, judul null-safe, escape HTML anti-400, caption Movie (tanpa `Episode`/`null`), Season/Episode biasa utuh, worker & bot/handler punya cabang movie |

## Detail Teknis

- **Anti-400 entities (bug yang ditemukan saat implementasi)**: preview dikirim
  `parse_mode:'HTML'`; judul dari halaman bisa memuat `&`/`<` → 400 "can't parse
  entities" & preview macet. Judul kini di-`escHtml` sebelum masuk `<b>`.
  Deteksi came from test case "judul dengan karakter HTML di-escape".
- **API cross-check ke docs resmi Bot API 10.3** (bukan asumsi):
  - `editMessageText` menerima `chat_id`, `message_id`, `text`, `parse_mode`
    (`HTML` valid), `reply_markup`; `text` 1–4096 → preview pendek aman.
  - `sendVideo.caption` 0–1024 + `parse_mode` opsional; caption dipotong
    `slice(0,1024)` di `telegram.js` → judul panjang aman.
  - Tak ada method/parameter Telegram baru; perubahan murni lokal + payload Worker.
- Preview film yang dihasilkan (simulasi HTML asli):
  `Judul :- Assassination Classroom the Movie: Our Time Sub Indo` / `Tipe :- Movie`.
- Worker menyertakan `movie:true` hanya di jalur `via:"single"`; episode biasa
  `title` tanpa flag → PRJS tak salah label "Movie" untuk episode biasa.

## Verification

- `node --check` **CLEAN** untuk `gofile-worker.js` (ESM via `.mjs`), `scraper/bot.js`,
  `scraper/handlers/download.js`.
- `test-samehadaku-movie-link.js`: **13 pass, 0 fail**.
- Regresi 14 suite: parse-ep1 14, ep1-slug 22, slugtail 28, picker 7, libmenu 14,
  livechat 4, filename 9, anime-router 18, gdriveplayer 3, prescan, batch, kuronime,
  extract-provider — semua hijau.
- Simulasi end-to-end helper Worker asli + HTML film asli: link OK, judul outer
  benar, quality FULLHD, gofile+pixeldrain, preview final benar.

## Deploy (urutan wajib)

1. **Worker**: paste ulang `gofile-worker.js` ke dashboard Cloudflare (user).
   Verifikasi: `curl /samehadaku?url=<link film>` → `title` terisi & `movie:true`.
2. **Restart bot** (`bot.js` berubah) — pm2/teminal, tanya dulu.
3. Commit + push + tag `v2.2.3` setelah terverifikasi.

## Catatan (di luar scope — untuk keputusan berikutnya)

- Preview **kuronime** (`bot.js:3479`) punya kelas bug sama: `kurInfo.title` mentah
  di dalam `<b>` dengan `parse_mode:'HTML'` → judul ber-`&`/`<` bisa 400. Dilaporkan,
  belum di-fix (di luar scope proposal ini).
