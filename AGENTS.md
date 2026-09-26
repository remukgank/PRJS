# AGENTS.md — Aturan Kerja PRJS

Dokumen ini berisi aturan yang **wajib** dipatuhi agent yang mengerjakan repo ini.
Semuanya berasal dari kegagalan nyata (lihat `docs/audit/`).

## 1. Scope

- **Tugas agen = PRJS saja.** Repo `fomo-drama/`, `cs-hokireceh/`, dan repo milik
  user lain **tidak boleh** diedit, di-commit, atau di-deploy tanpa perintah
  eksplisit. Boleh membuat proposal di `docs/proposals/` (milik PRJS).
- `fomo-drama/` ada di `.gitignore` → perubahannya tidak terlihat oleh git PRJS.
  Akses hanya baca untuk referensi; pembaruan versinya=user yang pull.
- Jika menemukan isu **di luar scope** proposal: **laporkan dulu**, jangan fix.

## 2. Alur kerja (WAJIB)

1. **Trace dulu** — baca kode, cek DB, cek log. Jangan berasumsi.
   - *"Error yang masuk akal = mungkin bot belum di-restart."* Cek ini dulu
     sebelum mencari penjelasan lain.
   - Jangan berspekulasi soal instance/server lain sebelum verifikasi bukti
     (`/proc/<pid>/cwd`, timestamp, log).
2. **Proposal** — root cause + rencana + scope file → **tunggu user approve**.
3. **Implement** hanya sesuai scope yang disetujui.
4. **Test** — `node --check` semua `.js` yang berubah + jalankan test suite.
   Jangan pakai mock untuk hal yang bisa diuji dengan fungsi asli/DB asli.
5. **LOG** di `docs/audit/YYYY-MM-DD-judul.md` (format di `.opencode/skills/audit-workflow/SKILL.md`).
6. **Deploy → verifikasi → baru commit + push + tag.** Tanya user sebelum
   restart/kill proses. Jangan commit sebelum deploy terverifikasi.

## 3. Proses & pm2

- **Jangan start/stop/kill proses tanpa izin user.** Termasuk `pm2`, `9router`,
  FlareSolverr, dan apa pun yang bukan `scraper/bot.js`.
- `9router` = infrastruktur Replit (dari `start.sh`). **Jangan pernah kill.**
- Hanya boleh **1** instance bot. `409 Conflict: terminated by other getUpdates
  request` = ada instance lain (cek `ps -eo pid,etimes,cmd | grep bot.js`).
  Jangan tambah instance baru sebelum yakin tidak ada yang jalan.
- Start standar: `pm2 start scraper/bot.js --name prjs-bot --cwd /home/runner/workspace --max-memory-restart 700M`
  lalu `pm2 save`.
- Kalau instance Replit restart → daftar pm2 hilang, tapi bot bisa dijalankan
  ulang oleh owner. **Konfirmasi dulu ke user** sebelum menyalakan.
- Log bot yang dijalankan pm2 ada di `~/.pm2/logs/prjs-bot-*.log`.

## 4. Aturan kode (pemicu regresi)

- **Ubah parser? Cek SEMUA pemanggilnya.** Parser `samehadaku` dipakai untuk judul
  sekaligus slug library (`samehadakuAnimeSlug` → `media_parts`). Season di
  judul pernah menggandakan slug (`-s4-s4`) dan merusak deteksi "sudah masuk".
  → regression test slug wajib ada.
- **Callback data: jangan pakai `slice(<angka>)`.** Panjang prefix berbeda
  (`sam_allgo:` = 10 karakter, bukan 11). Pakai parser berbasis string
  (`parseBatchPick`). Slice fixed pernah membuat tombol mati diam-diam.
- **SQL: pastikan SELECT-nya lengkap.** `listVidoyUploads` sempat tidak
  mengambil `tg_chat_id`/`tg_message_id` → episode terkirim ulang ke Telegram.
