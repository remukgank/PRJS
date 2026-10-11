# Fix tombol "Download Semua" mati — host gap (backfill) dihitung (11 Okt 2026)

## Gejala (laporan user)

Picker Super Dragon Ball Heroes:
`🎞 55 episode · 📨 55 di Telegram · ⬜ 0 belum ada · ▓▓▓▓▓▓▓▓▓▓ 100%` —
tombol batch **tidak bisa ditekan** ("di blok gabisa download semua"), padahal
record `vidoy_uploads` hanya **2 baris** (Ep 1–2, `vski.cc`) dan user ingin
backfill **53 episode sisanya ke Vidara**.

## Root cause (terbukti dari kode + data DB)

`buildPicker` (`scraper/lib/samKeyboard.js`) mematikan tombol batch kalau
`missing = eps.length - doneCount <= 0`, dan `done` dihitung dari **status
Telegram saja** (`st.tg`). Untuk SDBH: 55/55 terkirim TG → `missing = 0` →
tombol diganti `btnOff("✅ Semua episode sudah ada")`. Padahal **kerja backfill
host** (upload ke Vidara/Vidoy untuk episode yang belum punya link) masih
sah — guard per-episode (`episodeBatchDone` + pre-check dedupe) sebenarnya
sudah menanganinya dengan benar; yang salah hanya perhitungan tombol picker.
Single per-episode tidak terdampak (tombol episode tidak pernah dimatikan).

Data pembanding (DB live, baca-saja):
`vidoy_uploads` SDBH = 2 baris (Ep 1–2) · `vidara_uploads` = 0 ·
sisa Ep 3–55 hanya punya bukti TG via `media_parts.file_id`.

## Fix

- `scraper/lib/samKeyboard.js` — `buildPicker` menerima param opsional
  `hosted` (Set ep yang **sudah punya link host**). Tombol "Download Semua"
  mati hanya kalau **tidak ada kerja tersisa**: belum terkirim TG **atau**
  belum punya link host. Tanpa `hosted` → perilaku lama identik (back-compat).
- `scraper/bot.js` — ketiga picker (kamenime/samehadaku/kuronime) membangun
  `hosted` dari `st.link || st.vidara` (`episodeStatusMap` sudah membaca
  `vidoy_uploads` + `vidara_uploads`) dan meneruskannya ke `buildPicker`.
- Status caption (`📨 … · ⬜ …`) dan progress bar **tidak berubah** — hanya
  logika ketersediaan tombol batch.

Hasil untuk SDBH: tombol **`⬇️ Download Semua (53)`** (primary) muncul kembali
→ pilihan target `🗜 Vidara` akan backfill Ep 3–55; setelah record host terbentuk
untuk semua episode, tombol kembali mati otomatis (perilaku lama).

## Pengujian (hasil nyata 11 Okt 2026)

- `node --check` `samKeyboard.js` + `bot.js` — OK.
- `.tests/picker-host-gap.js` (baru): **4/4 pass** — unit murni buildPicker
  (done-all + hosted parsial → tombol hidup label (53) · done-all + hosted-all
  → btnOff · tanpa `hosted` → back-compat) + struktural 3 picker.
- Regresi: `test-download-sam-batch` OK · `test-picker-ack` 7/7 ·
  `test-picker-halaman` 222/222 · `test-picker-prefix` 12/12 ·
  `test-sam-picker-pagination` 7/7.

## Catatan

- Belum live — butuh restart bot (owner) bersamaan dengan fitur multi-akun
  Vidara (lihat `2026-10-11-vidara-multi-account.md`).
- Terkait: `test-kamenime-batch` #2 fail **pre-existing** (guard direfaktor
  ke `episodeBatchDone()`; blok `kam_all` identik dengan HEAD — terbukti bukan
  dari perubahan ini).
- fomo-drama: diminta user untuk `git pull`, tapi folder lokal **tanpa `.git`**
  dan remote yang tercatat (`tentangblockchain/fomo-drama`) + `remukgank/fomo-drama`
  tidak ditemukan dengan kredensial yang ada — menunggu info remote/akses user.
