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
   **File tes taruh di folder `.tests/` repo, JANGAN di `/tmp`** (ke-wipe saat
   restart) supaya bisa dicek ulang kapan saja (`node .tests/<nama>.js`).
5. **LOG** di `docs/audit/YYYY-MM-DD-judul.md` (format di `.opencode/skills/audit-workflow/SKILL.md`).
6. **Deploy → verifikasi → baru commit + push + tag.** Jangan commit sebelum
   deploy terverifikasi jalan normal. Patokan tag ada di §3a.

## 3a. Versi & tag (wajib proporsional)

Format: `v<major>.<minor>.<patch>`. **Tag bukan hiasan** — kalau salah,
riwayat remote jadi kotor dan harus dihapus (terjadi 27 Sep 2026: v4.0.0 untuk
provider baru, ternyata seharusnya v3.2.0, sudah dihapus & diganti).

| jenis perubahan | tag | contoh |
|---|---|---|
| fix bug, teks, dokumentasi, test | **patch** | `3.2.1` — fix `logCtx is not defined` |
| **fitur baru** / provider baru / alur baru, kontrak yang ada **tidak berubah** | **minor** | `3.2.0` — provider kamenime + picker 500 episode |
| menghapus/mengubah kontrak sehingga integrasi lama rusak | **major** | `4.0.0` — hapus `sendPaidMediaVideo`, ubah format callback |

**Penentu utama: apakah ada yang rusak?** Kalau tidak ada konsumen lama yang
harus berubah, itu **minor**, sesederhana quantify fiturnya. Banyaknya commit
bukan penentu — 34 commit tetap boleh jadi satu minor.

"Kontrak" di sini yang tidak boleh patah tanpa major:
- Kontrak media (§5): caption 4 baris, `supports_streaming: true`, topic Anime
- Format `callback_data` dan bentuk `inline_keyboard`
- Nama/parameter yang sudah dipakai pemanggil di luar repo

Teladan dari repo: `v3.0.0 → v3.1.0` (minor) sudah memuat fitur baru
`!dell` + tombol picker berwarna. Gunakan itu sebagai acuan, bukan intuisi sendiri.

## 3. Proses & start bot (Replit)

- **Di Replit: JANGAN pakai pm2** (keputusan user, 2 Okt 2026). Start manual
  **background** — foreground (`exec node scraper/bot.js` langsung) menahan
  turn terminal dan log hanya terlihat di output command itu.
- Resep start resmi (user):
  ```bash
  cd /home/runner/workspace && mkdir -p logs
  setsid bash -lc '
    source /run/replit/env/latest
    exec node scraper/bot.js
  ' > logs/telegram-bot-manual.log 2>&1 < /dev/null &
  sleep 2
  pgrep -f "node scraper/bot.js" | head -1 > logs/telegram-bot-manual.pid
  ```
  Catatan: `$!` = wrapper `setsid` (mati setelah fork) — **PID sejati wajib
  diambil dengan `pgrep`**, bukan `echo $!` (insiden 2 Okt: PID file salah →
  `kill` tidak mematikan bot).
- Sebelum start/stop/restart: (1) **tidak ada** download/upload yang sedang
  jalan, (2) **tidak ada** instance lain (`ps -eo pid,cmd | grep bot.js`).
  Log proses manual = `logs/telegram-bot-manual.log` (**terpisah** dari
  `logs/app.log` yang hanya era pm2).
- Monitor: `tail -n 100 logs/telegram-bot-manual.log` — **JANGAN `tail -f`**
  (tidak pernah selesai → menahan turn). Cek hidup:
  `kill -0 "$(cat logs/telegram-bot-manual.pid)"`.
  Stop: `kill "$(cat logs/telegram-bot-manual.pid)"`.
- **Workflow Run (`.replit` = `node scraper/bot.js`) JANGAN dinyalakan** selama
  proses manual masih hidup → pasti `409 Conflict` (insiden 2 Okt: 3
  instance, 39× polling error). Workflow dinyalakan/dihentikan owner dari UI.
- Hanya boleh **1** instance bot. `409 Conflict: terminated by other getUpdates
  request` = ada instance lain → **matikan salah satu dulu**, jangan tambah
  instance baru sebelum yakin tidak ada yang jalan.
- `9router` (dari `start.sh`), FlareSolverr, dan `telegram-bot-api` local
  (port 9091) = infrastruktur Replit. **Jangan pernah kill.** Proses selain
  `scraper/bot.js` tetap butuh izin.
- **Izin restart `scraper/bot.js` sudah didelegasikan (27 Sep 2026)** asal dua
  syarat di atas terpenuhi. Restart *instance* Replit menyentuh infrastruktur
  → tetap perlu izin.

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

