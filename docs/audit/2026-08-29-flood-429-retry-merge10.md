# Fix: Flood 429 retry_after + jeda antar part di merge10

**Date**: 2026-08-29
**Author**: opencode

## Root Cause

Saat batch merge10 mengirim video 165–230 MB ke grup topic secara beruntun tiap ~20–30 detik,
Telegram (Local Bot API `/bot{token}/sendVideo`) mengembalikan `429 Too Many Requests: retry after N`.

Bot TIDAK pernah membaca `retry_after`: `apiPost` (`scraper/bot.js`) langsung `reject(err)` terhadap
error 429, dan jalur cloud (`bot.sendVideo`) juga langsung throw. Akibatnya:

- Part 4 (Ep 31–40): `sendToTopicVideo` gagal 429 (retry after 4) → fallback `sendVideo(chatId,...)`
  juga gagal 429 (retry after 8) → `catch` → video TIDAK terkirim ke mana-mana dan file di-cleanup
  (`finally`, selalu).

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` | `apiPost` retry saat 429 (tunggu `retry_after` lalu ulang, `API_MAX_RETRY`=3) |
| `scraper/bot.js` | `sendVideo` retry saat 429 untuk jalur cloud (`bot.sendVideo`) |
| `scraper/bot.js` | jeda antar part di `actionMerge10` (`PART_SEND_DELAY_MS`=8000 ms default, env override) |

## Detail Teknis

- Helper `sleep(ms)` + `floodRetryMs(err)` — parse `"Too Many Requests: retry after N"` (dari
  `err.message`/`json.description`) → N*1000 ms.
- `apiPost(method, payload, _retry = API_MAX_RETRY)`: saat response non-ok yang bertipe flood dan
  masih ada sisa retry → `await sleep(waitMs + 500)` lalu panggil ulang `apiPost` dengan `_retry - 1`;
  kalau bukan flood atau retry habis → `reject`.
- `sendVideo`: loop lokal s(dengan `attempt < API_MAX_RETRY`) → `sleep(waitMs + 500)` → `continue`.
- `actionMerge10`: setelah `rp.done(sentNote)`, jika bukan part terakhir → `await sleep(PART_SEND_DELAY_MS)`.
- Scope hanya `scraper/bot.js` (file yang aktif di server).

## Verification

- `node --check scraper/bot.js` lulus.
- Skenario functional test di server: jalankan batch merge10 drama >2 part. Harus terlihat di
  `logs/app.log`:
  - log baru `apiPost flood — retry` / `sendVideo flood — retry` (saat 429 muncul) — sebelumnya langsung
    `Part send failed`;
  - log `Jeda antar part` di antara part;
  - tidak ada lagi `Part send failed ... too Many Requests`.
- Catatan: `RichProgress done:9 fail:0` adalah NORMAL (ep pertama chunk berstatus `upload`, bukan
  `done`), bukan indikasi kegagalan.

## Catatan

- Root `bot.js` (duplikat lama, 2405 baris) masih punya `apiPost`/`sendVideo` tanpa retry — dilaporkan,
  tidak diedit karena bukan file deploy.
- Test pertama seri (8 part) sukses tanpa 429. Namun ditemukan bug terpisah saat resend duplikat:
  `sendToProviderTopic` dapat path poster yang sudah dihapus → `invalid file HTTP URL specified: URL host is empty`.

---

# Fix (lanjutan): Poster ke topic dipanggil setelah file dihapus (flow duplikat)

**Konteks**: Setelah fix flood, sesi `dup_yes` (resend drama yang sudah ada) melempar
`400 invalid file HTTP URL specified: URL host is empty` pada mirror poster ke topic grup.

## Root Cause

Di flow `dup_yes` reelfren, poster di-download ke `posterPathDup`, dikirim ke chat, lalu di-cleanup
di `finally { cleanupFiles(posterPathDup) }` (bedanya dengan flow utama yg selalu aman). Setelah itu
`sendToProviderTopic(provider, caption, posterPathDup)` masih dipanggil dengan path file yang SUDAH
dihapus → `bot.sendPhoto` gagal. Flow utama (`handleReelFrenUrl`) aman karena `sendToProviderTopic`
dipanggil SEBELUM cleanup `finally`.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` | flow `dup_yes` reelfren: `sendToProviderTopic` dipindah ke dalam `try` sebelum `finally` cleanup |

## Verification

- `node --check scraper/bot.js` lulus.
- Skenario tes di server: kirim ulang URL drama yang sudah ada di library → klik Lanjutkan →
  mirror poster ke topic harus sukses (tidak ada log `Kirim ke topic grup gagal ... URL host is empty`).

---

# Fix (lanjutan 2): 1 rich message untuk seluruh batch merge10

**Konteks**: User minta hasil merge10 jadi SATU pesan yang di-edit in-place (bukan 8 pesan,
satu per part), tetap rapi dan menampilkan semua part.

## Root Cause