- **Identifier yang dipakai harus terdefinisi.** `bot.js` meng-import modul
  `db` secara destructuring → `db.listVidoyUploads()` = `ReferenceError`.
  Mulailah dengan `node --check` **dan** cek statis identifier tak terdefinisi.
- **Struktur keyboard Telegram:** `inline_keyboard` = array of **row**, dan row
  = array of **object**. `animeTargetKeyboard()` sudah mengembalikan row →
  pemanggil WAJIB spread (`...animeTargetKeyboard(...)`), bukan `[fn()]`.
  Error: `InlineKeyboardButton must be an Object`.
- **Field `style` (Bot API 10.3)** hanya 3 nilai: `primary` (biru), `success`
  (hijau), `danger` (merah). `link` **tidak ada** → ditolak API. Maks **1
  `primary` per keyboard**; navigasi tidak diberi warna. `disabled: {}` boleh
  digabung dengan `style`.
- **Nilai `style` bukan penanda aksi** — penentu jenis tombol tetap
  `callback_data`/`url`/`web_app`/`disabled`.
- **Domain:** `vidoy.asia` hanya base URL **API upload** (`VIDOY_BASE`,
  configurable). Web publik (`/e/<id>`) diambil dari dashboard dan domainnya
  bisa berubah → jangan pernah mempatok domain di teks link/caption.
- **Caption drama gagal diedit dengan `editMessageText`** → harus
  `editMessageCaption`. `400 message is not modified` = **sukses** (bukan gagal).

## 5. Kontrak media (tidak boleh dilanggar)

Dikunci oleh `scraper/tests/test-media-contract.js`:

- Setiap video **wajib** dikirim dengan `supports_streaming: true`.
- Format caption **tetap** 4 baris:
  - drama: `➧ Judul` / `➧ Part/Episode :- 1 (Ep 1–10)` / `➧ Provider` / `➧ Link`
  - anime: `➧ Judul` / `➧ Episode :- 5` / `➧ Provider` / `➧ Link`
  - label link = domain **asli** URL.
- Caption tidak boleh pernah memuat `undefined`.
- Anime dikirim lewat `sendAnimeMedia` → topic **Anime** (bukan General).

## 6. ATURAN KERAS data (dari user)

- **VIDOY: dilarang keras duplikat.** Satu episode = satu file di Vidoy.
  Record sudah ada → **dilewati**, tidak pernah upload ulang. Tanpa pengecualian.
- **TELEGRAM: boleh kirim ulang.** Duplikat Telegram bukan bug dan tidak perlu
  dicegah.
- Status "sudah ada" di picker = gabungan library (`media_parts`) **∪** Telegram
  (`vidoy_uploads` yang pointer-nya masih tersimpan).
  Label: `✅ N` library · `📨 N` Telegram saja · `Ep N` belum.

## 7. Database

- Tabel: `media`, `media_parts`, `vidoy_uploads`, `vidara_uploads`, `deeplinks`,
  `bot_settings`, `file_cache`, `payments`, `vip_users`, `free_downloads`,
  `livechat_route`.
- Slug library = `anime:<slug>` atau `drama:<…>`; kunci `vidoy_uploads` =
  **judul** (bukan slug slug). Jangan ketukar keduanya.
- Kolom pointer Telegram (`tg_chat_id`/`tg_message_id`) harus ikut di SELECT
  bila dipakai untuk menentukan "sudah terkirim".

## 8. Komunikasi

- **Bahasa Indonesia**, ringkas. Jangan panjang-panjang, jangan mengulang.
- Kalau tidak yakin → tanya, jangan asal kerjakan.
- Sumber kebenaran API = `https://core.telegram.org/bots/api` (terbaru).
- Jangan pernah mencetak nilai kredensial (`FOMO_DRAMA_PAT`, token bot, dll).
  Token juga tidak boleh tersimpan di `.git/config` remote.