- **Verifikasi di HASIL, bukan di batas yang kamu ubah.** Fakta: menambahkan
  `resolveDirectUrl` untuk gofile/pixeldrain lalu "diverifikasi" hanya dengan
  mengecek fungsi itu mengembalikan URL — padahal file-nya tetap HTML 3 KB dan
  gagal di Vidoy. Aturannya: sebelum menambah/mengubah satu jalur, **baca dulu
  jalur yang sudah jalan dan tiru persis**. Contoh nyata: jalur Telegram sudah
  mengirim `Authorization: Bearer $GOFILE_TOKEN`; jalur Vidoy (`downloadTo`)
  tidak — dan itu akar bug-nya.
- **Unduhan wajib divalidasi sebelum di-upload.** `assertLooksLikeVideo()` di
  `services/vidaraService.js` menolak HTML/JSON/file kecil tanpa signature.
  Provider yang balas HTTP 200 dengan halaman error tidak boleh diteruskan ke
  upload — kalau tanpa ini, errornya muncul sebagai pesan server yang menyesatkan
  (`Vidoy CDN status invalid ... explode(): Passing null`).
- **Signature format lebih otoritatif daripada ukuran.** MP4 sah boleh kecil
  (fragmen/clip); jangan menolak hanya karena kecil kalau `ftyp`/Matroska ada.
- **Klaim dari baca kode BUKAN hasil run.** Aturan ini lahir dari 3 bug berturut
  (27 Sep 2026), semuanya kelalaian yang sama: lebih cepatPacket "sudah benar"
  tanpa menjalankan alurnya.
  - "caption 3 baris" → nyata **1 baris** (judul kosong jatuh ke `cap` mentah).
  - "sudah MP4 jadi tidak perlu remux" → itu yang **mematikan streaming**
    (short-circuit `remuxToMp4` melewatkan `-movflags +faststart`).
  - "kunci library pakai slug" → `media_key` = **judul asli**, jadi status
    "sudah ada" tidak akan pernah cocok.
  → Kalau escreveu "sudah X / aman / tidak berubah", jalankan alurnya sungguhan
  dan laporkan **hasilnya** (angka, output, ukuran file). Kalau tidak bisa
  dijalankan, katakan begitu — jangan menyatakan sebagai fakta.
- **Test yang mengunci asumsi salah lebih berbahaya dari tidak ada test.** Test
  (f) "handleKamenimeUrl tidak boleh remux" terlihat menjaga, tapi justru
  **melarang perbaikannya sendiri**. Kalau test mengunci perilaku, pastikan
  perilakunya benar lebih dulu (jalankan sekali, lihat hasilnya).
- **Penggantian teks (replace) yang gagal TIDAK boleh diam-diam gagal.** Dubb-
  periksa dengan `assert` di script yang memakainya; `assert s != before` hanya
  membuktikan *salah satu* penggantian berhasil, bukan semuanya. Bug nyata:
  `dl_go:tg` tidak dapat cabang kamenime karena replace-nya tidak cocok.

## 5. Kontrak media (tidak boleh dilanggar)

Dikunci oleh `scraper/tests/test-media-contract.js`:

- Setiap video **wajib** dikirim dengan `supports_streaming: true`.
- Setiap video **wajib** dikirim dengan `show_caption_above_media: true`
  (caption tampil di atas media — fitur modern, ditambahkan 2 Okt 2026).
- Format caption: 4 baris **+ `Server` = 5 baris** saat link & host tersedia
  (3 baris kalau tidak ada link sama sekali):
  - drama: `➧ Judul` / `➧ Part/Episode :- 1 (Ep 1–10)` / `➧ Provider` / `➧ Link` / `➧ Server`
  - anime: `➧ Judul` / `➧ Episode :- 5` / `➧ Provider` / `➧ Link` / `➧ Server`
  - label link = domain **asli** URL.
  - `Server :- VIDOY|VIDARA` = host yang **benar-benar memegang file episode
    itu**; hanya tampil bersama Link (upload gagal → tanpa Link & tanpa Server).
  - caption tanpa host (download manual) → tanpa baris Link & Server.
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
- Jangan pernah mencetak nilai kredensial (`FOMO_DRAMA_PAT`, `PRJS_PAT`, token
  bot, dll). Token juga tidak boleh tersimpan di `.git/config` remote.
- **Kredensial GitHub PRJS = `PRJS_PAT`** (environment, bukan `.env`). Pakai itu
  untuk `git push` dan GitHub API — **jangan** mengambil token dari URL remote.
  Remote harus tetap `https://github.com/remukgank/PRJS.git` (tanpa kredensial);
  auth git disuplai credential helper yang membaca `$PRJS_PAT`:
  ```bash
  git config credential.helper \
    '!f() { test -n "$PRJS_PAT" && echo "username=x-access-token" && echo "password=$PRJS_PAT"; }; f'
  ```
  Kalau `gh auth login` sudah dipakai, utamakan `gh`. Verifikasi setelah
  mengganti remote: `git ls-remote --tags origin` (memaaksa auth).