`actionMerge10` membuat `new RichProgress(chatId, partLabel, chunk)` untuk SETIAP part
(`scraper/bot.js:2393`), sehingga 8 part = 8 pesan rich terpisah di chat.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` | `RichProgress` mendukung mode `isParts` (baris ber-label, header tabel dinamis, `notes[]` + `note()`) |
| `scraper/bot.js` | `RichProgress.done()` adaptif (parts → `Total: N part · M episode` + render semua notes) |
| `scraper/bot.js` | `actionMerge10` buat 1 rich message berisi semua part, update per-part in-place, note tiap part terkirim |

## Detail Teknis

- Konstruktor: `new RichProgress(chatId, title, rows, { isParts })`; saat `isParts`, tiap item
  menyimpan `label` dan render baris memakai `label`.
- `updateLabel(label, status, detail, size)` untuk update baris part.
- Notes dipakai untuk "📤 Part N — terkirim ke topic provider di grup"/peringatan part
  dilewati/gagal kirim; dirender di `renderRichMessage`, `render`, dan `done`.
- `handleGofileBatch` & flow per-episode tetap mode episode (tanpa label).
- Render rich message memakai `<br>` eksplisit (bukan `\n`): rich message Telegram
  meng-collapse whitespace HTML, jadi `\n` polos tidak bikin baris baru.

## Verification

- `node --check scraper/bot.js` lulus; require bot.js sukses.
- Render test: mode parts menghasilkan 1 tabel berisi semua part + progress bar + notes.
- Skenario tes di server: jalankan merge10 >1 part → hanya 1 rich message yang muncul dan
  di-edit in-place sampai final ringkasan batch; tidak ada lagi 8 pesan terpisah.

---

# Fix (lanjutan 3): Makeup rich message Progress — tabel rapi, expandable, done() rich, tombol aksi, statistik

**Konteks**: User minta summary rich message (progress & selesai) "lebih keren".
Semua tag/fitur dipakai adalah yang didukung resmi (Bot API 10.1–10.3, cross-check
`InputRichMessage` + Rich HTML Style): `h4`, `details`/`summary`, `table bordered striped
compact` + `caption`, `blockquote`, `hr`, `footer`, `tg-button-row`/`tg-button`.

## Root Cause / Motivasi

- Tabel polos tanpa styling; `\n` tidak bikin baris baru (rich message collapse whitespace).
- `done()` masih `editMessageText` + `parse_mode: HTML` biasa → tidak bisa pakai tabel/footer.
- `e.size > 0` untuk size parts bertipe string (`'82.4 MB'`) bernilai `false` (NaN comparison)
  → kolom Ukuran & total MB tidak pernah tampil.

## Scope Perubahan

| File | Perubahan |
|------|-----------|
| `scraper/bot.js` | `RichProgress.renderRichMessage()` → `<h4>` judul, progress bar, `<details open>` + `<table bordered striped compact>` (bisa dilipat), `<hr/>`, `<footer>`, notes jadi `<blockquote>` |
| `scraper/bot.js` | tambah `RichProgress.renderRichDone()` — summary selesai: `<details>` (collapsed) berisi tabel detail + Ukuran, total `Σ MB`, footer + `<tg-button>📚 Menu Utama</tg-button>` (`act:main_menu`, kirim pesan baru — aman utk rich message) |
| `scraper/bot.js` | `RichProgress.done()` — edit via `editMessageText` raw dengan `rich_message:{html}` (bukan `parse_mode`); helper `_richRequest()`; anti-race tunggu `this.editing` max 2 detik; fallback `sendRichMessage` |
| `scraper/bot.js` | fix `e.size > 0` → `e.size` (truthy) di render live + done agar size string terdeteksi |

## Detail Teknis

- Live progress (isParts & per-episode): `<details open>` → tabel tetap terlihat, user bisa lipat
  manual; `<summary>` ringkas `Part (3✓/9) · 2✗`.
- Selesai: `<details>` tanpa `open` → satu baris `📊 3 part · 30 episode · 96 MB · 3✓`, expand untuk
  tabel `Status | Part | Ukuran`. Notes → `<blockquote>`. Footer: `Total: <unit> · Σ MB ·
  <ok> <n> [· Gagal m] · ⏱ mm:ss`.
- Statistik: `Σ MB` dihitung dari `e.size`/`e.detail` (`/:? (\d+(?:\.\d+)?) MB/`) hanya status `done`.
- Tombol: hanya `act:main_menu` (kirim pesan baru). Hindari `back`/`back_main` karena meng-edit
  rich message in-place (belum tentu didukung) & butuh session yang sudah di-destroy.
- `↔` tag di-close dengan benar; semua bungkus di dalam satu rich message (`html` field).

## Verification

- `node --check scraper/bot.js` lulus.
- Render test (harness menunggu export asinkron via `require.cache`, karena `module.exports`
  di-set di dalam async IIFE): live progress, done parts (ukuran + Σ MB + tombol), done
  per-episode (detail + `—` utk part tanpa ukuran) — semua valid, `RENDER OK`.
- Skenario tes di server (setelah restart bot): jalankan merge10 >1 part → 1 pesan, tabel
  ber-border bisa dilipat; summary akhir ada ukuran total per part + Σ MB + tombol
  "📚 Menu Utama" (ketuk → muncul menu utama).